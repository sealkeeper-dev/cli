// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The OpenClaw adapter, imported as sealkeeper/openclaw. OpenClaw loads plugins
// into the Gateway process and calls register(api) once, where the plugin
// subscribes to typed hooks with api.on(name, handler). This file is such a
// plugin entry. It writes no event (VOU-627). The agent's own sessions are
// its operator's work, so only a routine run, which is SealKeeper work,
// records a session and its usage, see routine-run.ts. The plugin reads the
// fingerprint parts OpenClaw shows and adds the session nudge. A CLI before
// 0.5.0 also wrote session.start, session.end and usage here. It swallows
// every failure so it never throws into the agent.
//
// OpenClaw is typed by shape only, so this file imports nothing from it. The
// hook names and fields match OpenClaw's source (src/plugins/hook-types.ts
// and the plugin loader) at openclaw/openclaw main cbcd4df, version
// 2026.9.6, where the built plugin was also run through OpenClaw's own
// registration and hook runner. It has not yet run inside a live Gateway.
// Types are in types/openclaw.d.ts, which openclaw-types.test.ts keeps in
// step.
import { adapterNudge } from './adapter-core.js';
import { openClawVersion } from './adapter-fingerprint.js';
import {
  createObserver,
  type FingerprintObserver,
} from './fingerprint-observer.js';
import { modelNameOf, toolNameOf } from './names.js';
import { quietly } from './output.js';

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

// What OpenClaw's loader expects as a plugin entry. It is the same object
// definePluginEntry from openclaw/plugin-sdk returns, minus the config schema.
export type SealKeeperOpenClawPlugin = {
  id: 'sealkeeper';
  name: string;
  description: string;
  register: (api: OpenClawPluginApiLike) => void;
};

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// The fingerprint parts OpenClaw shows (VB-2). The framework version once,
// at register, and each model id llm_output reports. The tool set is not
// declared, since OpenClaw shows tools one call at a time. Hashes are
// written, and the model id also as the model name, in text, see
// fingerprint-observer.ts.
function observeFramework(observer: FingerprintObserver): void {
  void quietly(async () => {
    try {
      const version = await openClawVersion();
      if (version !== null) await observer.framework('openclaw', version);
    } catch {
      // Left not declared.
    }
  });
}

// Wires the hooks. The only handler reads the model id llm_output reports.
// Tool calls, prompts, messages, usage and model output are never read,
// logged or emitted.
function register(api: OpenClawPluginApiLike): void {
  const observer = createObserver('openclaw');
  observeFramework(observer);

  registerNudge(api);

  // OpenClaw only delivers llm_output to a plugin that was granted
  // conversation access, and refuses the registration otherwise, which
  // leaves the nudge in place. A handler that throws when reading a hostile
  // event is skipped quietly. From the event only model is read.
  try {
    api.on('llm_output', (event: unknown) => {
      try {
        const raw = field(event, 'model');
        const model = toolNameOf(raw);
        // Written only the first time this process sees the id.
        if (model !== null) void observer.model(model, modelNameOf(raw));
      } catch {
        // Skipped.
      }
      return undefined;
    });
  } catch {
    // Refused by policy. The nudge still works.
  }
}

// The session nudge (VOU-137). session_start returns nothing in OpenClaw,
// so it cannot add context. before_prompt_build runs before each run's
// prompt is built and may return appendSystemContext, which OpenClaw
// appends to the system prompt, where providers can cache it. OpenClaw's
// other prompt hooks, agent_turn_prepare and the periodic
// heartbeat_prompt_contribution, are not used. OpenClaw treats it as a prompt injection and a
// conversation hook, so a plugin installed from npm gets it only with
// plugins.entries.sealkeeper.hooks.allowConversationAccess true, and not
// with hooks.allowPromptInjection false. The summary comes from the cached
// goal only, so a prompt never waits on the network, and only once the
// operator turned the nudge on. Anything else returns nothing, which leaves
// the prompt as it was. The agent is told to run run --json, which
// claims only seed tasks unasked, and gets the sealkeeper skill's body,
// since OpenClaw has no slash commands (adapterNudge).

function registerNudge(api: OpenClawPluginApiLike): void {
  try {
    api.on('before_prompt_build', async () => {
      const text = await adapterNudge();
      return text.length > 0 ? { appendSystemContext: text } : undefined;
    });
  } catch {
    // Refused by policy. The other hooks still work.
  }
}

// A plugin entry for OpenClaw. The default export is sealKeeperPlugin().
export function sealKeeperPlugin(): SealKeeperOpenClawPlugin {
  return {
    id: 'sealkeeper',
    name: 'SealKeeper',
    description:
      'Reads the model and framework for the SealKeeper fingerprint and adds the session nudge.',
    register,
  };
}

export default sealKeeperPlugin();
