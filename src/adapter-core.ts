// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// What the in-process adapters (Mastra, OpenClaw) share.
import { EventPayload } from '@sealkeeper/schema';
import { kickBackgroundSync } from './background-sync.js';
import { type EmitInput, emit } from './emit.js';
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
