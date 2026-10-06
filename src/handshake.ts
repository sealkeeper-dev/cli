// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  checkHandshake,
  HANDSHAKE_RECORD_NOTE,
  type HandshakeCheck,
  type HandshakeProof,
  type HandshakeRefusal,
  type SealPayload,
  signHandshake,
} from '@sealkeeper/schema';
import { ApiError, createApiClient } from './api.js';
import { type Paths, paths } from './config.js';
import { declaredFingerprint } from './declared-fingerprint.js';
import { loadKey } from './identity.js';
import { LiveAgent } from './live-agent.js';

// The handshake (VB-6). The agent signs its current fingerprint hash with
// its own key, so whoever holds its SEAL can check the presenter holds the
// key the SEAL names and whether it still runs what the SEAL records. The
// signing and the checks are the schema's, signHandshake and
// checkHandshake. This file finds the key and the fingerprint, and reads
// the issuer's record for a SEAL before version 3.

// How long the record lookup may take.
const RECORD_TIMEOUT_MS = 10_000;

// A signed handshake over the fingerprint sync or run last wrote to
// fingerprint.json, or null when there is none or its hash is not the hash
// of its parts. nonce is the one a verifier gave, aud the verifier's name.
// Never recomputes the fingerprint. Throws KeyError when the key file is
// not a key, and returns null when there is no key file.
export async function makeHandshake(
  nowMs: number,
  options: { nonce?: string; aud?: string } = {},
  p: Paths = paths(),
): Promise<string | null> {
  const { fingerprint } = await declaredFingerprint(p);
  if (fingerprint === undefined) return null;
  const key = await loadKey(p);
  if (key === null) return null;
  return signHandshake(
    key.privateKey,
    key.agentId,
    fingerprint,
    Math.floor(nowMs / 1000),
    options.nonce,
    options.aud,
  );
}

// makeHandshake that never throws, for the card, which must not fail
// over a handshake. null when there is none.
export async function makeHandshakeQuietly(
  nowMs: number,
  p: Paths = paths(),
): Promise<string | null> {
  try {
    return await makeHandshake(nowMs, {}, p);
  } catch {
    return null;
  }
}

// The record could not be read, so there is nothing to compare with.
export class RecordError extends Error {
  override name = 'RecordError';
}

// Reads the agent's current fingerprint hash from the agent answer at
// apiUrl, null when the API holds none or has no such agent. Throws
// RecordError when the API cannot be reached or answers anything else.
export function recordFromApi(apiUrl: string, fetchFn: typeof fetch) {
  return async (sub: string): Promise<string | null> => {
    const api = createApiClient({
      apiUrl,
      fetch: fetchFn,
      timeoutMs: RECORD_TIMEOUT_MS,
    });
    try {
      const live = await api.call(
        `/v1/agents/${encodeURIComponent(sub)}`,
        LiveAgent,
      );
      return live.fingerprint?.hash ?? null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw new RecordError(
        `could not read the agent's fingerprint from ${api.apiUrl}: ${(error as Error).message}`,
      );
    }
  };
}

// The refusals in words, one line each.
const REFUSAL_WORDS: Record<HandshakeRefusal, string> = {
  malformed: 'malformed',
  wrong_agent: 'signed for another agent',
  bad_signature: 'bad signature',
  stale:
    'signed outside its window, 5 minutes with a nonce and 24 hours without',
  nonce_mismatch: 'wrong nonce',
  wrong_verifier: 'made for another verifier',
};

// What a handshake that verified shows, one line, from its proof.
const PROOF_WORDS: Record<HandshakeProof, string> = {
  none: 'no nonce of yours, so it does not show the presenter holds the key, a copy replays for 24 hours',
  nonce:
    'it shows key possession to whoever holds your nonce, no more, pass --for with your own name to refuse one relayed from another verifier',
  verifier: 'made for you over your nonce, so the key holder answered you',
};

export type HandshakeLine = {
  // The answer for --json, as the API's handshake field has it.
  json:
    | { valid: true; result: string; against: string; proof: HandshakeProof }
    | { valid: false; reason: HandshakeRefusal };
  // What seal verify prints, one or two lines.
  lines: string[];
};

// The handshake beside a verified SEAL, through checkHandshake.
export async function checkHandshakeLine(options: {
  handshake: string;
  seal: SealPayload;
  nowMs: number;
  nonce?: string;
  aud?: string;
  record: (sub: string) => Promise<string | null>;
}): Promise<{ check: HandshakeCheck; out: HandshakeLine }> {
  const check = await checkHandshake({
    handshake: options.handshake,
    seal: options.seal,
    nowSeconds: options.nowMs / 1000,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    ...(options.aud === undefined ? {} : { aud: options.aud }),
    record: options.record,
  });
  if (!check.ok) {
    return {
      check,
      out: {
        json: { valid: false, reason: check.reason },
        lines: [`handshake refused: ${REFUSAL_WORDS[check.reason]}`],
      },
    };
  }
  const lines = [
    check.result === 'matches'
      ? 'handshake Matches'
      : check.result === 'changed'
        ? 'handshake Changed'
        : 'handshake valid, no fingerprint on record to compare with',
  ];
  if (check.against === 'record') {
    lines.push(HANDSHAKE_RECORD_NOTE);
  }
  lines.push(PROOF_WORDS[check.proof]);
  return {
    check,
    out: {
      json: {
        valid: true,
        result: check.result,
        against: check.against,
        proof: check.proof,
      },
      lines,
    },
  };
}
