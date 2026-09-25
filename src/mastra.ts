// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// The Mastra adapter, imported as sealkeeper/mastra. It runs in the agent's own
// process and appends to the local log through emit from lib.ts. Once
// automatic sync is on it also starts a background sync, at most once every
// five minutes, see background-sync.ts. A failing emit or sync is swallowed
// so it never throws into the agent, and the agent never waits on a sync.
// Mastra is typed by shape only, so this file imports nothing from Mastra.
// Types are in types/mastra.d.ts, which mastra-types.test.ts keeps in step.
//
// Before delegating to another agent, gate on its track record.
//   await assertTrusted('carelmeyer/claude-code', { minVerified: 5 })
// throws unless every check passes. check() returns the answer instead.
import { randomUUID } from 'node:crypto';
import { EventPayload } from '@sealkeeper/schema';
import { clampMs, safeEmit } from './adapter-core.js';
import {
  type CheckOptions,
  type CheckThresholds,
  describeCheck,
  fetchCheck,
} from './check.js';
import type { EmitInput } from './lib.js';
import type { Check, CheckResponse } from './responses.js';

export type { Check, CheckOptions, CheckResponse, CheckThresholds };

// Limits come from the schema, so this file keeps no copy of them.
const TOOL_CALL = EventPayload['tool.call'].shape;

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

function errorClass(error: unknown): string {
  const name = (error as { constructor?: { name?: unknown } } | null)
    ?.constructor?.name;
  return TOOL_CALL.tool.safeParse(name).success ? (name as string) : 'Unknown';
}

function wrapTool<T extends MastraToolLike>(tool: T): T {
  const execute = tool.execute;
  if (typeof execute !== 'function') return tool;
  const id = tool.id;
  // Arguments and results pass straight through and are never read, logged or emitted.
  async function wrapped(this: unknown, ...args: never[]): Promise<unknown> {
    const start = performance.now();
    try {
      const result = await execute?.apply(this, args);
      await safeEmit({
        type: 'tool.call',
        payload: { tool: id, duration_ms: elapsed(start), ok: true },
      });
      return result;
    } catch (error) {
      await safeEmit({
        type: 'tool.call',
        payload: {
          tool: id,
          duration_ms: elapsed(start),
          ok: false,
          error_class: errorClass(error),
        },
      });
      throw error;
    }
  }
  // A copy with the same prototype, so the caller's tool is left untouched.
  const copy = Object.create(Object.getPrototypeOf(tool)) as T;
  return Object.assign(copy, tool, { execute: wrapped });
}

// Wraps the execute of every tool in a record or an array and returns the
// same shape. Tools without an execute are returned as they are.
export function withSealKeeper<
  T extends Record<string, MastraToolLike> | readonly MastraToolLike[],
>(tools: T): T {
  if (Array.isArray(tools)) {
    return tools.map((tool: MastraToolLike) => wrapTool(tool)) as never;
  }
  const out: Record<string, MastraToolLike> = {};
  for (const [key, tool] of Object.entries(tools)) out[key] = wrapTool(tool);
  return out as T;
}

function modelOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// The usage payload of a step, or null when the step has no token counts or
// no model id. Tokens come from usage.promptTokens and usage.completionTokens
// (inputTokens and outputTokens in newer versions). The model is
// response.modelId, else step.model.modelId. Latency is measured locally by
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
  const modelId =
    modelOf(response?.modelId) ??
    modelOf((model as { modelId?: unknown } | null | undefined)?.modelId) ??
    modelOf(model);
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

// Starts a session and emits session.start. The id defaults to a new UUID.
export function sealKeeperSession(
  sessionId: string = randomUUID(),
): SealKeeperSession {
  const start = performance.now();
  // A step's latency runs from the end of the previous step, or from session
  // creation for the first one.
  let last = start;
  // Events of one session are written in order, one after another.
  let queue = safeEmit({
    type: 'session.start',
    payload: { session_id: sessionId },
  });
  const enqueue = (input: EmitInput): Promise<void> => {
    queue = queue.then(() => safeEmit(input));
    return queue;
  };

  return {
    sessionId,
    onStepFinish: async (step) => {
      const latencyMs = elapsed(last);
      last = performance.now();
      let input: EmitInput | null = null;
      try {
        input = usageOf(step, latencyMs);
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

// GET /v1/check for handle, as in carelmeyer/claude-code. Resolves with the
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
  return fetchCheck(handle, thresholds, options);
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
        ...failed.map(describeCheck),
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
