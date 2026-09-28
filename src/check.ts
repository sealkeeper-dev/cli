// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// GET /v1/check/:slug/:name, shared by `sealkeeper check` and the Mastra
// adapter's check and assertTrusted. A plain public GET. No key, no config
// and no registration needed.
import {
  AgentName,
  CheckQuery,
  type Level,
  OperatorSlug,
} from '@sealkeeper/schema';
import { ApiError, apiErrorOf, createApiClient, resolveApiUrl } from './api.js';
import { paths } from './config.js';
import {
  AgentRenamedResponse,
  type Check,
  CheckResponse,
  type SealWithheld,
  sealWithheldOf,
  type WellKnown,
  withheldText,
} from './responses.js';
import { checkSeal, loadKeys, sealIssuer, sealKid } from './seal.js';

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

// Splits slug/name and checks both parts. The slug is lowercased first, as
// the API does, so a handle written with a login in capitals still works.
// Throws an ApiError with code invalid_handle, before anything is sent.
function parseHandle(handle: string): { slug: string; name: string } {
  const [first, name, ...rest] = handle.split('/');
  const slug = first?.toLowerCase();
  if (
    rest.length > 0 ||
    !OperatorSlug.safeParse(slug).success ||
    !AgentName.safeParse(name).success
  ) {
    throw new ApiError(
      0,
      'invalid_handle',
      `invalid handle ${handle}, use <operator>/<agent name>, as in alice/claude-code`,
    );
  }
  return { slug: slug as string, name: name as string };
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
  const { slug, name } = parseHandle(handle);
  const search = checkSearch(thresholds);
  const fetchFn = options.fetch ?? fetch;
  const api = createApiClient({
    apiUrl: options.apiUrl?.trim() || resolveApiUrl({}),
    fetch: fetchFn,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  // A redirect is never followed. It ends the check with the new address.
  const { status, json, headers } = await api.request(
    `/v1/check/${encodeURIComponent(slug)}/${encodeURIComponent(name)}${search}`,
  );

  if (status === 200) {
    const parsed = CheckResponse.safeParse(json);
    if (parsed.success) {
      await trustedPass(parsed.data, `${slug}/${name}`, api.apiUrl, fetchFn);
      return parsed.data;
    }
  }
  const renamed = AgentRenamedResponse.safeParse(json);
  if (status === 404 && renamed.success) {
    throw new ApiError(
      404,
      'renamed',
      `${slug}/${name} is now ${renamed.data.handle}`,
    );
  }
  const error = apiErrorOf(status, json, headers);
  if (error.code === 'not_found') {
    throw new ApiError(
      error.status,
      error.code,
      `no agent ${slug}/${name}`,
      error.issues,
      error.retryAfterSec,
    );
  }
  throw error;
}

// Why the SEAL is withheld, for a check answer with a failing seal check.
// The check answer says withheld and not why, and the SEAL route by handle
// carries the reason class or the dormant days (VOU-85). null when that
// route answers anything else or cannot be reached, so the check still
// prints, only without the reason.
export async function fetchWithheld(
  handle: string,
  options: CheckOptions = {},
): Promise<SealWithheld | null> {
  try {
    const { slug, name } = parseHandle(handle);
    const api = createApiClient({
      apiUrl: options.apiUrl?.trim() || resolveApiUrl({}),
      fetch: options.fetch ?? fetch,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    const { status, json } = await api.request(
      `/v1/agents/${encodeURIComponent(slug)}/${encodeURIComponent(name)}/seal`,
    );
    return status === 404 ? sealWithheldOf(json) : null;
  } catch {
    return null;
  }
}

// Whether an answer carries the failing seal check of a withheld SEAL.
export const sealIsWithheld = (result: CheckResponse): boolean =>
  result.checks.some((c) => c.name === 'seal' && c.actual === 'withheld');

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
      iss: sealIssuer(jws),
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
// version does not know is named as the API sent it. withheld says why a
// withheld SEAL is withheld, from fetchWithheld. Without it the seal line
// says withheld and no more.
export function describeCheck(
  check: Check,
  withheld: SealWithheld | null = null,
): string {
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
        ? `${status} no SEAL, ${withheld === null ? 'withheld' : withheldText(withheld)}, need a current SEAL`
        : `${status} SEAL ${actual}, need ${check.required}`;
    default:
      // A check added to the API after this version.
      return `${status} ${check.name} ${actual}, required ${check.required}`;
  }
}
