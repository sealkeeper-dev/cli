// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';

// When a terminal prove offers to post a task. Only once the agent has a
// verified task, so the operator has seen the loop work before being asked
// to feed it, and at most once every seven days, whatever the answer. The
// time it last asked is kept in post-prompt.json. prove --post and
// tasks post never depend on it.

export const POST_PROMPT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const PostPromptState = z.strictObject({
  v: z.literal(1),
  askedAt: z.iso.datetime({ offset: true }),
});

// True when prove may ask now. A file that is missing or does not parse
// counts as never asked. An askedAt in the future, from a clock that was
// wrong, is clamped to now and written back, so it waits one interval from
// now and never longer.
export async function mayAskToPost(
  verifiedTasks: number | null,
  now: Date = new Date(),
  p: Paths = paths(),
): Promise<boolean> {
  if (verifiedTasks === null || verifiedTasks < 1) return false;
  let askedAt: number;
  try {
    const state = PostPromptState.safeParse(
      JSON.parse(await readFile(p.postPrompt, 'utf8')),
    );
    if (!state.success) return true;
    askedAt = Date.parse(state.data.askedAt);
  } catch {
    return true;
  }
  if (askedAt > now.getTime()) {
    await recordAskedToPost(now, p);
    return false;
  }
  return now.getTime() - askedAt >= POST_PROMPT_INTERVAL_MS;
}

// Records that prove asked. A failure to write is ignored, the worst case
// is being asked again next time.
export async function recordAskedToPost(
  now: Date = new Date(),
  p: Paths = paths(),
): Promise<void> {
  try {
    await ensureHome(p);
    await writeFileAtomic(
      p.postPrompt,
      `${JSON.stringify({ v: 1, askedAt: now.toISOString() })}\n`,
    );
  } catch {
    // Asked again next time.
  }
}
