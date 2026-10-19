// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The Mastra adapter, imported as sealkeeper/mastra. It runs in the agent's own
// process and writes no event. Only a routine run, routine(agent) below,
// records a session and its usage. withSealKeeper and sealKeeperSession read
// the fingerprint parts this process sees, the tools, the framework and the
// model of each step, and keep the shapes earlier versions had. The
// instructions text passed to withSealKeeper or routine gives the prompt
// part. A failure is
// swallowed so it never throws into the agent. sealKeeperContext gives the
// session nudge for the agent's instructions. Mastra is typed by shape only, so
// this file imports nothing from Mastra. Types are in types/mastra.d.ts, which
// mastra-types.test.ts keeps in step.
//
// Before delegating to another agent, gate on its track record.
//
//   await assertTrusted('alice/claude-code', { minVerified: 5 })
//
// throws unless every check passes. check() returns the answer instead.
//
// routine(agent) runs one daily routine run with the agent, the same loop as
// sealkeeper routine run, see routine-mastra.ts.
import { createHash, randomUUID } from 'node:crypto';
import { adapterNudge } from './adapter-core.js';
import {
  mastraVersion,
  rawModelIdOf,
  toolLine,
} from './adapter-fingerprint.js';
import {
  type CheckOptions,
  type CheckThresholds,
  describeCheck,
  fetchCheck,
} from './check.js';
import { createObserver } from './fingerprint-observer.js';
import { modelNameOf, toolNameOf } from './names.js';
import { quietly } from './output.js';
import type { Check, CheckResponse } from './responses.js';
import {
  type MastraAgentLike,
  type MastraGenerateOptions,
  mastraRoutine,
  type RoutineOptions,
  type RoutineRunResult,
} from './routine-mastra.js';

export type {
  Check,
  CheckOptions,
  CheckResponse,
  CheckThresholds,
  MastraAgentLike,
  MastraGenerateOptions,
  RoutineOptions,
  RoutineRunResult,
};

// Anything with an id and, usually, an execute. What createTool returns fits.
export type MastraToolLike = {
  id: string;
  execute?: ((...args: never[]) => unknown) | undefined;
};

export type SealKeeperSession = {
  sessionId: string;
  // Pass to agent.generate or agent.stream as onStepFinish. It reads the
  // step's model id for the fingerprint.
  onStepFinish: (step: unknown) => Promise<void>;
  // Records nothing and resolves at once.
  end: () => Promise<void>;
};

// The fingerprint parts this process sees. Model ids from steps, the names and
// schemas of every tool passed to withSealKeeper, the instructions text passed
// to it or to routine and the @mastra/core version. Their hashes are written, and the model id also as the model name, in text,
// see fingerprint-observer.ts.
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

// What withSealKeeper and routine take for the prompt part. instructions is
// the agent's instructions as text, the string given to the Agent, or the
// fixed text an instructions function builds on. The adapter never reads the
// agent's own instructions, since Mastra may hold a function there, and never
// calls one, so the part is not declared until text is passed here. Once
// written the hash is kept, as the tools are, until a later process passes
// other text or the source ages out. Only a hash of the text is kept.
export type InstructionsOption = {
  instructions?: string | undefined;
};

// The prompt part from the text given, written only for a new text. A value
// that is not text, a function among them, is ignored and never called.
// Never throws into the agent.
function observeInstructions(
  options: InstructionsOption | undefined,
): Promise<void> {
  try {
    const text = options?.instructions;
    if (typeof text === 'string' && text.trim() !== '') {
      return observer.prompt(text);
    }
  } catch {
    // Left as the last observation.
  }
  return Promise.resolve();
}

// Hashes the names and schemas of the tools in a record or an array for the
// fingerprint and returns the tools themselves, unchanged. Their calls are not
// recorded. options.instructions gives the prompt part.
export function withSealKeeper<
  T extends Record<string, MastraToolLike> | readonly MastraToolLike[],
>(tools: T, options?: InstructionsOption): T {
  observeTools(Array.isArray(tools) ? tools : Object.values(tools));
  void observeInstructions(options);
  return tools;
}

// The model id of a step for the fingerprint, and the model name it gives
// (modelNameOf).
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

// A session for the fingerprint. It reads the model id of each step and writes
// no event. The id defaults to a new UUID. sessionId in the result is the id as
// sessionIdOf makes it.
export function sealKeeperSession(
  given: string = randomUUID(),
): SealKeeperSession {
  const sessionId = sessionIdOf(String(given));
  observeFramework();
  return {
    sessionId,
    onStepFinish: async (step) => {
      try {
        const seen = stepModel(step);
        // Written only the first time this process sees the id.
        if (seen !== null) void observer.model(seen.id, seen.name);
      } catch {
        // A step that throws when read is skipped.
      }
    },
    end: async () => {},
  };
}

// The session nudge. Mastra has no hook that adds context when a session
// starts, but an agent's instructions may be a function that Mastra calls for
// each generate or stream. Call this from it.
//
//   instructions: async () => `${base}\n${await sealKeeperContext()}`
//
// Resolves with the short SealKeeper summary and the sealkeeper skill's body
// once the operator turned the nudge on with sealkeeper config nudge on, else
// with ''. It reads the cached goal only, so it never waits on the network, and
// never rejects.
export function sealKeeperContext(): Promise<string> {
  return adapterNudge();
}

// GET /v1/check for handle, as in alice/claude-code. Resolves with the answer
// whether it passed or not. Rejects when the check could not run, a bad handle
// or threshold, an unknown agent or the network. seal in the answer is the
// agent's SEAL, which can be verified offline with sealkeeper seal verify, see
// https://sealkeeper.run/verify. credential is the same string under its old
// name. Both are null when the SEAL is withheld, and the answer then fails.
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

// One routine run with agent, for the agent set up under SEALKEEPER_HOME. Call
// it from a Mastra scheduled workflow or your own cron. SealKeeper decides
// every step, and agent answers each task through one generate call with no
// tools. Resolves with what the run did, a failed run included, and rejects
// only when no agent is set up here or routine.json does not read. It never
// prints. options.signal stops the run at its next safe point, and it then
// resolves with outcome aborted. options.instructions gives the prompt part, as
// withSealKeeper takes it, written before the run computes the fingerprint at
// its start. The routine's own questions are never part of it.
export function routine(
  agent: MastraAgentLike,
  options?: RoutineOptions,
): Promise<RoutineRunResult> {
  return quietly(async () => {
    await observeInstructions(options);
    return mastraRoutine(agent, options);
  });
}
