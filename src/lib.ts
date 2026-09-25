// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The importable API of the sealkeeper package, for adapters that run in the
// same process as the agent. They load emit from the package root. Types are
// in types/lib.d.ts, which lib-types.test.ts keeps in step with this file.
import type { EmitInput } from './emit.js';
import { emit as emitTo } from './emit.js';

export type { EmitInput } from './emit.js';

// Appends one event to the local log under SEALKEEPER_HOME (default
// ~/.sealkeeper) and returns it. It does not send anything. Run sealkeeper
// sync, which shows the events and asks before the first send, or let the
// next sealkeeper emit send it once automatic sync is on. The wrapper keeps
// the paths argument of the internal emit out of the published signature.
export function emit(input: EmitInput) {
  return emitTo(input);
}
