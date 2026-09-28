// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import {
  base64urlDecode,
  CREDENTIAL_ISSUER,
  decodeHeader,
  LEGACY_ISSUERS,
  type SealBrokenReason,
  utf8Decode,
  verifySeal,
  WELL_KNOWN_PATH,
  WELL_KNOWN_URL,
} from '@sealkeeper/schema';
import { z } from 'zod';
import { createApiClient } from './api.js';
import {
  DEFAULT_API_URL,
  ensureHome,
  type Paths,
  writeFileAtomic,
} from './config.js';
import { stderr } from './output.js';
import { SealClaims, WellKnown } from './responses.js';

// A SEAL, Signed Evidence of Agent Legitimacy, is the compact JWS the API
// signs over an agent's scores and counts. This file checks one offline
// against the SealKeeper public keys and keeps a copy of those keys.

// The path the keys are served at, from the schema, so the CLI, the API and
// the web never name different ones.
// Cached keys are fetched again once they are older than this, or sooner
// when a SEAL names a kid they do not have.
export const KEYS_MAX_AGE_MS = 24 * 3600 * 1000;
// When the keys cannot be fetched, or seal verify runs with --offline,
// cached keys stand in until they are this old. A key SealKeeper has since
// withdrawn is trusted at most this long offline.
export const KEYS_OFFLINE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const KEYS_TIMEOUT_MS = 10_000;

export type SealCheck = {
  valid: boolean;
  // null when valid. Otherwise bad signature, unknown kid, wrong issuer,
  // unsupported version, expired N minutes ago, not yet valid or
  // malformed.
  reason: string | null;
  // The payload as signed. null unless the signature checked out, so an
  // unverified claim is never shown.
  payload: unknown;
  expiresAt: string | null;
};

// The iss a SEAL's payload names, read before any check and used only to
// pick where its keys come from. Nothing else trusts it, and verifySeal
// checks iss again after the signature. null when there is none.
export function sealIssuer(jws: string): string | null {
  try {
    const payload = decodeSealPayload(jws) as { iss?: unknown } | null;
    return typeof payload?.iss === 'string' ? payload.iss : null;
  } catch {
    return null;
  }
}

// The kid a SEAL names, or null when it is not a JWS with an EdDSA header.
export function sealKid(jws: string): string | null {
  try {
    return decodeHeader(jws).kid;
  } catch {
    return null;
  }
}

// The API's name for each reason, spelled with spaces. expired adds how
// long ago, below.
const WORDS: Record<SealBrokenReason, string> = {
  malformed: 'malformed',
  unknown_kid: 'unknown kid',
  bad_signature: 'bad signature',
  wrong_issuer: 'wrong issuer',
  unsupported_version: 'unsupported version',
  expired: 'expired',
  not_yet_valid: 'not yet valid',
};

// Checks a SEAL with verifySeal from @sealkeeper/schema, the steps of the
// standard in order: the header, the key the kid names, the signature over
// the exact bytes of header.payload, then the issuer, the version, the
// shape, expiry and iat. Verify first, parse second. The API's POST
// /v1/seal/verify and the web's checkSeal call the same function, and the
// SEAL conformance cases in @sealkeeper/schema hold all three to the same
// answers. This adds how long ago an expired SEAL ran out, and keeps the
// signed payload of a broken SEAL for what it prints.
export async function checkSeal(
  jws: string,
  wellKnown: WellKnown,
  nowMs: number,
): Promise<SealCheck> {
  const r = await verifySeal(wellKnown.keys, jws, nowMs / 1000);
  if (r.ok) {
    return {
      valid: true,
      reason: null,
      payload: r.payload,
      expiresAt: new Date(r.payload.exp * 1000).toISOString(),
    };
  }
  const payload = r.signed ?? null;
  const expiresAt = r.payload
    ? new Date(r.payload.exp * 1000).toISOString()
    : r.reason === 'wrong_issuer'
      ? expiresAtOf(payload)
      : null;
  if (r.reason === 'expired' && r.payload) {
    const minutes = Math.max(1, Math.ceil((nowMs / 1000 - r.payload.exp) / 60));
    return {
      valid: false,
      reason: `expired ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`,
      payload,
      expiresAt,
    };
  }
  return { valid: false, reason: WORDS[r.reason], payload, expiresAt };
}

// The expiry of a payload of any shape, when it carries one in Unix seconds.
function expiresAtOf(payload: unknown): string | null {
  const exp =
    typeof payload === 'object' && payload !== null && 'exp' in payload
      ? (payload as { exp: unknown }).exp
      : undefined;
  return typeof exp === 'number' && Number.isFinite(exp) && exp >= 0
    ? new Date(exp * 1000).toISOString()
    : null;
}

