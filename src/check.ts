// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// GET /v1/check/:slug/:name, shared by `sealkeeper check` and the Mastra
// adapter's check and assertTrusted. A plain public GET. No key, no config
// and no registration needed.
import {
  AgentName,
  CHECK_DEFAULT_MIN_VERIFIED_SERVICE,
  CheckQuery,
  HandleAlias,
  HandleDomain,
  LEVEL_RANK,
  type Level,
  OperatorSlug,
  type SealPayload,
  SealSubjectKind,
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
import {
  checkSeal,
  decodeSealPayload,
  kindName,
  levelWithKind,
  loadKeys,
  sealIssuer,
  sealKid,
  sealKind,
} from './seal.js';

// Every value optional. A value left out takes the API's default, except
// minVerified for kind service, which defaults to 0 since a service does no
// tasks. minLevel none asks for no level. kind is the kind of SEAL minLevel passes, agent unless
// given. A SEAL of another kind fails minLevel whatever its level, since the
// levels of one kind are never compared with another's.
export type CheckThresholds = {
  minVerified?: number | undefined;
  maxIncidents?: number | undefined;
  minReliability?: number | undefined;
  minSafety?: number | undefined;
  minLevel?: Level | undefined;
  kind?: SealSubjectKind | undefined;
};

const DEFAULT_KIND = 'agent' satisfies SealSubjectKind;

export type CheckOptions = {
  // Defaults to SEALKEEPER_API_URL, then https://api.sealkeeper.run.
  apiUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
};

// Splits first/name and checks both parts. The first segment is an operator
// slug or a listed agent's domain key, lowercased first, so a handle written in
// capitals still works. Throws an ApiError with code invalid_handle before
// anything is sent.
export function parseHandle(handle: string): { slug: string; name: string } {
  const [first, name, ...rest] = handle.split('/');
  const slug = first?.toLowerCase();
  if (
    rest.length > 0 ||
    !(
      OperatorSlug.safeParse(slug).success ||
      HandleDomain.safeParse(slug).success ||
      HandleAlias.safeParse(slug).success
    ) ||
    !AgentName.safeParse(name).success
  ) {
    throw new ApiError(
      0,
      'invalid_handle',
      `invalid handle ${handle}, use <operator>/<agent name>, as in alice/claude-code, or <domain>/<agent name> for a listed agent`,
    );
  }
  return { slug: slug as string, name: name as string };
}

// The query string for the thresholds that are set, the thresholds with
// defaults filled in, and the kind asked for. For kind service a minVerified
// left out is sent as 0, so the API and the SEAL check both read it. Each value goes through
// CheckQuery, and the kind through SealSubjectKind, so a bad one fails here
// with code invalid_threshold instead of reaching the network. The kind is
// never sent, it is checked against the SEAL. The CLI passes its flags as
// the text that was typed, so an empty flag is refused rather than read as 0.
type RawThresholds = {
  [K in keyof CheckThresholds]?: string | undefined;
};

function checkSearch(thresholds: CheckThresholds | RawThresholds): {
  search: string;
  query: CheckQuery;
  kind: SealSubjectKind;
} {
  const { kind: rawKind, ...rest } = thresholds;
  const kind = SealSubjectKind.safeParse(rawKind ?? DEFAULT_KIND);
  if (!kind.success) {
    throw new ApiError(
      0,
      'invalid_threshold',
      `invalid kind ${rawKind ?? ''}, one of ${SealSubjectKind.options.join(', ')}`,
    );
  }
  const values =
    kind.data === 'service' && rest.minVerified === undefined
      ? { ...rest, minVerified: CHECK_DEFAULT_MIN_VERIFIED_SERVICE }
      : rest;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
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
  return {
    search: text ? `?${text}` : '',
    query: parsed.data,
    kind: kind.data,
  };
}

// Fetches the check and parses the answer. Throws ApiError for anything but
// a 200 that parses. A renamed handle is code renamed with a message naming
// the handle the agent has now. A passing answer is trusted only once its
// SEAL is checked, see trustedPass, and minLevel passes only for a SEAL of
// the kind asked for, see withKind.
export async function fetchCheck(
  handle: string,
  thresholds: CheckThresholds | RawThresholds = {},
  options: CheckOptions = {},
): Promise<CheckResponse> {
  const { slug, name } = parseHandle(handle);
  const { search, query, kind } = checkSearch(thresholds);
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
      const verified = await trustedPass(
        parsed.data,
        `${slug}/${name}`,
        query,
        kind,
        api.apiUrl,
        fetchFn,
      );
      return withKind(parsed.data, kind, verified);
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

// Why the SEAL is withheld, for a check answer with a failing seal check. It
// reads the SEAL route by handle, which carries the reason class or the dormant
// days. null when that route answers anything else or cannot be reached, so the
// check still prints, only without the reason.
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

// The checks a verified SEAL can answer for itself. minVerified reads
// counts.verified_tasks, maxIncidents counts.safety_incidents_90d and minLevel
// the level by rank, read once the SEAL is known to be of the kind asked for.
// One line per check that fails, empty when all three pass.
export function sealChecksFailing(
  payload: SealPayload,
  query: CheckQuery,
): string[] {
  const failing: string[] = [];
  const verified = payload.counts.verified_tasks;
  if (verified < query.minVerified) {
    failing.push(
      `its SEAL has ${verified} verified tasks, the check needs ${query.minVerified}`,
    );
  }
  const incidents = payload.counts.safety_incidents_90d;
  if (incidents > query.maxIncidents) {
    failing.push(
      `its SEAL has ${incidents} incidents in 90 days, the check allows ${query.maxIncidents}`,
    );
  }
  if (LEVEL_RANK[payload.level] < LEVEL_RANK[query.minLevel]) {
    const kind = kindName(sealKind(payload));
    failing.push(
      `its SEAL is ${levelWithKind(payload.level, kind)}, the check needs at least ${levelWithKind(query.minLevel, kind)}`,
    );
  }
  return failing;
}

// A pass that callers act on, as assertTrusted does, needs more than the
// answer's ok. The answer must be about the handle asked for, and its SEAL must
// verify against the SealKeeper keys, be current and name the agent the answer
// found for that handle. Then minVerified, maxIncidents and minLevel are worked
// out again from the verified SEAL, when it is of the kind asked for. One of
// another kind fails minLevel in withKind instead. The handle to id mapping
// cannot be checked offline, so it is taken from the API this CLI points at.
// minReliability and minSafety are read from the answer. Throws ApiError with
// code seal_invalid when any of that fails. Resolves with the verified
// payload, or null for a failing answer, which is never verified.
async function trustedPass(
  result: CheckResponse,
  handle: string,
  query: CheckQuery,
  kind: SealSubjectKind,
  apiUrl: string,
  fetchFn: typeof fetch,
): Promise<SealPayload | null> {
  const invalid = (why: string) =>
    new ApiError(0, 'seal_invalid', `not trusting ${handle}, ${why}`);
  if (result.handle.toLowerCase() !== handle.toLowerCase()) {
    throw invalid(`the API answered for ${result.handle}`);
  }
  if (!result.ok) return null;
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
  const seal = await checkSeal(jws, keys, nowMs, result.id);
  if (!seal.valid) {
    throw invalid(
      seal.reason === 'wrong agent'
        ? 'its SEAL names another agent'
        : `its SEAL is ${seal.reason}`,
    );
  }
  const payload = seal.payload as SealPayload;
  if (sealKind(payload) !== kind) return payload;
  const failing = sealChecksFailing(payload, query);
  if (failing.length > 0) throw invalid(failing.join(', '));
  return payload;
}

// The kind of a SEAL as the API sent it, for a failing answer, whose SEAL is
// never verified. It only names the kind on the level line, since the answer
// fails either way. null when it does not decode.
function sentKind(jws: string): string | null {
  try {
    return sealKind(decodeSealPayload(jws));
  } catch {
    return null;
  }
}

// The answer with the kind beside minLevel, the kind asked for as required
// and the SEAL's as actual, read from the verified SEAL for a pass, from the
// SEAL as sent for a failing answer and null with no SEAL. minLevel, and so
// the answer, passes only when the SEAL is of the kind asked for.
function withKind(
  result: CheckResponse,
  kind: SealSubjectKind,
  verified: SealPayload | null,
): CheckResponse {
  const actual =
    verified !== null
      ? sealKind(verified)
      : result.seal === null
        ? null
        : sentKind(result.seal);
  const kindOk = actual === kind;
  return {
    ...result,
    ok: result.ok && kindOk,
    checks: result.checks.map((c) =>
      c.name === 'minLevel'
        ? { ...c, ok: c.ok && kindOk, kind: { required: kind, actual } }
        : c,
    ),
  };
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
      return `${status} level ${levelHas(check, actual)}, need ${levelNeeds(check)}`;
    case 'seal':
      return check.actual === 'withheld'
        ? `${status} no SEAL, ${withheld === null ? 'withheld' : withheldText(withheld)}, need a current SEAL`
        : `${status} SEAL ${actual}, need ${check.required}`;
    default:
      // A check this version does not know.
      return `${status} ${check.name} ${actual}, required ${check.required}`;
  }
}

// The SEAL's level with its kind, or the level with no SEAL to read the kind
// from. A check made without a kind prints its level alone.
function levelHas(check: Check, actual: string): string {
  if (check.kind === undefined) return actual;
  return check.kind.actual === null
    ? `${actual} with no SEAL`
    : levelWithKind(actual, kindName(check.kind.actual));
}

// The level asked for with its kind, any level of the kind for none.
function levelNeeds(check: Check): string {
  const required = String(check.required);
  if (check.kind === undefined) return `at least ${required}`;
  const kind = kindName(check.kind.required);
  return required === 'none'
    ? `${kind === 'Agent SEAL' ? 'an' : 'a'} ${kind} at any level`
    : `at least ${levelWithKind(required, kind)}`;
}
