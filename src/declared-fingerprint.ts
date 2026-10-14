// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { type Fingerprint, fingerprintProblem } from '@sealkeeper/schema';
import { ApiError } from './api.js';
import type { Paths } from './config.js';
import { currentFingerprint } from './fingerprint.js';

// The fingerprint a request declares, the one last written to fingerprint.json.
// claim, submit, outcome, run, duel, challenge and each routine step carry it
// inside their signed payload (sendWithFingerprint in tasks.ts), and sync as
// its own signed JWS beside the envelopes.

// The fingerprint to declare. Nothing when there is none, or when its hash is
// not the hash of its parts. It never recomputes and never throws, so a command
// never waits on a capture or fails over one.
export async function declaredFingerprint(
  p?: Paths,
): Promise<{ fingerprint?: Fingerprint }> {
  try {
    const fingerprint = await currentFingerprint(p);
    if (fingerprint === null || (await fingerprintProblem(fingerprint))) {
      return {};
    }
    return { fingerprint };
  } catch {
    return {};
  }
}

// True when the API refused the fingerprint, a 400 or 401 whose issue names it,
// as validation_failed, fingerprint_mismatch or an issue path that holds
// fingerprint.
export function refusesFingerprint(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 400 || error.status === 401) &&
    (error.code === 'fingerprint_mismatch' ||
      error.issues.some(
        (issue) =>
          issue.path.includes('fingerprint') ||
          (issue.code === 'unrecognized_keys' &&
            issue.message.includes('"fingerprint"')),
      ))
  );
}
