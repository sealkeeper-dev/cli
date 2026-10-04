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
// hold, so the file never grows past that.

const MAX_KEPT = 100;

const Kept = z.object({
  id: z.uuid(),
  finalLineFeed: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }),
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
    const fresh: Kept[] = tasks.map((task) => ({
      id: task.id,
      finalLineFeed: specAsksFinalLineFeed(task.spec),
      expiresAt: task.expiresAt,
    }));
    const ids = new Set(fresh.map((task) => task.id));
    const kept = (await readKept(p)).filter(
      (task) => !ids.has(task.id) && Date.parse(task.expiresAt) > now.getTime(),
    );
    const file = { v: 1, tasks: [...kept, ...fresh].slice(-MAX_KEPT) };
    await ensureHome(p);
    await writeFileAtomic(p.handed, `${JSON.stringify(file)}\n`);
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
