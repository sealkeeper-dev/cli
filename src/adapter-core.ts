// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// What the in-process adapters (Mastra, OpenClaw) and the routine share.
import { EventPayload } from '@sealkeeper/schema';
import { skillBody } from './claude-code-skill.js';
import { cli, printedInvocation } from './invocation.js';
import { nudgeLines } from './nudge.js';
import { quietly } from './output.js';

const MAX_MS = EventPayload['session.end'].shape.duration_ms.maxValue ?? 0;

// A duration in whole milliseconds within the range the schema accepts.
export function clampMs(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 0), MAX_MS);
}

// The session nudge (VOU-137) for an in-process adapter, the short
// SealKeeper summary once the operator turned it on, else ''. The agent is
// told to run run --json, which claims only seed tasks unasked. OpenClaw
// and Mastra have no slash commands and no skills, so the summary is
// followed by the sealkeeper skill's body, the loop every core command runs
// and the rules for untrusted specs (VOU-602). It reads the cached goal
// only, so it never waits on the network, and never rejects.
export async function adapterNudge(): Promise<string> {
  try {
    const run = `\`${cli('run --json')}\``;
    const summary = await quietly(() => nudgeLines(run));
    if (summary.length === 0) return '';
    return [...summary, '', skillBody(printedInvocation(), false)].join('\n');
  } catch {
    return '';
  }
}
