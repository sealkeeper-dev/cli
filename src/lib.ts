// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// The importable API of the vouched package, for adapters that run in the
// same process as the agent. They load emit from the package root. Types are
// in types/lib.d.ts, which lib-types.test.ts keeps in step with this file.
import type { EmitInput } from './emit.js';
import { emit as emitTo } from './emit.js';

export type { EmitInput } from './emit.js';

// Appends one event to the local log under VOUCHED_HOME (default ~/.vouched)
// and returns it. It does not send anything. Run vouched sync, or let the
// next vouched emit do it.
export function emit(input: EmitInput) {
  return emitTo(input);
}
