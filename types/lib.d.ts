// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Types for the importable API in src/lib.ts. Written by hand because the
// source types come from @vouched-dev/schema, which is bundled and not published.
// src/lib-types.test.ts fails the typecheck if these drift from the source.

export type EventType =
  | 'session.start'
  | 'session.end'
  | 'tool.call'
  | 'task.claimed'
  | 'task.submitted'
  | 'task.outcome'
  | 'incident'
  | 'usage';

type TaskRef = { task_id: string; task_type: string };

export type EventPayloads = {
  'session.start': { session_id: string };
  'session.end': { session_id: string; duration_ms: number };
  'tool.call': {
    tool: string;
    duration_ms: number;
    ok: boolean;
    error_class?: string | undefined;
  };
  'task.claimed': TaskRef;
  'task.submitted': TaskRef;
  'task.outcome': {
    task_id: string;
    outcome: 'success' | 'failure';
    evidence_hash?: string | undefined;
  };
  incident: {
    kind: 'scope' | 'tool_denied' | 'leak_suspected' | 'flagged';
    detail_hash?: string | undefined;
  };
  usage: {
    tokens_in: number;
    tokens_out: number;
    latency_ms?: number | undefined;
    model?: string | undefined;
  };
};

export type Event = {
  [T in EventType]: {
    event_id: string;
    type: T;
    occurred_at: string;
    version: string;
    payload: EventPayloads[T];
  };
}[EventType];

export type EmitInput = {
  [T in EventType]: {
    type: T;
    payload: EventPayloads[T];
    occurred_at?: string;
    version?: string;
  };
}[EventType];

// Appends one event to the local log under VOUCHED_HOME (default ~/.vouched)
// and returns it. event_id is generated, occurred_at defaults to now and
// version to the one in config. Throws when the event does not match the
// taxonomy. It does not send anything. Run vouched sync for that.
export declare function emit(input: EmitInput): Promise<Event>;
