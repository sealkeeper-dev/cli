// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { rawModelIdOf } from './adapter-fingerprint.js';
import { paths, readConfig, readRoutineConfig } from './config.js';
import type {
  AgentProblem,
  AgentResult,
  AgentRuntime,
} from './routine-agent.js';
import { routineRun } from './routine-run.js';

// Mastra as a routine runtime (VOU-601). Mastra has no CLI, so the routine
// runs in the operator's own process, routine(agent) from sealkeeper/mastra,
// which the operator schedules with a Mastra scheduled workflow or a cron
// of their own. It is the same loop as sealkeeper routine run, with the
// same routine.json, run log and lock, and each question is one
// agent.generate call. Mastra is typed by shape only.
//
// No tools. Each call passes toolChoice none, the documented way to turn
// tool use off for one generate, with activeTools empty and maxSteps 1 so
// no tool step can follow. https://mastra.ai/reference/agents/generate
// The answer from a call whose result still reports a tool call is
// dropped and fails the run.

// What routine passes to agent.generate.
export type MastraGenerateOptions = {
  toolChoice: 'none';
  activeTools: string[];
  maxSteps: number;
  abortSignal: AbortSignal;
};

// Anything with a generate that takes a prompt and options. A Mastra Agent
// fits. The result is read loosely, text, usage, toolCalls and the model id.
export type MastraAgentLike = {
  generate(prompt: string, options: MastraGenerateOptions): Promise<unknown>;
};

// What routine takes besides the agent. signal stops the run at its next
// safe point, as its limits do (VOU-620).
export type RoutineOptions = {
  signal?: AbortSignal | undefined;
};

// What one routine run did, its run line in routine.jsonl in short.
// outcome is done, nothing, stopped, failed, skipped or aborted, and
// failure names what failed. A string, so a value a newer CLI adds still
// types.
export type RoutineRunResult = {
  runId: string;
  outcome: string;
  reason: string | null;
  failure: string | null;
  claimed: number;
  submitted: number;
  verified: number;
  posted: number;
  confirmed: number;
  duels: number;
  challenge: number;
  tokens: number | null;
};

// One routine run with agent, for the agent set up under SEALKEEPER_HOME
// (default ~/.sealkeeper). Resolves with what the run did, failed and
// aborted runs included. Rejects only when no agent is set up or
// routine.json does not read. Prints nothing.
export async function mastraRoutine(
  agent: MastraAgentLike,
  options: RoutineOptions = {},
): Promise<RoutineRunResult> {
  const { signal } = options;
  const p = paths();
  const config = await readConfig(p);
  if (config === null) {
    throw new Error('no SealKeeper agent is set up here, run sealkeeper init');
  }
  const routine = await readRoutineConfig(p);
  const entry = await routineRun(
    { fetch: (...args) => fetch(...args), signal },
    config,
    routine,
    {
      runtime: 'mastra',
      start: () => ({ agent: mastraRuntime(agent, signal) }),
    },
    p,
    randomUUID(),
  );
  return {
    runId: entry.runId,
    outcome: entry.outcome,
    reason: entry.reason ?? null,
    failure: entry.failure ?? null,
    claimed: entry.claimed,
    submitted: entry.submitted,
    verified: entry.verified ?? 0,
    posted: entry.posted ?? 0,
    confirmed: entry.confirmed,
    duels: entry.duels ?? 0,
    challenge: entry.challenge ?? 0,
    tokens: entry.tokens,
  };
}

// One question is one generate, aborted at what is left of the wall clock
// or when the caller's signal aborts, whichever comes first. An agent that
// ignores the abort is no longer waited for. A signal already aborted
// starts no generate.
export function mastraRuntime(
  agent: MastraAgentLike,
  signal?: AbortSignal,
): AgentRuntime {
  return {
    name: 'mastra',
    async ask(question): Promise<AgentResult> {
      if (signal?.aborted) return stopped('caller');
      const controller = new AbortController();
      let stoppedFor: Stop = 'minutesPerRun';
      const end = (why: Stop) => {
        if (controller.signal.aborted) return;
        stoppedFor = why;
        controller.abort();
      };
      const stop = new Promise<'stop'>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve('stop'), {
          once: true,
        });
      });
      const timer = setTimeout(() => end('minutesPerRun'), question.timeoutMs);
      const onAbort = () => end('caller');
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await Promise.race([
          agent.generate(question.prompt, {
            toolChoice: 'none',
            activeTools: [],
            maxSteps: 1,
            abortSignal: controller.signal,
          }),
          stop,
        ]);
        if (result === 'stop') return stopped(stoppedFor);
        return resultOf(result);
      } catch (error) {
        if (controller.signal.aborted) return stopped(stoppedFor);
        return { ...empty(), exitCode: 1, problem: failureOf(error) };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

type Stop = 'minutesPerRun' | 'caller';

const empty = (): AgentResult => ({
  text: null,
  exitCode: 0,
  stoppedFor: null,
  tokens: null,
  costUsd: null,
});

const stopped = (stoppedFor: Stop): AgentResult => ({
  ...empty(),
  exitCode: null,
  stoppedFor,
});

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;

// text, usage, toolCalls and the model id of a generate result, read
// loosely. Tokens are totalTokens, else input and output, in either naming
// Mastra has used. The model id as the live adapter reads a step's,
// response.modelId first (rawModelIdOf).
function resultOf(value: unknown): AgentResult {
  const result = record(value);
  const raw = rawModelIdOf(result?.response, result?.model);
  const model = typeof raw === 'string' ? { model: raw } : {};
  const usage = record(result?.usage);
  const input = num(usage?.inputTokens) ?? num(usage?.promptTokens);
  const output = num(usage?.outputTokens) ?? num(usage?.completionTokens);
  const tokens =
    num(usage?.totalTokens) ??
    (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  const calls = Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0;
  if (calls > 0) {
    return {
      ...empty(),
      ...model,
      tokens,
      exitCode: 1,
      problem: {
        kind: 'tools',
        reason:
          'the Mastra agent reported a tool call, which the routine never allows, so its answer was dropped',
      },
    };
  }
  const text =
    typeof result?.text === 'string' && result.text.trim() !== ''
      ? result.text
      : null;
  return { ...empty(), ...model, text, tokens };
}

// A provider credential that is missing or refused, by the status or the
// message of the error. The message is only matched, never kept, as a
// provider's message may hold part of the key.
const AUTH = /auth|credential|api[ _-]?key|unauthori[sz]ed|forbidden/i;
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function failureOf(error: unknown): AgentProblem {
  const e = record(error);
  const status = num(e?.status) ?? num(e?.statusCode);
  const message = typeof e?.message === 'string' ? e.message : '';
  if (status === 401 || status === 403 || AUTH.test(message)) {
    return {
      kind: 'auth',
      reason: "the Mastra agent's model refused its provider credential",
    };
  }
  const name = typeof e?.name === 'string' && PLAIN_NAME.test(e.name);
  return {
    kind: 'failed',
    reason: `agent.generate failed${name ? `, ${e?.name as string}` : ''}`,
  };
}
