// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The Mastra adapter, imported as sealkeeper/mastra. It runs in the agent's own
// process and appends sessions and usage to the local log through emit from
// lib.ts. Tool calls are not recorded. Once automatic sync is on it also
// starts a background sync, at most once every five minutes, see
// background-sync.ts. A failing emit or sync is swallowed so it never throws
// into the agent, and the agent never waits on a sync.
// sealKeeperContext gives the session nudge for the agent's instructions.
// Mastra is typed by shape only, so this file imports nothing from Mastra.
// Types are in types/mastra.d.ts, which mastra-types.test.ts keeps in step.
//
// Before delegating to another agent, gate on its track record.
//   await assertTrusted('alice/claude-code', { minVerified: 5 })
// throws unless every check passes. check() returns the answer instead.
import { createHash, randomUUID } from 'node:crypto';
import { adapterNudge, clampMs, emitQueue } from './adapter-core.js';
import { mastraVersion, toolLine } from './adapter-fingerprint.js';
import {
  type CheckOptions,
  type CheckThresholds,
  describeCheck,
  fetchCheck,
} from './check.js';
import { createObserver } from './fingerprint-observer.js';
import type { EmitInput } from './lib.js';
import { modelNameOf, toolNameOf } from './names.js';
import { quietly } from './output.js';
import type { Check, CheckResponse } from './responses.js';

export type { Check, CheckOptions, CheckResponse, CheckThresholds };

// Anything with an id and, usually, an execute. What createTool returns fits.
export type MastraToolLike = {
  id: string;
  execute?: ((...args: never[]) => unknown) | undefined;
};

export type SealKeeperSession = {
  sessionId: string;
  // Pass to agent.generate or agent.stream as onStepFinish.
  onStepFinish: (step: unknown) => Promise<void>;
  // Emits session.end. Resolves once every event of the session is written.
  end: () => Promise<void>;
};

function elapsed(start: number): number {
  return clampMs(performance.now() - start);
}

// The fingerprint parts this process sees (VB-2). Model ids from steps,
// the names and schemas of every tool passed to withSealKeeper and the
// @mastra/core version. Their hashes are written, and the model id also as
// the model name, in text, see fingerprint-observer.ts.
const observer = createObserver('mastra');
let frameworkLooked = false;

// Once per process, in the background.
function observeFramework(): void {
  if (frameworkLooked) return;
  frameworkLooked = true;
  void quietly(async () => {
    try {
      const version = await mastraVersion();
      if (version !== null) await observer.framework('@mastra/core', version);
    } catch {
      // Left not declared.
    }
  });
}

// Never throws into the agent, a tool that cannot be read is left out.
function observeTools(tools: readonly MastraToolLike[]): void {
  try {
    const lines = new Map<string, string>();
    for (const tool of tools) {
      const name = toolNameOf(tool?.id);
      if (name !== null) lines.set(name, toolLine(name, tool));
    }
    if (lines.size > 0) void observer.tools(lines);
    observeFramework();
  } catch {
    // Left as the last observation.
  }
}

// Hashes the names and schemas of the tools in a record or an array for the
// fingerprint and returns the tools themselves, unchanged. Their calls are
// not recorded. Before 0.4.14 it wrapped each execute to emit tool.call, and
// it keeps its signature so code that calls it keeps working.
export function withSealKeeper<
  T extends Record<string, MastraToolLike> | readonly MastraToolLike[],
>(tools: T): T {
  observeTools(Array.isArray(tools) ? tools : Object.values(tools));
  return tools;
}

// The usage payload of a step, or null when the step has no token counts or
// no model id. Tokens come from usage.promptTokens and usage.completionTokens
// (inputTokens and outputTokens in newer versions). The model is
// response.modelId, else step.model.modelId, through toolNameOf like a
// tool id. Latency is measured locally by
// the session, since the provider timestamp is missing or coarse for some
// providers. emit validates the ranges. Text and tool data are never read.
function usageOf(step: unknown, latencyMs: number): EmitInput | null {
  if (typeof step !== 'object' || step === null) return null;
  const { usage, response, model } = step as {
    usage?: unknown;
    response?: { modelId?: unknown } | null;
    model?: unknown;
  };
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const tokensIn = u.promptTokens ?? u.inputTokens;
  const tokensOut = u.completionTokens ?? u.outputTokens;
  const modelId = modelIdOf(response, model);
  if (
    typeof tokensIn !== 'number' ||
    typeof tokensOut !== 'number' ||
    modelId === null
  ) {
    return null;
  }
  return {
    type: 'usage',
    payload: {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: latencyMs,
      model: modelId,
    },
  };
}

