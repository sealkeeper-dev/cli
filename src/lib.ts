// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// The importable API of the sealkeeper package, for adapters that run in the
// same process as the agent. They load emit from the package root. Types are
// in types/lib.d.ts, which lib-types.test.ts keeps in step with this file.
import type { EmitInput } from './emit.js';
import { emit as emitTo } from './emit.js';
import { migrateHomeFromEnv } from './home-migration.js';

export type { EmitInput } from './emit.js';

// Appends one event to the local log under SEALKEEPER_HOME (default
// ~/.sealkeeper) and returns it. It does not send anything. Run sealkeeper
// sync, which shows the events and asks before the first send, or let the
// next sealkeeper emit send it once automatic sync is on.
//
// The first call after the rename copies ~/.vouched to ~/.sealkeeper, as
// every CLI command does. When that copy fails emit throws and writes
// nothing, so the new home is never started empty next to the old one.
export async function emit(input: EmitInput) {
  await migrateHomeFromEnv();
  return emitTo(input);
}
