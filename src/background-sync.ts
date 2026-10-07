// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The one gate every automatic sync goes through. A routine run takes it
// at its end and a task command once it wrote a task event (VOU-627,
// afterTaskWork in tasks.ts), and emit and the Claude Code SessionEnd hook
// run it before they return. Without it an agent whose operator never runs a
// sealkeeper command would only ever write to the local log, go quiet on
// its profile and drop down the dormancy ladder.
//
// It only runs when automatic sync is on, at most once every
// BACKGROUND_SYNC_INTERVAL_MS across every process on the machine, and
// under a lock file so two agents sharing one home never send the same
// batch at once. Each caller gives it a deadline, after which no new round
// starts. The plain sync command skips the throttle, since a person asked
// for it, but takes the same lock.
import { open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiClient, resolveApiUrl } from './api.js';
import { ensureHome, type Paths, paths, readConfig } from './config.js';
import { refreshFingerprintQuietly } from './fingerprint.js';
import { syncEvents } from './sync.js';

export const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// How long one gated sync may take. timeoutMs bounds each request.
// deadlineMs is when, counted from the start, no new round starts. A round in
// flight still finishes within its request timeout, so the most a sync takes
// is about deadlineMs plus timeoutMs.
type SyncLimits = { timeoutMs: number; deadlineMs: number };

// The background sync, a routine run's or a task command's after its
// output, makes nobody wait on an answer, so it can take longer.
const BACKGROUND_LIMITS: SyncLimits = { timeoutMs: 5_000, deadlineMs: 20_000 };

// emit and the SessionEnd hook run while someone waits on them, an agent's
// hook or Claude Code, so they stop after about 5 seconds.
export const WAITING_CALLER_LIMITS: SyncLimits = {
  timeoutMs: 2_000,
  deadlineMs: 3_000,
};

// How long the sync command waits for a gated sync that holds the lock. It
// holds it for at most a background deadline plus one request timeout.
const MANUAL_LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 250;
// A lock older than this belongs to a process that died mid sync. It is
// well past the deadline plus one request timeout. A lock whose process is
// gone, for example after Ctrl-C, is taken over at once.
export const LOCK_STALE_MS = 2 * 60 * 1000;

export const LOCK_FILE = 'background-sync.lock';
// Its modification time is when a background sync last started.
export const STAMP_FILE = 'background-sync.stamp';

export type GatedSyncOutcome = 'synced' | 'off' | 'throttled' | 'locked';

type BackgroundSyncOutcome = GatedSyncOutcome | 'failed';

type BackgroundSyncDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  paths?: Paths;
};

type GatedSyncOptions = BackgroundSyncDeps &
  SyncLimits & {
    // Where the sync's warnings go, stderr when unset. The background sync
    // prints nothing.
    warn?: (text: string) => void;
  };

// Per process, so an agent that emits many events a second does not touch
// the disk for each one. The stamp file is what holds across processes.
let lastTry = Number.NEGATIVE_INFINITY;

// For tests, which run many homes in one process.
export function resetBackgroundSyncThrottle(): void {
  lastTry = Number.NEGATIVE_INFINITY;
}

// One background sync attempt, and what came of it. Resolves in every
// case, never rejects.
export async function backgroundSync(
  deps: BackgroundSyncDeps = {},
): Promise<BackgroundSyncOutcome> {
  try {
    return await gatedSync({ ...deps, ...BACKGROUND_LIMITS, warn: () => {} });
  } catch {
    return 'failed';
  }
}