// What a verified SEAL says, one line each, for seal show and seal verify.
// Level, the eight counts (with the counted value beside each task count
// from version 2 on, VOU-140), the three posted counts, fingerprint and
// state of version 3, operator verified, last active as a date, dormant
// days and any identity references. A legacy SEAL, issued before
// version 1, has only some of these, so a line is left out when its field
// is. Nothing for a payload that is not a SEAL.
const COUNT_LINES = [
  ['events', 'events'],
  ['history_days', 'history days'],
  ['verified_tasks', 'verified tasks'],
  ['seed_tasks', 'seed tasks'],
  ['server_checked_tasks', 'server checked tasks'],
  ['confirmed_tasks', 'confirmed tasks'],
  ['distinct_operators', 'distinct operators'],
  ['safety_incidents_90d', 'safety incidents in 90 days'],
  ['posted_tasks', 'posted tasks'],
  ['posted_confirmed_tasks', 'posted confirmed tasks'],
  ['posted_distinct_operators', 'posted distinct operators'],
] as const;

const day = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

export function sealSummary(payload: unknown): string[] {
  const parsed = SealClaims.safeParse(payload);
  if (!parsed.success) return [];
  const c = parsed.data;
  const lines: string[] = [];
  lines.push(
    c.level === undefined
      ? 'level not in this SEAL, it was issued before version 1'
      : `level ${c.level}`,
  );
  for (const [key, label] of COUNT_LINES) {
    const value = c.counts[key];
    if (value === undefined) continue;
    // From version 2 on a SEAL carries the counted value the level read
    // beside the raw count, for the four task counts.
    const counted =
      c.counted !== undefined && key in c.counted
        ? c.counted[key as keyof typeof c.counted]
        : undefined;
    lines.push(
      counted === undefined
        ? `${label} ${value}`
        : `${label} ${value}, ${counted} counted`,
    );
  }
  // Only version 3 defines fingerprint and state.
  if (c.ver === 3) {
    if (c.fingerprint !== undefined) {
      lines.push(
        c.fingerprint === null
          ? 'fingerprint none sent'
          : `fingerprint ${c.fingerprint.hash} since ${day(c.fingerprint.at)}`,
      );
    }
    if (c.state !== undefined) lines.push(`state ${c.state}`);
  }
  if (c.operator !== undefined) {
    lines.push(`operator verified ${c.operator.verified ? 'yes' : 'no'}`);
  }
  if (c.last_active !== undefined) {
    lines.push(
      `last active ${c.last_active === null ? 'never' : day(c.last_active)}`,
    );
  }
  if (c.dormant_days !== undefined) {
    lines.push(
      `dormant days ${c.dormant_days === null ? 'none' : c.dormant_days}`,
    );
  }
  for (const ref of c.identity ?? []) {
    lines.push(
      `identity ${ref.kind} ${ref.scope} from ${ref.provider}, attested ${day(ref.attested_at)}`,
    );
  }
  return lines;
}

// The payload of a SEAL the CLI already verified, as it was signed.
export function decodeSealPayload(jws: string): unknown {
  return JSON.parse(utf8Decode(base64urlDecode(jws.split('.')[1] ?? '')));
}

