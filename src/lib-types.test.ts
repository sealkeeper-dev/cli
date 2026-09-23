// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// The published types in types/lib.d.ts are written by hand. These checks
// run in the typecheck and fail it when they drift from the source types.
import type { Event } from '@vouched/schema';
import { describe, expectTypeOf, it } from 'vitest';
import type * as published from '../types/lib.js';
import type * as lib from './lib.js';

describe('published lib types', () => {
  it('match the source types', () => {
    expectTypeOf<published.Event>().toEqualTypeOf<Event>();
    expectTypeOf<published.EmitInput>().toEqualTypeOf<lib.EmitInput>();
    expectTypeOf<typeof published.emit>().parameters.toEqualTypeOf<
      Parameters<typeof lib.emit>
    >();
    expectTypeOf<ReturnType<typeof published.emit>>().toEqualTypeOf<
      ReturnType<typeof lib.emit>
    >();
  });
});