// One sync through the gate, and what came of it. Every outcome other than
// synced returns without a request and prints nothing. A sync that ran and
// failed throws what syncEvents threw, so a caller that prints can say how
// many events are pending. A failed sync still counts toward the throttle.
export async function gatedSync(
  options: GatedSyncOptions,
): Promise<GatedSyncOutcome> {
  const now = options.now ?? Date.now;
  const start = now();
  if (start - lastTry < BACKGROUND_SYNC_INTERVAL_MS) return 'throttled';
  lastTry = start;
  const p = options.paths ?? paths();
  const config = await readConfig(p);
  if (config === null || config.autoSync !== true) return 'off';
  if (await recentlyStarted(p, start)) return 'throttled';
  if (!(await takeLock(p, start))) return 'locked';
  try {
    // Checked again under the lock, since another process may have
    // finished a sync between the first look and taking the lock.
    if (await recentlyStarted(p, start)) return 'throttled';
    await touch(join(p.home, STAMP_FILE), start);
    // A sync is one of the moments the fingerprint is recomputed, see
    // fingerprint.ts. It never holds up or fails the sync.
    await refreshFingerprintQuietly({ paths: p, now });
    await syncEvents({
      api: createApiClient({
        apiUrl: resolveApiUrl({ config: config.apiUrl }),
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      }),
      sleep: async () => {},
      maxRateLimitWaitSec: 0,
      paths: p,
      now,
      deadline: start + options.deadlineMs,
      warn: options.warn,
      onRound: () => keepLock(p, now),
    });
    return 'synced';
  } finally {
    await releaseLock(p);
  }
}

// Another sync held the lock for longer than the sync command waits.
export class SyncBusyError extends Error {
  override name = 'SyncBusyError';
}

// Runs send under the lock the gated sync takes, so a sync a person started
// never runs next to a gated one and moves the cursor back. It waits for a
// gated sync that holds the lock, up to waitMs, and then throws
// SyncBusyError. The throttle does not apply. send gets keepLock, which it
// calls between rounds, so a sync that runs longer than LOCK_STALE_MS is
// never taken for a dead one.
export async function withSyncLock<T>(
  send: (keepLock: () => Promise<void>) => Promise<T>,
  options: { paths?: Paths; now?: () => number; waitMs?: number } = {},
): Promise<T> {
  const p = options.paths ?? paths();
  const now = options.now ?? Date.now;
  const giveUp = now() + (options.waitMs ?? MANUAL_LOCK_WAIT_MS);
  while (!(await takeLock(p, now()))) {
    if (now() >= giveUp) {
      throw new SyncBusyError(
        `another sync of this agent is running, try again shortly (lock file ${join(p.home, LOCK_FILE)})`,
      );
    }
    await delay(LOCK_POLL_MS);
  }
  try {
    return await send(() => keepLock(p, now));
  } finally {
    await releaseLock(p);
  }
}

// True when the lock file names this process.
async function holdsLock(file: string): Promise<boolean> {
  try {
    const pid = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
    return pid === process.pid;
  } catch {
    return false;
  }
}

// Stamps the lock with now, while it is still this process's. A lock
// another process took over after this one was held up is left alone.
async function keepLock(p: Paths, now: () => number): Promise<void> {
  const file = join(p.home, LOCK_FILE);
  if (!(await holdsLock(file))) return;
  const at = now() / 1000;
  await utimes(file, at, at).catch(() => {});
}

// Removes the lock only when it is still this process's, so a sync that
// lost its lock to a takeover never frees the lock of the one that took
// it.
async function releaseLock(p: Paths): Promise<void> {
  const file = join(p.home, LOCK_FILE);
  if (await holdsLock(file)) await rm(file, { force: true });
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
// that died is taken over at once when the pid in it is no longer running,
// and otherwise once it is older than LOCK_STALE_MS. Node ends on Ctrl-C or
// SIGTERM without running finally blocks, so an interrupted sync leaves its
// lock behind.
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
      if (age < LOCK_STALE_MS && !(await ownerIsGone(file))) return false;
      await rm(file, { force: true });
    }
  }
  return false;
}

// True only when the lock names a pid and no process with that pid runs.
// An empty or unreadable file, or a pid that runs as another user, keeps
// the age rule.
async function ownerIsGone(file: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function touch(file: string, at: number): Promise<void> {
  await writeFile(file, '', { mode: 0o600 });
  await utimes(file, at / 1000, at / 1000);
}