// "Expires in 23 hours 4 minutes".
export function expiresInText(expiresAt: string, nowMs: number): string {
  const total = Math.max(
    0,
    Math.floor((Date.parse(expiresAt) - nowMs) / 60_000),
  );
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return `Expires in ${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
}

// The keys could not be loaded, from the file given or from the API.
export class KeysError extends Error {
  override name = 'KeysError';
}

// Reads a saved copy of the keys document (WELL_KNOWN_PATH) from disk. Never touches the
// network.
export async function readKeysFile(file: string): Promise<WellKnown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new KeysError(
      `could not read keys from ${file}: ${(error as Error).message}`,
    );
  }
  const parsed = parseWellKnown(raw);
  if (!parsed) {
    throw new KeysError(
      `${file} is not a SealKeeper keys document like ${WELL_KNOWN_PATH}`,
    );
  }
  return parsed;
}

function parseWellKnown(raw: string): WellKnown | null {
  try {
    const result = WellKnown.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// origin is the origin the keys came from, the issuer's own domain or an
// API, so keys fetched from one place are never used to check a SEAL meant
// for another. A cache written before it existed does not parse and is
// fetched again.
const CachedKeys = z.object({
  v: z.literal(1),
  origin: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  wellKnown: WellKnown,
});

type LoadKeysOptions = {
  apiUrl: string;
  fetch: typeof fetch;
  paths: Paths;
  nowMs: number;
  // The kid of the SEAL being checked. Keys that lack it are fetched again.
  kid: string;
  // The iss of the SEAL being checked, from sealIssuer. It picks where the
  // keys come from, see keysBaseUrl.
  iss: string | null;
  // Cached keys only, never the network. Throws KeysError when the cache
  // has no usable copy.
  offline?: boolean;
};

// The origin of the issuer's documented keys URL, WELL_KNOWN_URL without its
// path.
export const ISSUER_ORIGIN = new URL(WELL_KNOWN_URL).origin;

// The base URL the keys for a SEAL are fetched from, WELL_KNOWN_PATH
// appended. A SEAL from the production issuer,
// checked by a CLI that points at the production API, gets its keys from
// WELL_KNOWN_URL on the issuer's own domain, the URL the standard
// documents. Any other API, a local or staging one, signs its SEALs with
// its own key under the same iss, so its keys come from that API. So do the
// keys for a SEAL of any other issuer, which verifySeal then names a wrong
// issuer.
export function keysBaseUrl(apiUrl: string, iss: string | null): string {
  const production =
    iss === CREDENTIAL_ISSUER ||
    (LEGACY_ISSUERS as readonly (string | null)[]).includes(iss);
  return production && originOf(apiUrl) === originOf(DEFAULT_API_URL)
    ? ISSUER_ORIGIN
    : apiUrl;
}

// The origin keysBaseUrl picks, the one the keys are cached under.
export function keysOrigin(apiUrl: string, iss: string | null): string {
  return originOf(keysBaseUrl(apiUrl, iss));
}

const DAYS = (ms: number) => ms / (24 * 3600 * 1000);

// The cached keys while they came from the same origin, are under a day old
// and know the kid. Otherwise fetches them from keysBaseUrl and caches them
// with its origin. When the fetch fails it falls back to cached keys from
// the same origin that know the kid and are under KEYS_OFFLINE_MAX_AGE_MS
// old, with one line on stderr. With offline it never fetches and uses that
// same fallback, silently. A copy dated later than now is never used.
// Throws KeysError when there are no usable keys at all.
export async function loadKeys(options: LoadKeysOptions): Promise<WellKnown> {
  const base = keysBaseUrl(options.apiUrl, options.iss);
  const origin = keysOrigin(options.apiUrl, options.iss);
  const read = await readCachedKeys(options.paths);
  const cached =
    read !== null &&
    read.origin === origin &&
    read.wellKnown.keys.some((k) => k.kid === options.kid)
      ? read
      : null;
  // A copy stamped later than now was fetched while the clock ran ahead, so
  // its age is unknown. It counts as too old for both limits and is fetched
  // again.
  const fetchedMs = cached ? Date.parse(cached.fetchedAt) : 0;
  const future = cached !== null && fetchedMs > options.nowMs;
  const age = future
    ? Number.POSITIVE_INFINITY
    : cached
      ? options.nowMs - fetchedMs
      : 0;
  const staleText = !cached
    ? ''
    : future
      ? `the copy fetched at ${cached.fetchedAt} is dated in the future`
      : `the copy fetched at ${cached.fetchedAt} is more than ${DAYS(KEYS_OFFLINE_MAX_AGE_MS)} days old`;

  if (options.offline) {
    if (cached && age < KEYS_OFFLINE_MAX_AGE_MS) return cached.wellKnown;
    throw new KeysError(
      cached
        ? `no usable cached SealKeeper keys for --offline, ${staleText}`
        : `the cached keys from ${origin} do not include kid ${options.kid}, run sealkeeper seal verify once without --offline, or pass --keys`,
    );
  }
  if (cached && age < KEYS_MAX_AGE_MS) return cached.wellKnown;

  const api = createApiClient({
    apiUrl: base,
    fetch: options.fetch,
    timeoutMs: KEYS_TIMEOUT_MS,
  });
  let fresh: WellKnown;
  try {
    fresh = await api.getWellKnown();
  } catch (error) {
    if (cached && age < KEYS_OFFLINE_MAX_AGE_MS) {
      stderr(
        `warning: could not fetch the SealKeeper keys, using the copy fetched at ${cached.fetchedAt}`,
      );
      return cached.wellKnown;
    }
    throw new KeysError(
      `could not load the SealKeeper keys from ${api.apiUrl}${WELL_KNOWN_PATH}: ${(error as Error).message}${staleText ? `, and ${staleText}` : ''}`,
    );
  }

  try {
    await ensureHome(options.paths);
    await writeFileAtomic(
      options.paths.wellKnown,
      `${JSON.stringify({
        v: 1,
        origin,
        fetchedAt: new Date(options.nowMs).toISOString(),
        wellKnown: fresh,
      })}\n`,
      0o644,
    );
  } catch {
    // A home that cannot be written only costs a fetch next time.
  }
  return fresh;
}

// The origin of an API URL, or the URL itself when it does not parse, in
// which case the fetch fails anyway.
function originOf(apiUrl: string): string {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return apiUrl;
  }
}

async function readCachedKeys(
  p: Paths,
): Promise<z.infer<typeof CachedKeys> | null> {
  try {
    const result = CachedKeys.safeParse(
      JSON.parse(await readFile(p.wellKnown, 'utf8')),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