// response.modelId, else step.model.modelId, else step.model, the first
// that gives a name, as it is written.
function rawModelIdOf(response: unknown, model: unknown): unknown {
  return [
    (response as { modelId?: unknown } | null | undefined)?.modelId,
    (model as { modelId?: unknown } | null | undefined)?.modelId,
    model,
  ].find((id) => toolNameOf(id) !== null);
}

// The model id of a step as a name.
function modelIdOf(response: unknown, model: unknown): string | null {
  return toolNameOf(rawModelIdOf(response, model));
}

// The model id of a step for the fingerprint, with or without usage, and
// the model name it gives (modelNameOf).
function stepModel(step: unknown): { id: string; name: string | null } | null {
  if (typeof step !== 'object' || step === null) return null;
  const { response, model } = step as { response?: unknown; model?: unknown };
  const raw = rawModelIdOf(response, model);
  const id = toolNameOf(raw);
  return id === null ? null : { id, name: modelNameOf(raw) };
}

// A session id is kept only when it is a plain id, letters, digits, _ and
// -, at most 64 characters, as a UUID is. Any other id is replaced by its
// sha256, so it still names one session, never fails the event and never
// carries a path or an address into the log.
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

function sessionIdOf(id: string): string {
  return PLAIN_ID.test(id)
    ? id
    : createHash('sha256').update(id, 'utf8').digest('hex');
}

// Starts a session and emits session.start. The id defaults to a new UUID.
// sessionId in the result is the id as logged, see sessionIdOf.
export function sealKeeperSession(
  given: string = randomUUID(),
): SealKeeperSession {
  const sessionId = sessionIdOf(String(given));
  const start = performance.now();
  observeFramework();
  // A step's latency runs from the end of the previous step, or from session
  // creation for the first one.
  let last = start;
  // Events of one session are written in order, one after another.
  const enqueue = emitQueue();
  void enqueue({
    type: 'session.start',
    payload: { session_id: sessionId },
  });

  return {
    sessionId,
    onStepFinish: async (step) => {
      const latencyMs = elapsed(last);
      last = performance.now();
      let input: EmitInput | null = null;
      try {
        input = usageOf(step, latencyMs);
        const seen = stepModel(step);
        // Written only the first time this process sees the id.
        if (seen !== null) void observer.model(seen.id, seen.name);
      } catch {
        // A step that throws when read is skipped.
      }
      if (input) await enqueue(input);
    },
    end: () =>
      enqueue({
        type: 'session.end',
        payload: { session_id: sessionId, duration_ms: elapsed(start) },
      }),
  };
}

// The session nudge (VOU-137). Mastra has no hook that adds context when a
// session starts, but an agent's instructions may be a function that
// Mastra calls for each generate or stream. Call this from it.
//   instructions: async () => `${base}\n${await sealKeeperContext()}`
// Resolves with the short SealKeeper summary and the sealkeeper skill's
// body once the operator turned the nudge on with sealkeeper config nudge
// on, else with ''. It reads the
// cached goal only, so it never waits on the network, and never rejects.
export function sealKeeperContext(): Promise<string> {
  return adapterNudge();
}

// GET /v1/check for handle, as in alice/claude-code. Resolves with the
// answer whether it passed or not. Rejects when the check could not run, a
// bad handle or threshold, an unknown agent or the network. seal in the
// answer is the agent's SEAL, which can be verified offline with sealkeeper
// seal verify, see https://sealkeeper.run/verify. credential is the same
// string under its old name. Both are null when the SEAL is withheld after
// 90 dormant days, and the answer then fails.
export function check(
  handle: string,
  thresholds?: CheckThresholds,
  options?: CheckOptions,
): Promise<CheckResponse> {
  return quietly(() => fetchCheck(handle, thresholds, options));
}

// Thrown by assertTrusted. failed lists the checks that did not pass.
export class SealKeeperCheckError extends Error {
  override name = 'SealKeeperCheckError';
  readonly failed: Check[];
  constructor(readonly result: CheckResponse) {
    const failed = result.checks.filter((c) => !c.ok);
    super(
      [
        `${result.handle} did not pass the SealKeeper check`,
        ...failed.map((check) => describeCheck(check)),
      ].join('\n'),
    );
    this.failed = failed;
  }
}

// Resolves with the answer when every check passed, else throws
// SealKeeperCheckError listing the failing checks.
export async function assertTrusted(
  handle: string,
  thresholds?: CheckThresholds,
  options?: CheckOptions,
): Promise<CheckResponse> {
  const result = await check(handle, thresholds, options);
  if (!result.ok) throw new SealKeeperCheckError(result);
  return result;
}
