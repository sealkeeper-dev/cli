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
