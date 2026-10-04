// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Types for the OpenClaw adapter in src/openclaw.ts, imported as
// sealkeeper/openclaw. Written by hand like lib.d.ts. src/openclaw-types.test.ts
// fails the typecheck if these drift from the source.

// The part of OpenClaw's plugin api this adapter uses. OpenClaw passes each
// handler an event and a context object. on is a method, so OpenClaw's own
// typed api, generic over the hook name, is accepted as it is.
export type OpenClawPluginApiLike = {
  on(
    hookName: string,
    handler: (event: never, ctx: never) => unknown,
    opts?: never,
  ): unknown;
};

// What OpenClaw's loader expects as a plugin entry.
export type SealKeeperOpenClawPlugin = {
  id: 'sealkeeper';
  name: string;
  description: string;
  register: (api: OpenClawPluginApiLike) => void;
};

// A plugin entry that hashes the model and the framework for the
// fingerprint and adds the session nudge. It writes no event since 0.5.0.
// Tool calls, prompts, usage and model output are never read.
export declare function sealKeeperPlugin(): SealKeeperOpenClawPlugin;

declare const plugin: SealKeeperOpenClawPlugin;
export default plugin;
