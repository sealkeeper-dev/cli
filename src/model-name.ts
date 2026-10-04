// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The model name the agent declares (VOU-566). Sync sends it as text beside
// the fingerprint, in the same signed declaration, so SealKeeper can show
// which model the agent runs. It is what the agent says about itself, and
// SealKeeper reads it as that and never as proof.
//
// The name is the model_name the adapter read in the source that decides
// the fingerprint (chosenSource in fingerprint.ts). A runtime with no
// adapter declares none.
import { ModelName } from '@sealkeeper/schema';
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
