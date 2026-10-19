// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The model name the agent declares. Sync sends it as text beside the
// fingerprint, in the same signed declaration. A submit sends it too, inside
// its signed payload, as the model that solved the task.
//
// The name is the model_name the adapter read in the source that decides the
// fingerprint (chosenSource in fingerprint.ts), the agent's own, or a routine
// run's own source when options.routine names it. A runtime with no adapter
// declares none. A routine run's sync names none, and a routine submit names
// the model its runtime reported, else the one of the agent's own sessions.
import { ModelName } from '@sealkeeper/schema';
import { ApiError } from './api.js';
import {
  type CaptureOptions,
  chosenSource,
  type FingerprintSource,
} from './fingerprint.js';

// The adapter's source the declared name comes from.
export type DeclaredModel = { name: string; source: FingerprintSource };

// The name the next sync declares, or null when no adapter read one. Never
// throws, so a sync never fails over it.
export async function declaredModel(
  options: CaptureOptions = {},
): Promise<DeclaredModel | null> {
  try {
    const chosen = await chosenSource(options);
    const read = ModelName.safeParse(chosen?.observed.model_name);
    return chosen !== undefined && read.success
      ? { name: read.data, source: chosen.name }
      : null;
  } catch {
    return null;
  }
}

// True when the API refused a submit's model name, a 400 whose issue names it,
// as validation_failed or an issue path that holds the field. The submit is
// then sent again without it, as a refused fingerprint is (sendWithFingerprint
// in tasks.ts), so a submit is never lost over the name.
export function refusesModelName(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.issues.some(
      (issue) =>
        issue.path.includes('modelName') ||
        (issue.code === 'unrecognized_keys' &&
          issue.message.includes('"modelName"')),
    )
  );
}
