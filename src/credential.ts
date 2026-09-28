// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  base64urlDecode,
  decodeHeader,
  Jws,
  sealVersionProblem,
  verify,
} from '@sealkeeper/schema';
import { z } from 'zod';
import { type ApiClient, ApiError } from './api.js';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { readIfExists } from './files.js';
import { stderr } from './output.js';
import { CredentialPayload } from './responses.js';
import { cacheKeys, keysOrigin, loadKeys } from './seal.js';

// The agent's current SEAL, Signed Evidence of Agent Legitimacy. In code it
// keeps its first name, the credential. It is cached in
// ~/.sealkeeper/credential.json so card write and seal write can run on a
// schedule without a round trip each time. The cache holds only what the API
// already made public.

// A cached SEAL is reused while it has more than this left.
const REFRESH_MARGIN_SEC = 2 * 3600;

// The cache keeps the SEAL as seal and as credential, the same string, so
// an older CLI that reads only credential still finds it. It reads either.
const CachedCredential = z
  .object({
    v: z.literal(1),
    seal: Jws.optional(),
    credential: Jws.optional(),
    payload: CredentialPayload,
  })
  .refine((c) => c.seal !== undefined || c.credential !== undefined);

export type Credential = { credential: string; payload: CredentialPayload };

// The API answered but what it sent cannot be used, for example a SEAL that
// fails verification. It is never cached.
export class CredentialError extends Error {
  override name = 'CredentialError';
}

type GetCredentialOptions = {
  api: ApiClient;
  agentId: string;
  // Fetch even when the cached SEAL is fresh, falling back to it only when
  // the API cannot be reached. seal show and card show pass it, so a
  // withheld SEAL prints the hold rather than the cached SEAL.
  force?: boolean;
  // For the keys a cached SEAL is checked against, the same fetch as api.
  // Without it a cached SEAL is reused unchecked.
  fetch?: typeof fetch;
  now?: () => number;
  paths?: Paths;
};

// False when the SealKeeper keys, cached for a day as seal verify keeps
// them and fetched again once older, no longer list the kid the cached SEAL
// was signed with, as after a key is dropped at the end of a rotation or at
// once after a compromise. True when they list it or cannot be loaded, since
// then nothing says the key is gone.
async function keyStillListed(
  options: GetCredentialOptions,
  cached: Credential,
  p: Paths,
  nowMs: number,
): Promise<boolean> {
  if (options.fetch === undefined) return true;
  let kid: string;
  try {
    kid = decodeHeader(cached.credential).kid;
  } catch {
    return false;
  }
  try {
    const keys = await loadKeys({
      apiUrl: options.api.apiUrl,
      fetch: options.fetch,
      paths: p,
      nowMs,
      kid,
      iss: cached.payload.iss,
    });
    return keys.keys.some((k) => k.kid === kid);
  } catch {
    return true;
  }
}

// Returns the cached SEAL while it is fresh. Otherwise fetches one, verifies
// it against the API's well-known keys, caches it and returns it. When the
// API cannot be reached it falls back to an unexpired cached SEAL with one
// line on stderr, or returns null when there is none. Throws CredentialError
// for a SEAL that does not verify and ApiError
// for any other API answer, such as an unregistered agent.
export async function getCredential(
  options: GetCredentialOptions,
): Promise<Credential | null> {
  const p = options.paths ?? paths();
  const nowMs = (options.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const read = await readCache(p, options.agentId);
  // A cached SEAL whose key has left the published keys is never reused,
  // so card write, seal write and the routine stop embedding it.
  const cached =
    read !== null && (await keyStillListed(options, read, p, nowMs))
      ? read
      : null;

  if (
    !options.force &&
    cached !== null &&
    cached.payload.exp - nowSec > REFRESH_MARGIN_SEC
  ) {
    return cached;
  }

  let fresh: Credential;
  try {
    fresh = await fetchVerified(options.api, options.agentId, nowSec, p);
  } catch (error) {
    if (!unreachable(error)) throw error;
    if (cached !== null && cached.payload.exp > nowSec) {
      const expires = new Date(cached.payload.exp * 1000).toISOString();
      stderr(
        `warning: could not reach the SealKeeper API, using the cached SEAL that expires at ${expires}`,
      );
      return cached;
    }
    return null;
  }

  await ensureHome(p);
  await writeFileAtomic(
    p.credential,
    `${JSON.stringify({ v: 1, seal: fresh.credential, ...fresh })}\n`,
  );
  return fresh;
}

// Verify first, parse second. The key is picked by the kid in the header
// from the keys the API publishes at WELL_KNOWN_PATH.
async function fetchVerified(
  api: ApiClient,
  agentId: string,
  nowSec: number,
  p: Paths,
): Promise<Credential> {
  const [response, wellKnown] = await Promise.all([
    api.getCredential(agentId),
    api.getWellKnown(),
  ]);
  const jws = response.credential;

  let kid: string;
  try {
    kid = decodeHeader(jws).kid;
  } catch {
    throw new CredentialError(
      'the SEAL from the API is not a valid JWS, not using it',
    );
  }
  const key = wellKnown.keys.find((k) => k.kid === kid);
  if (!key) {
    throw new CredentialError(
      `the SEAL from the API is signed with unknown key ${kid}, not using it`,
    );
  }

  let verified: unknown;
  try {
    verified = (await verify(jws, base64urlDecode(key.x))).payload;
  } catch {
    throw new CredentialError(
      'the SEAL from the API is broken, it failed signature verification, not using it',
    );
  }
  if (sealVersionProblem(verified) !== null) {
    throw new CredentialError(
      'the SEAL from the API has a version this CLI does not understand, not using it',
    );
  }
  const payload = CredentialPayload.safeParse(verified);
  if (!payload.success) {
    throw new CredentialError(
      'the SEAL from the API has an invalid payload, not using it',
    );
  }
  if (payload.data.sub !== agentId) {
    throw new CredentialError(
      'the SEAL from the API is for another agent, not using it',
    );
  }
  if (payload.data.exp <= nowSec) {
    throw new CredentialError(
      'the SEAL from the API has expired, not using it',
    );
  }
  // The keys it verified against go to the cache keyStillListed and seal
  // verify read, under the origin loadKeys would fetch them from. The API
  // serves the same document the issuer's domain does.
  await cacheKeys(
    p,
    keysOrigin(api.apiUrl, payload.data.iss),
    wellKnown,
    nowSec * 1000,
  );
  return { credential: jws, payload: payload.data };
}

// A network failure, a rate limit or a server error. Any other answer from
// the API is passed on to the caller.
function unreachable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  );
}

// null when there is no cache, it does not parse, it belongs to another
// agent id (after init --force) or its version is not one this CLI
// understands, such as a SEAL without ver from before version 1. The next
// fetch rewrites it.
async function readCache(
  p: Paths,
  agentId: string,
): Promise<Credential | null> {
  const raw = await readIfExists(p.credential);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const cached = CachedCredential.safeParse(json);
  if (!cached.success || cached.data.payload.sub !== agentId) return null;
  if (sealVersionProblem(cached.data.payload) !== null) return null;
  const jws = (cached.data.seal ?? cached.data.credential) as string;
  return { credential: jws, payload: cached.data.payload };
}
