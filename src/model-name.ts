// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The model name the agent declares (VOU-566). Sync sends it as text beside
// the fingerprint, in the same signed declaration, so SealKeeper can show
// which model the agent runs. A submit sends it too, inside its signed
// payload, as the model that solved the task (VOU-615). It is what the
// agent says about itself, and SealKeeper reads it as that and never as
// proof.
//
// The name is the model_name the adapter read in the source that decides
// the fingerprint (chosenSource in fingerprint.ts). A runtime with no
// adapter declares none.
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

// True when the API refused a submit's model name, a 400 whose issue names
// it. An API from before the field answers validation_failed with the key
// unknown to its strict payload, and one whose ModelName rule is stricter
// than this CLI's names the field in the issue path. The submit is then
// sent again without it, as a refused fingerprint is (sendWithFingerprint
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
