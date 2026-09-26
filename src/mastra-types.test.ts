// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The published types in types/mastra.d.ts are written by hand. These checks
// run in the typecheck and fail it when they drift from the source types.
import { describe, expectTypeOf, it } from 'vitest';
import type * as published from '../types/mastra.js';
import type * as mastra from './mastra.js';

describe('published mastra types', () => {
  it('match the source types', () => {
    expectTypeOf<published.MastraToolLike>().toEqualTypeOf<mastra.MastraToolLike>();
    expectTypeOf<published.SealKeeperSession>().toEqualTypeOf<mastra.SealKeeperSession>();
    expectTypeOf<typeof published.withSealKeeper>().toEqualTypeOf<
      typeof mastra.withSealKeeper
    >();
    expectTypeOf<typeof published.sealKeeperSession>().toEqualTypeOf<
      typeof mastra.sealKeeperSession
    >();
    expectTypeOf<published.CheckThresholds>().toEqualTypeOf<mastra.CheckThresholds>();
    expectTypeOf<published.CheckOptions>().toEqualTypeOf<mastra.CheckOptions>();
    expectTypeOf<published.Check>().toEqualTypeOf<mastra.Check>();
    expectTypeOf<published.CheckResponse>().toEqualTypeOf<mastra.CheckResponse>();
    expectTypeOf<typeof published.check>().toEqualTypeOf<typeof mastra.check>();
    expectTypeOf<typeof published.sealKeeperContext>().toEqualTypeOf<
      typeof mastra.sealKeeperContext
    >();
    expectTypeOf<typeof published.assertTrusted>().toEqualTypeOf<
      typeof mastra.assertTrusted
    >();
    expectTypeOf<published.SealKeeperCheckError>().toEqualTypeOf<mastra.SealKeeperCheckError>();
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
    type Wrapped = ReturnType<typeof published.withSealKeeper<typeof tools>>;
    expectTypeOf<Wrapped>().toEqualTypeOf<typeof tools>();
    type WrappedList = ReturnType<
      typeof published.withSealKeeper<(typeof tools.weather)[]>
    >;
    expectTypeOf<WrappedList>().toEqualTypeOf<(typeof tools.weather)[]>();
  });
});
