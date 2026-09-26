// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DAY_MS } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import {
  ensureHome,
  type Paths,
  paths,
  type RoutineConfig,
  type RoutineLimitName,
} from './config.js';
import { readEnv } from './env.js';
import { dayOf } from './log.js';

// The guardrails of sealkeeper routine (VOU-138), shared by the routine
// command and by the task commands a routine run's agent calls.
//
// A routine run starts a headless agent with SEALKEEPER_ROUTINE_RUN set to
// the run id. Only that variable puts a command in routine mode, where
// prove, tasks outcome and tasks submit apply the routine rules whatever
// their options, and tasks post, tasks claim and tasks pull are refused. A
// command the operator runs in another terminal while a run is going is a
// normal command. The Bash rules the agent gets allow only commands that
// keep the variable, see routine-agent.ts.
//
// routine-run.json holds the run id, its pid and a deadline. It is created
// exclusively at the start of a run, so two runs never overlap, and says
// nothing about which commands are in routine mode.
//
// routine.jsonl under the CLI home is the routine's own log, one JSON object
// a line. One run line per run, and a line for every claim, submit,
// confirmation, skip, limit, pause and resume. The daily caps are counted
// from it, per UTC day.

export const ROUTINE_RUN_ENV = 'SEALKEEPER_ROUTINE_RUN';

export type RoutinePaths = {
  log: string;
  lock: string;
  // Held while prove claims inside a run, so two claims at once cannot
  // pass the daily claim limit.
  claimLock: string;
  // Where the headless agent runs and writes its answer files. Outside the
  // CLI home, since tasks submit refuses any file inside it, see
  // key-guard.ts.
  work: string;
  // Where the scheduler sends the job's output.
  out: string;
};

export function routinePaths(p: Paths = paths()): RoutinePaths {
  return {
    log: join(p.home, 'routine.jsonl'),
    lock: join(p.home, 'routine-run.json'),
    claimLock: join(p.home, 'routine-claim.lock'),
    work: routineWorkDir(p.home),
    out: join(p.home, 'routine.out.log'),
  };
}

