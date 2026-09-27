// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// What the in-process adapters (Mastra, OpenClaw) share.
import { EventPayload } from '@sealkeeper/schema';
import { kickBackgroundSync } from './background-sync.js';
import { type EmitInput, emit } from './emit.js';
import { cli } from './invocation.js';
import { nudgeLines } from './nudge.js';
import { quietly } from './output.js';

const MAX_MS = EventPayload['tool.call'].shape.duration_ms.maxValue ?? 0;

// A duration in whole milliseconds within the range the schema accepts.
export function clampMs(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 0), MAX_MS);
}

// Appends one event, then starts a background sync without waiting for
// it. Never throws and never prints, since telemetry must never break or
// clutter the agent.
export function safeEmit(input: EmitInput): Promise<void> {
  return quietly(async () => {
    try {
      await emit(input);
    } catch {
      return;
    }
    kickBackgroundSync();
  });
}

// A queue that writes events one after another, in the order given, so the
// events of one session or plugin land in order. Each call resolves once
// its event, and every event before it, is written. Never rejects.
export function emitQueue(): (input: EmitInput) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (input) => {
    queue = queue.then(() => safeEmit(input));
    return queue;
  };
}

// The session nudge (VOU-137) for an in-process adapter, the short
// SealKeeper summary once the operator turned it on, else ''. The agent is
// told to run prove --json, which claims only seed tasks. It reads the
// cached goal only, so it never waits on the network, and never rejects.
export async function adapterNudge(): Promise<string> {
  try {
    const run = `\`${cli('prove --json')}\``;
    return (await quietly(() => nudgeLines(run))).join('\n');
  } catch {
    return '';
  }
}
