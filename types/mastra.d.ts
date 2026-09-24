// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Types for the Mastra adapter in src/mastra.ts, imported as vouched/mastra.
// Written by hand like lib.d.ts. src/mastra-types.test.ts fails the
// typecheck if these drift from the source.

// Anything with an id and, usually, an execute. What createTool returns fits.
export type MastraToolLike = {
  id: string;
  execute?: ((...args: never[]) => unknown) | undefined;
};

export type WithVouchedOptions = {
  // Reserved to attribute tool calls to a competence dimension. Not stored yet.
  taskType?: string | undefined;
};

export type VouchedSession = {
  sessionId: string;
  // Pass to agent.generate or agent.stream as onStepFinish.
  onStepFinish: (step: unknown) => Promise<void>;
  // Emits session.end. Resolves once every event of the session is written.
  end: () => Promise<void>;
};

// Wraps the execute of every tool in a record or an array and returns the
// same shape. Each call emits tool.call with the tool id, duration and
// outcome. Arguments and results are never read. Errors are rethrown.
export declare function withVouched<
  T extends Record<string, MastraToolLike> | readonly MastraToolLike[],
>(tools: T, options?: WithVouchedOptions): T;

// Starts a session and emits session.start. The id defaults to a new UUID.
export declare function vouchedSession(sessionId?: string): VouchedSession;

// Every value optional. The API defaults minVerified to 1 and maxIncidents
// to 0. minReliability and minSafety (0 to 1) and minLevel are checked only
// when given.
export type CheckThresholds = {
  minVerified?: number | undefined;
  maxIncidents?: number | undefined;
  minReliability?: number | undefined;
  minSafety?: number | undefined;
  minLevel?: 'none' | 'bronze' | 'silver' | 'gold' | undefined;
};

export type CheckOptions = {
  // Defaults to VOUCHED_API_URL, then https://api.vouched.run.
  apiUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
};

// One check. min checks pass when actual >= required, max checks when
// actual <= required. actual is null when the agent has no value yet, and a
// null never passes. minLevel compares levels, none below bronze, silver
// and gold, with the level in the SEAL as actual.
export type Check = {
  name:
    | 'minVerified'
    | 'maxIncidents'
    | 'minReliability'
    | 'minSafety'
    | 'minLevel';
  required: number | 'none' | 'bronze' | 'silver' | 'gold';
  actual: number | 'none' | 'bronze' | 'silver' | 'gold' | null;
  ok: boolean;
};

// ok is true only when every check passed. credential is the agent's
// current SEAL, to verify offline with the Vouched public key.
export type CheckResponse = {
  ok: boolean;
  id: string;
  handle: string;
  checks: Check[];
  credential: string;
};

// Checks the agent at handle, as in carelmeyer/claude-code, against the
// thresholds and resolves with the answer, passed or not. Rejects when the
// check could not run, for a bad handle or threshold, an unknown agent or
// a network failure.
export declare function check(
  handle: string,
  thresholds?: CheckThresholds,
  options?: CheckOptions,
): Promise<CheckResponse>;

// Thrown by assertTrusted. The message lists the failing checks.
export declare class VouchedCheckError extends Error {
  readonly result: CheckResponse;
  readonly failed: Check[];
  constructor(result: CheckResponse);
}

// Resolves with the answer when every check passed, else throws
// VouchedCheckError. Use it right before delegating.
export declare function assertTrusted(
  handle: string,
  thresholds?: CheckThresholds,
  options?: CheckOptions,
): Promise<CheckResponse>;
