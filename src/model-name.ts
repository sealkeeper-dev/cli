// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The model name the agent declares (VOU-566). Sync sends it as text beside
// the fingerprint, in the same signed declaration, so SealKeeper can show
// which model the agent runs. It is what the agent says about itself, and
// SealKeeper reads it as that and never as proof.
//
// A name an adapter reads wins over one set by hand. The adapter's is the
// model_name of the source that decides the fingerprint (chosenSource in
// fingerprint.ts). A runtime with no adapter sets one with model set, kept
// in model.json. Not in config.json, since CLI 0.4.4 and earlier read that
// file strictly and fail on a key they do not know.
import { ModelName } from '@sealkeeper/schema';
import { z } from 'zod';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { readIfExists } from './files.js';
import {
  type CaptureOptions,
  chosenSource,
  type FingerprintSource,
} from './fingerprint.js';

const ModelFile = z.object({ v: z.literal(1), name: ModelName });

// The name set by hand, or null when none is set or the file does not read.
export async function readModelSet(p: Paths = paths()): Promise<string | null> {
  try {
    const raw = await readIfExists(p.model);
    if (raw === null) return null;
    const parsed = ModelFile.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.name : null;
  } catch {
    return null;
  }
}

// Keeps a name set by hand. The caller has checked it with ModelName.
export async function writeModelSet(
  name: string,
  p: Paths = paths(),
): Promise<void> {
  await ensureHome(p);
  await writeFileAtomic(p.model, `${JSON.stringify({ v: 1, name })}\n`);
}

// Where the declared name comes from, an adapter's source or set by hand.
export type ModelSource = FingerprintSource | 'set';
export type DeclaredModel = { name: string; source: ModelSource };

// The name the next sync declares, or null when no adapter read one and
// none is set. Never throws, so a sync never fails over it.
export async function declaredModel(
  options: CaptureOptions = {},
): Promise<DeclaredModel | null> {
  try {
    const chosen = await chosenSource(options);
    const read = ModelName.safeParse(chosen?.observed.model_name);
    if (chosen !== undefined && read.success) {
      return { name: read.data, source: chosen.name };
    }
    const set = await readModelSet(options.paths ?? paths());
    return set === null ? null : { name: set, source: 'set' };
  } catch {
    return null;
  }
}
