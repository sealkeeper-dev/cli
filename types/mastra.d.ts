// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Types for the Mastra adapter in src/mastra.ts, imported as sealkeeper/mastra.
// Written by hand like lib.d.ts. src/mastra-types.test.ts fails the
// typecheck if these drift from the source.

// Anything with an id and, usually, an execute. What createTool returns fits.
export type MastraToolLike = {
  id: string;
  execute?: ((...args: never[]) => unknown) | undefined;
};

// A session writes no event since 0.5.0. Only a routine run records a
// session and its usage.
export type SealKeeperSession = {
  // The id given when it is a plain id (letters, digits, _ and -, at most
  // 64), else its sha256.
  sessionId: string;
  // Pass to agent.generate or agent.stream as onStepFinish. It hashes the
  // step's model id for the fingerprint.
  onStepFinish: (step: unknown) => Promise<void>;
  // Records nothing and resolves at once.
  end: () => Promise<void>;
};

// Hashes the names and schemas of the tools in a record or an array for the
// fingerprint in fingerprint-sources.json and returns the tools themselves,
// unchanged. Their calls are not recorded. The model ids of steps are hashed
// the same way. Only the hashes are kept.
export declare function withSealKeeper<
  T extends Record<string, MastraToolLike> | readonly MastraToolLike[],
>(tools: T): T;

// A session for the fingerprint, which writes no event. The id defaults to
// a new UUID.
export declare function sealKeeperSession(
  sessionId?: string,
): SealKeeperSession;

// The short SealKeeper summary and the sealkeeper skill's body for the
// agent's instructions, once the operator turned the nudge on with
// sealkeeper config nudge on, else ''.
// Reads the cached goal only and never rejects.
export declare function sealKeeperContext(): Promise<string>;

// Every value optional. The API defaults minVerified to 1 and maxIncidents
// to 0. minReliability and minSafety (0 to 1) and minLevel are checked only
// when given.
export type CheckThresholds = {
  minVerified?: number | undefined;
  maxIncidents?: number | undefined;
  minReliability?: number | undefined;
  minSafety?: number | undefined;
  // Bronze when left out. none asks for no level. These are the levels
  // issued today. Platinum is reserved and joins them when it is issued.
  minLevel?: 'none' | 'bronze' | 'silver' | 'gold' | undefined;
};

export type CheckOptions = {
  // Defaults to SEALKEEPER_API_URL, then https://api.sealkeeper.run.
  apiUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
};

// One check. min checks pass when actual >= required, max checks when
// actual <= required. actual is null when the agent has no value yet, and a
// null never passes. minLevel compares levels by rank, none lowest, with
// the level in the SEAL as actual. seal is sent only when
// the SEAL is withheld after 90 dormant days, required present and actual
// withheld, and fails. The names today are seal, minVerified,
// maxIncidents, minReliability, minSafety and minLevel. name
// and the levels are typed as text so a check or level the API adds later
// still reads.
export type Check = {
  name: string;
  required: number | string;
  actual: number | string | null;
  ok: boolean;
};

// ok is true only when every check passed. seal is the agent's current
// SEAL, to verify offline with the SealKeeper public key. credential is the
// same string under its old name, kept for one release. Both are null when
// the SEAL is withheld, and ok is then false.
export type CheckResponse = {
  ok: boolean;
  id: string;
  handle: string;
  checks: Check[];
  seal: string | null;
  credential: string | null;
};

// Checks the agent at handle, as in alice/claude-code, against the
// thresholds and resolves with the answer, passed or not. Rejects when the
// check could not run, for a bad handle or threshold, an unknown agent or
// a network failure.
export declare function check(
  handle: string,
  thresholds?: CheckThresholds,
  options?: CheckOptions,
): Promise<CheckResponse>;

// Thrown by assertTrusted. The message lists the failing checks.
export declare class SealKeeperCheckError extends Error {
  readonly result: CheckResponse;
  readonly failed: Check[];
  constructor(result: CheckResponse);
}

// Resolves with the answer when every check passed, else throws
// SealKeeperCheckError. Use it right before delegating.
export declare function assertTrusted(
  handle: string,
  thresholds?: CheckThresholds,
  options?: CheckOptions,
): Promise<CheckResponse>;

// What routine passes to agent.generate. toolChoice none turns tool use
// off, with no active tool and one step.
export type MastraGenerateOptions = {
  toolChoice: 'none';
  activeTools: string[];
  maxSteps: number;
  abortSignal: AbortSignal;
};

// Anything with a generate that takes a prompt and options. A Mastra Agent
// fits. The result is read loosely, text, usage and toolCalls.
export type MastraAgentLike = {
  generate(prompt: string, options: MastraGenerateOptions): Promise<unknown>;
};

// What routine takes besides the agent. signal stops the run at its next
// safe point, as its limits do.
export type RoutineOptions = {
  signal?: AbortSignal | undefined;
};

// What one routine run did. outcome is done, nothing, stopped, failed,
// skipped or aborted, and failure names what failed. Typed as text so a
// value a newer CLI adds still reads.
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

// One daily routine run with agent, for the agent set up under
// SEALKEEPER_HOME (default ~/.sealkeeper), the same loop as sealkeeper
// routine run. Call it from a Mastra scheduled workflow or your own cron.
// SealKeeper decides every step, and agent answers each task through one
// generate call with no tools. Resolves with what the run did, a failed
// run included. Rejects only when no agent is set up here or routine.json
// does not read. It never prints. When options.signal aborts, a wait for
// SealKeeper ends at once, a generate in flight gets the abort, no new
// step is asked, a task the run holds goes back as at its time limit, and
// the run resolves with outcome aborted. A signal already aborted starts
// no run.
export declare function routine(
  agent: MastraAgentLike,
  options?: RoutineOptions,
): Promise<RoutineRunResult>;
