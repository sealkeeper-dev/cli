// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { specAsksFinalLineFeed } from './line-break.js';

// What submit needs of a duel or challenge task's spec (VOU-635). SealKeeper
// shows that spec only in the answer that hands the task over, a claim,
// run, duel, challenge or routine step, and every read after it, GET
// /v1/tasks/:id included, shows {}. So when a game task is handed over, the
// CLI keeps here whether its spec asks the answer to end in a line feed,
// read from that spec by specAsksFinalLineFeed, and submit reads it back.
// Only that bit is kept, never the spec, and only until the task expires.
// The newest MAX_KEPT tasks are kept, more than the claims an agent can
// hold, so the file never grows past that. Beside it, how often the routine
// asked its model again for the task because the answer it kept failed a
// check before submit (takeAskAgain), so those asks stay capped across runs.

const MAX_KEPT = 100;

const Kept = z.object({
  id: z.uuid(),
  finalLineFeed: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }),
  asksAgain: z.number().int().min(0).optional(),
});
type Kept = z.infer<typeof Kept>;

const HandedFile = z.object({ v: z.literal(1), tasks: z.array(Kept) });

// A game task as it was handed over, with the spec its claimant sees.
export type HandedTask = {
  id: string;
  spec: Record<string, unknown>;
  expiresAt: string;
};

async function readKept(p: Paths): Promise<Kept[]> {
  try {
    const parsed = HandedFile.safeParse(
      JSON.parse(await readFile(p.handed, 'utf8')),
    );
    return parsed.success ? parsed.data.tasks : [];
  } catch {
    return [];
  }
}

async function writeKept(tasks: Kept[], p: Paths): Promise<void> {
  await ensureHome(p);
  await writeFileAtomic(p.handed, `${JSON.stringify({ v: 1, tasks })}\n`);
}

// Keeps what submit needs of these game tasks, past the ones already kept,
// dropping those expired by now. A side task, so it never throws, and the
// worst case is a submit that cannot see the spec and says so.
export async function keepHanded(
  tasks: readonly HandedTask[],
  now: Date = new Date(),
  p: Paths = paths(),
): Promise<void> {
  if (tasks.length === 0) return;
  try {
    const before = await readKept(p);
    // A task handed over again keeps the asks already noted for it.
    const asked = new Map(before.map((task) => [task.id, task.asksAgain]));
    const fresh: Kept[] = tasks.map((task) => {
      const asksAgain = asked.get(task.id);
      return {
        id: task.id,
        finalLineFeed: specAsksFinalLineFeed(task.spec),
        expiresAt: task.expiresAt,
        ...(asksAgain === undefined ? {} : { asksAgain }),
      };
    });
    const ids = new Set(fresh.map((task) => task.id));
    const kept = before.filter(
      (task) => !ids.has(task.id) && Date.parse(task.expiresAt) > now.getTime(),
    );
    await writeKept([...kept, ...fresh].slice(-MAX_KEPT), p);
  } catch {
    // Not kept.
  }
}

// Whether the spec this machine was handed for the task asks the answer to
// end in a line feed, null when no spec of it is kept here.
export async function handedFinalLineFeed(
  taskId: string,
  p: Paths = paths(),
): Promise<boolean | null> {
  const found = (await readKept(p)).find((task) => task.id === taskId);
  return found?.finalLineFeed ?? null;
}

// Notes one more ask of the model for a game task whose kept answer failed
// a check before submit, and true when the ask may go. False when cap asks
// are noted already, when the task is not kept here or when the note could
// not be written, so no ask goes uncounted.
export async function takeAskAgain(
  taskId: string,
  cap: number,
  p: Paths = paths(),
): Promise<boolean> {
  try {
    const kept = await readKept(p);
    const found = kept.find((task) => task.id === taskId);
    if (found === undefined || (found.asksAgain ?? 0) >= cap) return false;
    found.asksAgain = (found.asksAgain ?? 0) + 1;
    await writeKept(kept, p);
    return true;
  } catch {
    return false;
  }
}
