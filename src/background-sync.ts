// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The background sync the in-process adapters (Mastra, OpenClaw) start after
// they append an event. Without it an agent whose operator never runs a
// sealkeeper command would only ever write to the local log, go quiet on its
// profile and drop down the dormancy ladder.
//
// It only runs when automatic sync is on, at most once every
// BACKGROUND_SYNC_INTERVAL_MS across every process on the machine, and
// under a lock file so two agents sharing one home never send the same
// batch at once. It is best effort. It never throws, never prints and never
// makes the caller wait, since the caller is someone else's agent.
import { open, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiClient, resolveApiUrl } from './api.js';
import { ensureHome, type Paths, paths, readConfig } from './config.js';
import { syncEvents } from './sync.js';

export const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60 * 1000;
// Each request gives up after this.
export const BACKGROUND_SYNC_TIMEOUT_MS = 5_000;
// No new round starts after this. A round in flight still finishes within
// its request timeout.
export const BACKGROUND_SYNC_DEADLINE_MS = 20_000;
// A lock older than this belongs to a process that died mid sync. It is
// well past the deadline plus one request timeout.
export const LOCK_STALE_MS = 2 * 60 * 1000;

export const LOCK_FILE = 'background-sync.lock';
// Its modification time is when a background sync last started.
export const STAMP_FILE = 'background-sync.stamp';

export type BackgroundSyncOutcome =
  | 'synced'
  | 'off'
  | 'throttled'
  | 'locked'
  | 'failed';

export type BackgroundSyncDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  paths?: Paths;
};

// Per process, so an agent that emits many events a second does not touch
// the disk for each one. The stamp file is what holds across processes.
let lastTry = Number.NEGATIVE_INFINITY;

// For tests, which run many homes in one process.
export function resetBackgroundSyncThrottle(): void {
  lastTry = Number.NEGATIVE_INFINITY;
}

// Starts a background sync and returns at once. Nothing it does can reach
// the caller, not even a rejected promise.
export function kickBackgroundSync(deps: BackgroundSyncDeps = {}): void {
  void backgroundSync(deps).catch(() => {});
}

// One background sync attempt, and what came of it. Resolves in every
// case, never rejects.
export async function backgroundSync(
  deps: BackgroundSyncDeps = {},
): Promise<BackgroundSyncOutcome> {
  const now = deps.now ?? Date.now;
  const start = now();
  if (start - lastTry < BACKGROUND_SYNC_INTERVAL_MS) return 'throttled';
  lastTry = start;
  try {
    const p = deps.paths ?? paths();
    const config = await readConfig(p);
    if (config === null || config.autoSync !== true) return 'off';
    if (await recentlyStarted(p, start)) return 'throttled';
    if (!(await takeLock(p, start))) return 'locked';
    try {
      // Checked again under the lock, since another process may have
      // finished a sync between the first look and taking the lock.
      if (await recentlyStarted(p, start)) return 'throttled';
      await touch(join(p.home, STAMP_FILE), start);
      await syncEvents({
        api: createApiClient({
          apiUrl: resolveApiUrl({ config: config.apiUrl }),
          fetch: deps.fetch,
          timeoutMs: BACKGROUND_SYNC_TIMEOUT_MS,
        }),
        sleep: async () => {},
        maxRateLimitWaitSec: 0,
        paths: p,
        now,
        deadline: start + BACKGROUND_SYNC_DEADLINE_MS,
        warn: () => {},
      });
      return 'synced';
    } finally {
      await rm(join(p.home, LOCK_FILE), { force: true });
    }
  } catch {
    return 'failed';
  }
}

async function recentlyStarted(p: Paths, now: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(join(p.home, STAMP_FILE));
    return now - mtimeMs < BACKGROUND_SYNC_INTERVAL_MS && mtimeMs <= now;
  } catch {
    return false;
  }
}

// Creates the lock file, failing when it exists. A lock left by a process
// that died is taken over once it is older than LOCK_STALE_MS.
async function takeLock(p: Paths, now: number): Promise<boolean> {
  await ensureHome(p);
  const file = join(p.home, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      await utimes(file, now / 1000, now / 1000);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age: number;
      try {
        age = now - (await stat(file)).mtimeMs;
      } catch {
        // Released between the two calls. Try again.
        continue;
      }
      if (age < LOCK_STALE_MS) return false;
      await rm(file, { force: true });
    }
  }
  return false;
}

async function touch(file: string, at: number): Promise<void> {
  await writeFile(file, '', { mode: 0o600 });
  await utimes(file, at / 1000, at / 1000);
}
