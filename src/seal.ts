// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import {
  base64urlDecode,
  CREDENTIAL_ISSUER,
  decodeHeader,
  parseSealPayload,
  sealIatProblem,
  sealVersionProblem,
  utf8Decode,
  verify,
} from '@sealkeeper/schema';
import { z } from 'zod';
import { createApiClient } from './api.js';
import { ensureHome, type Paths, writeFileAtomic } from './config.js';
import { stderr } from './output.js';
import { SealClaims, WellKnown } from './responses.js';

// A SEAL, Signed Evidence of Agent Legitimacy, is the compact JWS the API
// signs over an agent's scores and counts. This file checks one offline
// against the Vouched public keys and keeps a copy of those keys.

export const WELL_KNOWN_PATH = '/.well-known/vouched.json';
// Cached keys are fetched again once they are older than this, or sooner
// when a SEAL names a kid they do not have.
export const KEYS_MAX_AGE_MS = 24 * 3600 * 1000;
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

// The kid a SEAL names, or null when it is not a JWS with an EdDSA header.
export function sealKid(jws: string): string | null {
  try {
    return decodeHeader(jws).kid;
  } catch {
    return null;
  }
}

// Checks in order. The header, then the signature over the exact bytes of
// header.payload with the key the kid names, then the issuer, then the
// version, then the shape, then expiry, then iat. Verify first, parse
// second. A version other than 1 is unsupported, and so is a SEAL without
// ver once LEGACY_UNTIL has passed, as sealVersionProblem in
// @sealkeeper/schema says. A version 1 payload must then match the strict
// shape, parseSealPayload. The API's POST /v1/seal/verify and the web's
// checkSeal use the same rules, and the SEAL conformance cases in
// @sealkeeper/schema hold all three to the same answers.
export async function checkSeal(
  jws: string,
  wellKnown: WellKnown,
  nowMs: number,
): Promise<SealCheck> {
  const broken = (
    reason: string,
    payload: unknown = null,
    expiresAt: string | null = null,
  ): SealCheck => ({ valid: false, reason, payload, expiresAt });
  const nowSec = nowMs / 1000;

  const kid = sealKid(jws);
  if (kid === null) return broken('malformed');
  const key = wellKnown.keys.find((k) => k.kid === kid);
  if (!key) return broken('unknown kid');

  let payload: unknown;
  try {
    payload = (await verify(jws, base64urlDecode(key.x))).payload;
  } catch (error) {
    // verify checks the signature first and only then parses the payload.
    return broken(
      /signature/.test((error as Error).message)
        ? 'bad signature'
        : 'malformed',
    );
  }

  // The issuer straight after the signature, as in the API and the web, so
  // a SEAL from another issuer is named wrong issuer whatever its ver or
  // shape. The shape is only read once the version is known.
  const iss =
    typeof payload === 'object' && payload !== null && 'iss' in payload
      ? (payload as { iss: unknown }).iss
      : undefined;
  if (iss !== CREDENTIAL_ISSUER) {
    return broken('wrong issuer', payload, expiresAtOf(payload));
  }
  if (sealVersionProblem(payload, nowSec) !== null) {
    return broken('unsupported version', payload);
  }
  // A version 1 SEAL from vouched.run has one exact shape, and the API and
  // the web check it with the strict parser. So does this, so the three
  // never disagree about one. The loose read below is kept for what it
  // prints and for the legacy shape.
  if (hasVer(payload) && !parseSealPayload(payload, nowSec).ok) {
    return broken('malformed', payload);
  }

  const claims = SealClaims.safeParse(payload);
  if (!claims.success) return broken('malformed', payload);
  const expiresAt = new Date(claims.data.exp * 1000).toISOString();
  const leftSec = claims.data.exp - nowSec;
  if (leftSec <= 0) {
    const minutes = Math.max(1, Math.ceil(-leftSec / 60));
    return broken(
      `expired ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`,
      payload,
      expiresAt,
    );
  }
  // exp first, then iat, in the standard's order (sealIatProblem).
  if (sealIatProblem(claims.data.iat, nowSec) !== null) {
    return broken('not yet valid', payload, expiresAt);
  }
  return { valid: true, reason: null, payload, expiresAt };
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

function hasVer(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'ver' in payload;
}

// What a verified SEAL says, one line each, for seal show and seal verify.
// Level, the eight counts, operator verified, last active as a date,
// dormant days and any identity references. A legacy SEAL, issued before
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
    if (value !== undefined) lines.push(`${label} ${value}`);
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

// Reads a copy of /.well-known/vouched.json from disk. Never touches the
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
      `${file} is not a Vouched keys document like ${WELL_KNOWN_PATH}`,
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

const CachedKeys = z.object({
  v: z.literal(1),
  fetchedAt: z.iso.datetime(),
  wellKnown: WellKnown,
});

export type LoadKeysOptions = {
  apiUrl: string;
  fetch: typeof fetch;
  paths: Paths;
  nowMs: number;
  // The kid of the SEAL being checked. Keys that lack it are fetched again.
  kid: string;
};

// The cached keys while they are under a day old and know the kid.
// Otherwise fetches them from the API and caches them. When the fetch fails
// it falls back to cached keys that know the kid, with one line on stderr.
// Throws KeysError when there are no usable keys at all.
export async function loadKeys(options: LoadKeysOptions): Promise<WellKnown> {
  const cached = await readCachedKeys(options.paths);
  const knowsKid = (w: WellKnown) => w.keys.some((k) => k.kid === options.kid);
  if (
    cached &&
    options.nowMs - Date.parse(cached.fetchedAt) < KEYS_MAX_AGE_MS &&
    knowsKid(cached.wellKnown)
  ) {
    return cached.wellKnown;
  }

  const api = createApiClient({
    apiUrl: options.apiUrl,
    fetch: options.fetch,
    timeoutMs: KEYS_TIMEOUT_MS,
  });
  let fresh: WellKnown;
  try {
    fresh = await api.getWellKnown();
  } catch (error) {
    if (cached && knowsKid(cached.wellKnown)) {
      stderr(
        `warning: could not fetch the Vouched keys, using the copy fetched at ${cached.fetchedAt}`,
      );
      return cached.wellKnown;
    }
    throw new KeysError(
      `could not load the Vouched keys from ${api.apiUrl}${WELL_KNOWN_PATH}: ${(error as Error).message}`,
    );
  }

  try {
    await ensureHome(options.paths);
    await writeFileAtomic(
      options.paths.wellKnown,
      `${JSON.stringify({
        v: 1,
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