// The agent's working directory for one CLI home. A folder in the user's
// cache directory, named by a hash of the home, so two homes on one
// machine never share one. XDG_CACHE_HOME wins when it is set to an
// absolute path, then ~/Library/Caches on macOS, %LOCALAPPDATA% on Windows
// and ~/.cache elsewhere.
export function routineWorkDir(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string {
  const hash = createHash('sha256')
    .update(resolve(home))
    .digest('hex')
    .slice(0, 16);
  const xdg = readEnv('XDG_CACHE_HOME', env);
  const local = readEnv('LOCALAPPDATA', env);
  let base: string;
  if (xdg !== undefined && isAbsolute(xdg)) base = xdg;
  else if (platform === 'darwin') base = join(userHome, 'Library', 'Caches');
  else if (platform === 'win32') base = local ?? tmpdir();
  else base = join(userHome, '.cache');
  return join(base, 'sealkeeper', `routine-${hash}`);
}

// Creates the working directory with mode 700 and checks it is a real
// directory this user owns, outside the CLI home. Returns its path. Throws
// with the reason when it is not, and then no agent starts.
export async function ensureWorkDir(p: Paths = paths()): Promise<string> {
  const work = routinePaths(p).work;
  const home = resolve(p.home);
  if (resolve(work) === home || resolve(work).startsWith(`${home}${sep}`)) {
    throw new Error(
      `the routine's working directory ${work} is inside ${p.home}, where tasks submit refuses every file`,
    );
  }
  await mkdir(work, { recursive: true, mode: 0o700 });
  const info = await lstat(work);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${work} is not a directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${work} belongs to another user`);
  }
  await chmod(work, 0o700);
  return work;
}

const At = z.iso.datetime({ offset: true });

export const RunOutcome = z.enum([
  // The agent ran and exited cleanly.
  'done',
  // Nothing to do, no agent was started.
  'nothing',
  // A daily limit or the token cap stopped it.
  'stopped',
  // The agent failed, timed out or the API could not be read.
  'failed',
  // Paused, or another run was active. No agent was started.
  'skipped',
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const SkipReason = z.enum([
  // An open task posted by another agent. Never claimed unattended.
  'open_task',
  // A task addressed to this agent by an operator not on the allowlist.
  'poster_not_allowed',
  // A counterparty submission from an operator not on the allowlist.
  'claimant_not_allowed',
]);
export type SkipReason = z.infer<typeof SkipReason>;

const RoutineEntry = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    at: At,
    runId: z.string(),
    outcome: RunOutcome,
    reason: z.string().optional(),
    startedAt: At,
    agentStarted: z.boolean(),
    claimed: z.number().int(),
    submitted: z.number().int(),
    confirmed: z.number().int(),
    tokens: z.number().int().nullable(),
    costUsd: z.number().nullable(),
  }),
  z.object({
    kind: z.enum(['claim', 'submit', 'confirm']),
    at: At,
    runId: z.string(),
    taskId: z.string(),
    // The task type of a claim, so a run can prefer the seed types it has
    // done least (VOU-140). Absent on lines written before it.
    taskType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('skip'),
    at: At,
    runId: z.string(),
    action: z.enum(['claim', 'confirm']),
    taskId: z.string(),
    reason: SkipReason,
    // The poster's or claimant's operator login, when known.
    operator: z.string().optional(),
    taskType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('limit'),
    at: At,
    runId: z.string(),
    limit: z.enum([
      'claimsPerDay',
      'confirmsPerDay',
      'minutesPerRun',
      'tokensPerRun',
      // Today's counted tasks reached the daily ceiling (VOU-140). used and
      // cap are the counted tasks and the ceiling.
      'dailyCountCeiling',
    ]),
    used: z.number(),
    cap: z.number(),
  }),
  z.object({
    kind: z.literal('pause'),
    at: At,
    reason: z.string(),
  }),
  z.object({ kind: z.literal('resume'), at: At }),
]);
export type RoutineEntry = z.infer<typeof RoutineEntry>;
export type RunEntry = Extract<RoutineEntry, { kind: 'run' }>;
export type SkipEntry = Extract<RoutineEntry, { kind: 'skip' }>;

type NewEntry = RoutineEntry extends infer E
  ? E extends RoutineEntry
    ? Omit<E, 'at'> & { at?: string }
    : never
  : never;

// Appends one line. at defaults to now.
export async function appendRoutine(
  entry: NewEntry,
  p: Paths = paths(),
): Promise<void> {
  const line = { ...entry, at: entry.at ?? new Date().toISOString() };
  await ensureHome(p);
  await appendFile(routinePaths(p).log, `${JSON.stringify(line)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// Every line that parses, in order. Anything else is skipped.
export async function readRoutine(p: Paths = paths()): Promise<RoutineEntry[]> {
  let raw: string;
  try {
    raw = await readFile(routinePaths(p).log, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: RoutineEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = RoutineEntry.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // A partial line from a crash mid write.
    }
  }
  return entries;
}

// The daily limit each kind of work counts against.
const LIMIT_OF = {
  claim: 'claimsPerDay',
  confirm: 'confirmsPerDay',
} as const satisfies Record<string, RoutineLimitName>;

export type Budget = { used: number; cap: number; remaining: number };

// How much of one daily limit is used on the UTC day of now.
export function budgetOf(
  entries: RoutineEntry[],
  kind: keyof typeof LIMIT_OF,
  routine: RoutineConfig,
  now: Date = new Date(),
): Budget {
  const day = dayOf(now);
  const used = entries.filter(
    (e) => e.kind === kind && dayOf(new Date(e.at)) === day,
  ).length;
  const cap = routine.limits[LIMIT_OF[kind]];
  return { used, cap, remaining: Math.max(0, cap - used) };
}

export function limitName(kind: keyof typeof LIMIT_OF): RoutineLimitName {
  return LIMIT_OF[kind];
}

// The failed runs since the last run that did not fail, pause or resume.
export function failureStreak(entries: RoutineEntry[]): number {
  let streak = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as RoutineEntry;
    if (e.kind === 'resume' || e.kind === 'pause') break;
    if (e.kind !== 'run') continue;
    if (e.outcome !== 'failed') break;
    streak += 1;
  }
  return streak;
}

// Task ids already logged as skipped for this action in the last week, so a
// task seen on every run is logged once.
export function skippedIds(
  entries: RoutineEntry[],
  action: SkipEntry['action'],
  now: Date = new Date(),
): Set<string> {
  const since = now.getTime() - SKIP_LIST_DAYS * DAY_MS;
  return new Set(
    entries
      .filter(
        (e): e is SkipEntry =>
          e.kind === 'skip' && e.action === action && Date.parse(e.at) >= since,
      )
      .map((e) => e.taskId),
  );
}

// How far back routine status lists work left for a person.
export const SKIP_LIST_DAYS = 7;

// The login as the allowlist holds it.
export const normalLogin = (login: string): string =>
  login.trim().toLowerCase();

export function isAllowed(routine: RoutineConfig, login: string | undefined) {
  return login !== undefined && routine.allow.includes(normalLogin(login));
}

const Lock = z.object({
  runId: z.string().min(1),
  pid: z.number().int(),
  deadline: At,
});
export type Lock = z.infer<typeof Lock>;

// Takes the run lock, created exclusively, so of two runs started at once
// only one gets it. A lock left by a run that is gone, or past its
// deadline, is taken over. False when a live run holds it.
export async function acquireLock(
  lock: Lock,
  p: Paths = paths(),
): Promise<boolean> {
  await ensureHome(p);
  const file = routinePaths(p).lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createExclusive(file, `${JSON.stringify(lock)}\n`)) return true;
    const seen = await readText(file);
    if (await lockHeld(p)) return false;
    if (!(await takeOver(file, seen))) return false;
  }
  return false;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// Removes a stale lock, only while it is still the one judged stale, seen.
// One process at a time does this, under a guard file created exclusively,
// so a lock another process has just taken in its place is never removed.
// The path is then taken with an exclusive create, which only one wins.
// True when the path is free to try, false when another process is taking
// the lock over or already has.
async function takeOver(file: string, seen: string | null): Promise<boolean> {
  const guard = `${file}.takeover`;
  if (!(await createExclusive(guard, `${process.pid}\n`))) {
    // A guard left by a process that died mid takeover.
    const made = await stat(guard).then(
      (s) => s.mtimeMs,
      () => null,
    );
    if (made !== null && Date.now() - made > TAKEOVER_GUARD_STALE_MS) {
      await rm(guard, { force: true });
    }
    return false;
  }
  try {
    const now = await readText(file);
    if (now === null) return true;
    if (now !== seen) return false;
    await rm(file, { force: true });
    return true;
  } finally {
    await rm(guard, { force: true });
  }
}

const TAKEOVER_GUARD_STALE_MS = 30_000;

// Removes the run lock, only while it is still the one runId took.
export async function removeLock(
  runId: string,
  p: Paths = paths(),
): Promise<void> {
  const current = await readLock(p);
  if (current !== null && current.runId !== runId) return;
  await rm(routinePaths(p).lock, { force: true });
}

// True when file was created, false when it was already there.
async function createExclusive(file: string, text: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close();
  }
  return true;
}

