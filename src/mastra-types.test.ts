// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// The published types in types/mastra.d.ts are written by hand. These checks
// run in the typecheck and fail it when they drift from the source types.
import { describe, expectTypeOf, it } from 'vitest';
import type * as published from '../types/mastra.js';
import type * as mastra from './mastra.js';

describe('published mastra types', () => {
  it('match the source types', () => {
    expectTypeOf<published.MastraToolLike>().toEqualTypeOf<mastra.MastraToolLike>();
    expectTypeOf<published.WithVouchedOptions>().toEqualTypeOf<mastra.WithVouchedOptions>();
    expectTypeOf<published.VouchedSession>().toEqualTypeOf<mastra.VouchedSession>();
    expectTypeOf<typeof published.withVouched>().toEqualTypeOf<
      typeof mastra.withVouched
    >();
    expectTypeOf<typeof published.vouchedSession>().toEqualTypeOf<
      typeof mastra.vouchedSession
    >();
  });

  it('accepts a createTool shaped object and keeps its type', () => {
    const tools = {
      weather: {
        id: 'get-weather',
        description: 'Weather for a city',
        inputSchema: {},
        execute: async ({ city }: { city: string }) => ({ city, temp: 21 }),
      },
    };
    type Wrapped = ReturnType<typeof published.withVouched<typeof tools>>;
    expectTypeOf<Wrapped>().toEqualTypeOf<typeof tools>();
    type WrappedList = ReturnType<
      typeof published.withVouched<(typeof tools.weather)[]>
    >;
    expectTypeOf<WrappedList>().toEqualTypeOf<(typeof tools.weather)[]>();
  });
});
