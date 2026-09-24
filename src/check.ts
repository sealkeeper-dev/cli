// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// GET /v1/check/:login/:name, shared by `vouched check` and the Mastra
// adapter's check and assertTrusted. A plain public GET. No key, no config
// and no registration needed.
import {
  AgentName,
  CheckQuery,
  GithubLogin,
  type Level,
} from '@vouched-dev/schema';
import { ApiError, resolveApiUrl } from './api.js';
import {
  AgentRenamedResponse,
  type Check,
  CheckResponse,
  ErrorResponse,
} from './responses.js';

const REQUEST_TIMEOUT_MS = 30_000;

// Every value optional. The API defaults minVerified to 1 and maxIncidents
// to 0. minReliability, minSafety and minLevel are checked only when given.
export type CheckThresholds = {
  minVerified?: number | undefined;
  maxIncidents?: number | undefined;
  minReliability?: number | undefined;
  minSafety?: number | undefined;
  minLevel?: Level | undefined;
};

export type CheckOptions = {
  // Defaults to VOUCHED_API_URL, then https://api.vouched.run.
  apiUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
};

// Splits login/name and checks both parts. Throws an ApiError with code
// invalid_handle, before anything is sent.
export function parseHandle(handle: string): { login: string; name: string } {
  const [login, name, ...rest] = handle.split('/');
  if (
    rest.length > 0 ||
    !GithubLogin.safeParse(login).success ||
    !AgentName.safeParse(name).success
  ) {
    throw new ApiError(
      0,
      'invalid_handle',
      `invalid handle ${handle}, use <github login>/<agent name>, as in carelmeyer/claude-code`,
    );
  }
  return { login: login as string, name: name as string };
}

// The query string for the thresholds that are set. Each value goes through
// CheckQuery, the same schema the API uses, so a bad one fails here with
// code invalid_threshold instead of reaching the network. The CLI passes
// its flags as the text that was typed, so an empty flag is refused rather
// than read as 0.
export type RawThresholds = {
  [K in keyof CheckThresholds]?: string | undefined;
};

export function checkSearch(
  thresholds: CheckThresholds | RawThresholds,
): string {
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
// the handle the agent has now.
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
  const fetchFn = options.fetch ?? fetch;
  const url = `${apiUrl}/v1/check/${encodeURIComponent(login)}/${encodeURIComponent(name)}${search}`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiError(
      0,
      'network_error',
      `could not reach the Vouched API at ${apiUrl}: ${(error as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }

  if (res.status === 200) {
    const parsed = CheckResponse.safeParse(json);
    if (parsed.success) return parsed.data;
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
    `the Vouched API returned an unexpected response (HTTP ${res.status})`,
  );
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
    default:
      // A check added to the API after this version.
      return `${status} ${check.name} ${actual}, required ${check.required}`;
  }
}
