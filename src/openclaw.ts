// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The OpenClaw adapter, imported as sealkeeper/openclaw. OpenClaw loads plugins
// into the Gateway process and calls register(api) once, where the plugin
// subscribes to typed hooks with api.on(name, handler). This file is such a
// plugin entry. It appends to the local log through emit from lib.ts and,
// once automatic sync is on, starts a background sync at most once every
// five minutes (background-sync.ts). It swallows every failure so it never
// throws into the agent, and the agent never waits on a sync.
//
// OpenClaw is typed by shape only, so this file imports nothing from it. The
// hook names and fields match OpenClaw's source (src/plugins/hook-types.ts
// and the plugin loader) at openclaw/openclaw main cbcd4df, version
// 2026.9.6, where the built plugin was also run through OpenClaw's own
// registration and hook runner. It has not yet run inside a live Gateway.
// Types are in types/openclaw.d.ts, which openclaw-types.test.ts keeps in
// step.
import { EventPayload } from '@sealkeeper/schema';
import { clampMs, safeEmit } from './adapter-core.js';
import { cli } from './invocation.js';
import type { EmitInput } from './lib.js';
import { toolNameOf } from './names.js';
import { nudgeLines } from './nudge.js';
import { quietly } from './output.js';

// Limits come from the schema, so this file keeps no copy of them.
const NAME = EventPayload['session.start'].shape.session_id;

// Open sessions, tool calls and runs are held in memory until they end. A
// Gateway runs for weeks, so each map drops its oldest entry past this size.
const MAX_OPEN = 10_000;

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

function since(start: number): number {
  return clampMs(performance.now() - start);
}

// A duration OpenClaw reported, or null when it is missing or not a number.
function msOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampMs(value)
    : null;
}

// Session and run ids are used as they are when they fit the taxonomy, and
// dropped otherwise, so two different ids never merge into one.
function idOf(value: unknown): string | null {
  return NAME.safeParse(value).success ? (value as string) : null;
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// A Map that forgets its oldest entry once it holds MAX_OPEN.
function bounded<V>(): Map<string, V> & { put: (k: string, v: V) => void } {
  const map = new Map<string, V>() as Map<string, V> & {
    put: (k: string, v: V) => void;
  };
  map.put = (key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_OPEN) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  };
  return map;
}

// Wires the hooks. Every handler reads only names, ids, durations and
// counts. Tool params and results, prompts, messages and model output are
// never read, logged or emitted.
function register(api: OpenClawPluginApiLike): void {
  const sessions = bounded<number>();
  const tools = bounded<number>();
  // Model time per run since its last llm_output, from model_call_ended.
  const runs = bounded<number>();

  // Events are written in order, one after another.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (input: EmitInput): Promise<void> => {
    queue = queue.then(() => safeEmit(input));
    return queue;
  };

  registerNudge(api);

  // A handler that throws when reading a hostile event is skipped quietly.
  // OpenClaw refuses some hooks by policy, llm_output without conversation
  // access for one, so a refused registration leaves the others in place.
  const on = (
    name: string,
    handle: (event: unknown, ctx: unknown) => EmitInput | null,
  ) => {
    try {
      api.on(name, (event: unknown, ctx: unknown) => {
        let input: EmitInput | null = null;
        try {
          input = handle(event, ctx);
        } catch {
          return undefined;
        }
        return input ? enqueue(input) : undefined;
      });
    } catch {
      // The rest of the hooks still register.
    }
  };

  // A resumed or reset session gets a new id from OpenClaw, so it is a new
  // session here too. A session_start repeated for an id already open is
  // ignored, so it stays one session.
  on('session_start', (event, ctx) => {
    const id = idOf(field(event, 'sessionId') ?? field(ctx, 'sessionId'));
    if (id === null || sessions.has(id)) return null;
    sessions.put(id, performance.now());
    return { type: 'session.start', payload: { session_id: id } };
  });

  // Only a session this plugin saw start is closed, so a Gateway restart
  // does not emit an end without a start.
  on('session_end', (event, ctx) => {
    const id = idOf(field(event, 'sessionId') ?? field(ctx, 'sessionId'));
    if (id === null) return null;
    const start = sessions.get(id);
    if (start === undefined) return null;
    sessions.delete(id);
    return {
      type: 'session.end',
      payload: {
        session_id: id,
        duration_ms: msOf(field(event, 'durationMs')) ?? since(start),
      },
    };
  });

  // Only notes when the call began, for an after_tool_call without its own
  // duration. It returns nothing, so it never changes or blocks the call.
  on('before_tool_call', (event, ctx) => {
    const id = idOf(field(event, 'toolCallId') ?? field(ctx, 'toolCallId'));
    if (id !== null) tools.put(id, performance.now());
    return null;
  });

  // The error is a message, so only whether it is set is looked at. It is
  // never emitted, and no error class is sent for OpenClaw.
  on('after_tool_call', (event, ctx) => {
    const tool = toolNameOf(field(event, 'toolName'));
    const id = idOf(field(event, 'toolCallId') ?? field(ctx, 'toolCallId'));
    const started = id === null ? undefined : tools.get(id);
    if (id !== null) tools.delete(id);
    if (tool === null) return null;
    const error = field(event, 'error');
    return {
      type: 'tool.call',
      payload: {
        tool,
        duration_ms:
          msOf(field(event, 'durationMs')) ??
          (started === undefined ? 0 : since(started)),
        ok: !(typeof error === 'string' && error.length > 0),
      },
    };
  });

  // Sums the model time of a run. llm_output reports tokens per attempt,
  // which can span several model calls.
  on('model_call_ended', (event, ctx) => {
    const run = idOf(field(event, 'runId') ?? field(ctx, 'runId'));
    const ms = msOf(field(event, 'durationMs'));
    if (run === null || ms === null) return null;
    runs.put(run, clampMs((runs.get(run) ?? 0) + ms));
    return null;
  });

  // OpenClaw only delivers llm_output to a plugin that was granted
  // conversation access. Without it there is no usage, and cost and latency
  // stay null. From the event only usage, model and runId are read. Without
  // a model time for the run nothing is recorded, rather than a latency of 0.
  on('llm_output', (event, ctx) => {
    const run = idOf(field(event, 'runId') ?? field(ctx, 'runId'));
    if (run === null) return null;
    const latency = runs.get(run);
    runs.delete(run);
    const usage = field(event, 'usage');
    const tokensIn = countOf(field(usage, 'input'));
    const tokensOut = countOf(field(usage, 'output'));
    const model = toolNameOf(field(event, 'model'));
    if (
      latency === undefined ||
      tokensIn === null ||
      tokensOut === null ||
      model === null
    ) {
      return null;
    }
    return {
      type: 'usage',
      payload: {
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        latency_ms: latency,
        model,
      },
    };
  });
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
// the prompt as it was. The agent is told to run prove --json, which
// claims only seed tasks.

function registerNudge(api: OpenClawPluginApiLike): void {
  try {
    api.on('before_prompt_build', async () => {
      try {
        const run = `\`${cli('prove --json')}\``;
        const lines = await quietly(() => nudgeLines(run));
        return lines.length > 0
          ? { appendSystemContext: lines.join('\n') }
          : undefined;
      } catch {
        return undefined;
      }
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
      'Records session, tool call and usage metadata in the local SealKeeper log.',
    register,
  };
}

export default sealKeeperPlugin();