async function readLock(p: Paths): Promise<Lock | null> {
  try {
    const parsed = Lock.safeParse(
      JSON.parse(await readFile(routinePaths(p).lock, 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// A lock that does not read yet may be one another run is still writing,
// so it counts as held for a short while after it was made.
const UNREAD_LOCK_GRACE_MS = 30_000;

async function lockHeld(p: Paths): Promise<boolean> {
  if ((await readLiveLock(p)) !== null) return true;
  if ((await readLock(p)) !== null) return false;
  try {
    const made = (await stat(routinePaths(p).lock)).mtimeMs;
    return Date.now() - made < UNREAD_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

// The lock of a run still going. A lock past its deadline, or whose process
// is gone, is stale and ignored.
export async function readLiveLock(
  p: Paths = paths(),
  now: Date = new Date(),
): Promise<Lock | null> {
  const lock = await readLock(p);
  if (lock === null) return null;
  if (Date.parse(lock.deadline) <= now.getTime()) return null;
  return processAlive(lock.pid) ? lock : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// How long prove waits for another prove of the same run to finish its
// claims, and when a claim lock counts as left behind.
const CLAIM_LOCK_WAIT_MS = 60_000;
const CLAIM_LOCK_STALE_MS = 5 * 60_000;
const CLAIM_LOCK_POLL_MS = 100;

// Runs fn while holding the claim lock, so the daily claim budget is read,
// spent and logged by one prove at a time. A lock whose process is gone,
// or older than five minutes, is taken over. Throws when another prove
// holds it for more than a minute.
export async function withClaimLock<T>(
  fn: () => Promise<T>,
  p: Paths = paths(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  await ensureHome(p);
  const file = routinePaths(p).claimLock;
  // The token says the lock is still this call's when it is removed.
  const token = randomUUID();
  const text = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })}\n`;
  const giveUp = Date.now() + CLAIM_LOCK_WAIT_MS;
  while (!(await createExclusive(file, text))) {
    const seen = await readText(file);
    if (await claimLockStale(file)) {
      await takeOver(file, seen);
      continue;
    }
    if (Date.now() >= giveUp) {
      throw new Error(
        'another prove of this routine run is still claiming, nothing was claimed',
      );
    }
    await sleep(CLAIM_LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    // Only while it is still ours. A lock taken over as stale belongs to
    // whoever holds it now.
    if ((await readText(file))?.includes(token)) {
      await rm(file, { force: true });
    }
  }
}

async function claimLockStale(file: string): Promise<boolean> {
  try {
    const made = (await stat(file)).mtimeMs;
    if (Date.now() - made > CLAIM_LOCK_STALE_MS) return true;
    const held = z
      .object({ pid: z.number().int() })
      .safeParse(JSON.parse(await readFile(file, 'utf8')));
    return held.success && !processAlive(held.data.pid);
  } catch {
    // Gone already, or still being written.
    return false;
  }
}

// The id of the routine run this process works for, or null for a normal
// command. Only the variable the run sets for its agent says so. The run
// lock does not, so the operator's own commands in another terminal stay
// normal while a run is going.
export async function activeRoutineRun(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return readEnv(ROUTINE_RUN_ENV, env) ?? null;
}

// A command a routine run's agent may not use ends here, with the reason.
export async function refuseInRoutine(
  cmd: Command,
  command: string,
): Promise<void> {
  if ((await activeRoutineRun()) === null) return;
  cmd.error(
    `${command} is not available during a routine run. A routine run claims through prove only, which takes seed tasks and tasks addressed to this agent by allowed operators, and never posts`,
  );
}
