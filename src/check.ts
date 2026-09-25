// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// GET /v1/check/:login/:name, shared by `sealkeeper check` and the Mastra
// adapter's check and assertTrusted. A plain public GET. No key, no config
// and no registration needed.
import {
  AgentName,
  CheckQuery,
  GithubLogin,
  type Level,
} from '@sealkeeper/schema';
import { ApiError, redirectError, resolveApiUrl } from './api.js';
import { INSECURE_API_URL, isSecureApiUrl, paths } from './config.js';
import {
  AgentRenamedResponse,
  type Check,
  CheckResponse,
  ErrorResponse,
  type WellKnown,
} from './responses.js';
import { checkSeal, loadKeys, sealKid } from './seal.js';

const REQUEST_TIMEOUT_MS = 30_000;

// Every value optional. The API defaults minVerified to 1, maxIncidents
// to 0 and minLevel to bronze. minLevel none asks for no level.
// minReliability and minSafety are checked only when given.
export type CheckThresholds = {
  minVerified?: number | undefined;
  maxIncidents?: number | undefined;
  minReliability?: number | undefined;
  minSafety?: number | undefined;
  minLevel?: Level | undefined;
};

export type CheckOptions = {
  // Defaults to SEALKEEPER_API_URL, then https://api.sealkeeper.run.
  apiUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
};

// Splits login/name and checks both parts. Throws an ApiError with code
// invalid_handle, before anything is sent.
function parseHandle(handle: string): { login: string; name: string } {
  const [login, name, ...rest] = handle.split('/');
  if (
    rest.length > 0 ||
    !GithubLogin.safeParse(login).success ||
    !AgentName.safeParse(name).success
  ) {
    throw new ApiError(
      0,
      'invalid_handle',
      `invalid handle ${handle}, use <github login>/<agent name>, as in alice/claude-code`,
    );
  }
  return { login: login as string, name: name as string };
}

// The query string for the thresholds that are set. Each value goes through
// CheckQuery, the same schema the API uses, so a bad one fails here with
// code invalid_threshold instead of reaching the network. The CLI passes
// its flags as the text that was typed, so an empty flag is refused rather
// than read as 0.
type RawThresholds = {
  [K in keyof CheckThresholds]?: string | undefined;
};

function checkSearch(thresholds: CheckThresholds | RawThresholds): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(thresholds)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const parsed = CheckQuery.safeParse(Object.fromEntries(search));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue?.path[0] ?? 'threshold');
    throw new ApiError(
      0,
      'invalid_threshold',
      `invalid ${key} ${search.get(key) ?? ''}, ${issue?.message ?? 'not a valid value'}`,
    );
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// Fetches the check and parses the answer. Throws ApiError for anything but
// a 200 that parses. A renamed handle is code renamed with a message naming
// the handle the agent has now. A passing answer is trusted only once its
// SEAL is checked, see trustedPass.
export async function fetchCheck(
  handle: string,
  thresholds: CheckThresholds | RawThresholds = {},
  options: CheckOptions = {},
): Promise<CheckResponse> {
  const { login, name } = parseHandle(handle);
  const search = checkSearch(thresholds);
  const apiUrl = (options.apiUrl?.trim() || resolveApiUrl({})).replace(
    /\/+$/,
    '',
  );
  if (!isSecureApiUrl(apiUrl)) {
    throw new ApiError(
      0,
      'insecure_api_url',
      `refusing the SealKeeper API at ${apiUrl}, ${INSECURE_API_URL}`,
    );
  }
  const fetchFn = options.fetch ?? fetch;
  const url = `${apiUrl}/v1/check/${encodeURIComponent(login)}/${encodeURIComponent(name)}${search}`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      // Never followed. A redirect ends the check with the new address.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiError(
      0,
      'network_error',
      `could not reach the SealKeeper API at ${apiUrl}: ${(error as Error).message}`,
    );
  }
  if (res.status >= 300 && res.status < 400) {
    throw redirectError(apiUrl, url.slice(apiUrl.length), res);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }

  if (res.status === 200) {
    const parsed = CheckResponse.safeParse(json);
    if (parsed.success) {
      await trustedPass(parsed.data, `${login}/${name}`, apiUrl, fetchFn);
      return parsed.data;
    }
  }
  const renamed = AgentRenamedResponse.safeParse(json);
  if (res.status === 404 && renamed.success) {
    throw new ApiError(
      404,
      'renamed',
      `${login}/${name} is now ${renamed.data.handle}`,
    );
  }
  const error = ErrorResponse.safeParse(json);
  if (error.success) {
    const { code, message } = error.data.error;
    throw new ApiError(
      res.status,
      code,
      code === 'not_found' ? `no agent ${login}/${name}` : message,
      error.data.error.issues,
    );
  }
  throw new ApiError(
    res.status,
    'bad_response',
    `the SealKeeper API returned an unexpected response (HTTP ${res.status})`,
  );
}

// A pass that callers act on, as assertTrusted does, needs more than the
// API's ok. The answer must be about the handle asked for, and its SEAL
// must verify against the SealKeeper keys, be current and name that agent.
// Throws ApiError with code seal_invalid when any of that fails. A failing
// answer needs no proof and is returned as it is.
async function trustedPass(
  result: CheckResponse,
  handle: string,
  apiUrl: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const invalid = (why: string) =>
    new ApiError(0, 'seal_invalid', `not trusting ${handle}, ${why}`);
  if (result.handle.toLowerCase() !== handle.toLowerCase()) {
    throw invalid(`the API answered for ${result.handle}`);
  }
  if (!result.ok) return;
  const jws = result.seal ?? '';
  const nowMs = Date.now();
  let keys: WellKnown;
  try {
    keys = await loadKeys({
      apiUrl,
      fetch: fetchFn,
      paths: paths(),
      nowMs,
      kid: sealKid(jws) ?? '',
    });
  } catch (error) {
    throw invalid((error as Error).message);
  }
  const seal = await checkSeal(jws, keys, nowMs);
  if (!seal.valid) throw invalid(`its SEAL is ${seal.reason}`);
  if ((seal.payload as { sub?: unknown }).sub !== result.id) {
    throw invalid('its SEAL names another agent');
  }
}

// One line per check, in plain words. "ok" or "FAIL" first. A check this
// version does not know is named as the API sent it.
export function describeCheck(check: Check): string {
  const status = check.ok ? 'ok  ' : 'FAIL';
  const actual = check.actual === null ? 'none yet' : String(check.actual);
  switch (check.name) {
    case 'minVerified':
      return `${status} verified tasks ${actual}, need at least ${check.required}`;
    case 'maxIncidents':
      return `${status} incidents ${actual}, allow at most ${check.required}`;
    case 'minReliability':
      return `${status} reliability ${actual}, need at least ${check.required}`;
    case 'minSafety':
      return `${status} safety ${actual}, need at least ${check.required}`;
    case 'minLevel':
      return `${status} level ${actual}, need at least ${check.required}`;
    case 'seal':
      return check.actual === 'withheld'
        ? `${status} no SEAL, withheld while the agent is dormant, need a current SEAL`
        : `${status} SEAL ${actual}, need ${check.required}`;
    default:
      // A check added to the API after this version.
      return `${status} ${check.name} ${actual}, required ${check.required}`;
  }
}
