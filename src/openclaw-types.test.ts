// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// The published types in types/openclaw.d.ts are written by hand. These
// checks run in the typecheck and fail it when they drift from the source.
import { describe, expectTypeOf, it } from 'vitest';
import type * as published from '../types/openclaw.js';
import type * as openclaw from './openclaw.js';

describe('published openclaw types', () => {
  it('match the source types', () => {
    expectTypeOf<published.OpenClawPluginApiLike>().toEqualTypeOf<openclaw.OpenClawPluginApiLike>();
    expectTypeOf<published.SealKeeperOpenClawOptions>().toEqualTypeOf<openclaw.SealKeeperOpenClawOptions>();
    expectTypeOf<published.SealKeeperOpenClawPlugin>().toEqualTypeOf<openclaw.SealKeeperOpenClawPlugin>();
    expectTypeOf<typeof published.sealKeeperPlugin>().toEqualTypeOf<
      typeof openclaw.sealKeeperPlugin
    >();
    expectTypeOf<typeof published.default>().toEqualTypeOf<
      typeof openclaw.default
    >();
  });

  it('accepts an api shaped like OpenClaw plugin api', () => {
    // A trimmed copy of the shape OpenClaw passes to register.
    const api = {
      id: 'sealkeeper',
      logger: { info: (_: string) => {} },
      on: (
        _hookName: string,
        _handler: (event: never, ctx: never) => unknown,
        _opts?: { priority?: number },
      ) => {},
    };
    expectTypeOf(api).toExtend<published.OpenClawPluginApiLike>();
  });

  it('accepts an on that is generic over typed hook names', () => {
    // How OpenClaw types api.on, trimmed to two hooks.
    type Handlers = {
      after_tool_call: (
        event: { toolName: string; durationMs?: number },
        ctx: { toolName: string },
      ) => void | Promise<void>;
      session_start: (
        event: { sessionId: string },
        ctx: { sessionId: string },
      ) => void;
    };
    type Api = {
      on: <K extends keyof Handlers>(
        hookName: K,
        handler: Handlers[K],
        opts?: { priority?: number },
      ) => void;
    };
    expectTypeOf<Api>().toExtend<published.OpenClawPluginApiLike>();
  });
});
