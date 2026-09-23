// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import {
  base64urlDecode,
  CredentialPayload,
  decodeHeader,
  Jws,
  verify,
} from '@vouched-dev/schema';
import { z } from 'zod';
import { type ApiClient, ApiError } from './api.js';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { stderr } from './output.js';

// The agent's current Vouched credential, cached in ~/.vouched/credential.json
// so card write can run on a schedule without a round trip each time. The
// cache holds only what the API already made public.

// A cached credential is reused while it has more than this left.
export const REFRESH_MARGIN_SEC = 2 * 3600;

const CachedCredential = z.strictObject({
  v: z.literal(1),
  credential: Jws,
  payload: CredentialPayload,
});

export type Credential = { credential: string; payload: CredentialPayload };

// The API answered but what it sent cannot be used, for example a credential
// that fails verification. It is never cached.
export class CredentialError extends Error {
  override name = 'CredentialError';
}

export type GetCredentialOptions = {
  api: ApiClient;
  agentId: string;
  force?: boolean;
  now?: () => number;
  paths?: Paths;
};

// Returns the cached credential while it is fresh. Otherwise fetches one,
// verifies it against the API's well-known keys, caches it and returns it.
// When the API cannot be reached it falls back to an unexpired cached
// credential with one line on stderr, or returns null when there is none.
// Throws CredentialError for a credential that does not verify and ApiError
// for any other API answer, such as an unregistered agent.
export async function getCredential(
  options: GetCredentialOptions,
): Promise<Credential | null> {
  const p = options.paths ?? paths();
  const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
  const cached = await readCache(p, options.agentId);

  if (
    !options.force &&
    cached !== null &&
    cached.payload.exp - nowSec > REFRESH_MARGIN_SEC
  ) {
    return cached;
  }

  let fresh: Credential;
  try {
    fresh = await fetchVerified(options.api, options.agentId, nowSec);
  } catch (error) {
    if (!unreachable(error)) throw error;
    if (cached !== null && cached.payload.exp > nowSec) {
      const expires = new Date(cached.payload.exp * 1000).toISOString();
      stderr(
        `warning: could not reach the Vouched API, using the cached credential that expires at ${expires}`,
      );
      return cached;
    }
    return null;
  }

  await ensureHome(p);
  await writeFileAtomic(
    p.credential,
    `${JSON.stringify({ v: 1, ...fresh })}\n`,
  );
  return fresh;
}

// Verify first, parse second. The key is picked by the kid in the header
// from the keys the API publishes at /.well-known/vouched.json.
async function fetchVerified(
  api: ApiClient,
  agentId: string,
  nowSec: number,
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
      'the credential from the API is not a valid JWS, not using it',
    );
  }
  const key = wellKnown.keys.find((k) => k.kid === kid);
  if (!key) {
    throw new CredentialError(
      `the credential from the API is signed with unknown key ${kid}, not using it`,
    );
  }

  let verified: unknown;
  try {
    verified = (await verify(jws, base64urlDecode(key.x))).payload;
  } catch {
    throw new CredentialError(
      'the credential from the API failed signature verification, not using it',
    );
  }
  const payload = CredentialPayload.safeParse(verified);
  if (!payload.success) {
    throw new CredentialError(
      'the credential from the API has an invalid payload, not using it',
    );
  }
  if (payload.data.sub !== agentId) {
    throw new CredentialError(
      'the credential from the API is for another agent, not using it',
    );
  }
  if (payload.data.exp <= nowSec) {
    throw new CredentialError(
      'the credential from the API has expired, not using it',
    );
  }
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

// null when there is no cache, it does not parse, or it belongs to another
// agent id (after init --force). The next fetch rewrites it.
async function readCache(
  p: Paths,
  agentId: string,
): Promise<Credential | null> {
  let raw: string;
  try {
    raw = await readFile(p.credential, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const cached = CachedCredential.safeParse(json);
  if (!cached.success || cached.data.payload.sub !== agentId) return null;
  return { credential: cached.data.credential, payload: cached.data.payload };
}
