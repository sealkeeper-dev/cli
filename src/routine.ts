// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto';
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
import type { RoutineAllow } from '@sealkeeper/schema';
import { z } from 'zod';
import { ensureHome, type Paths, paths, type RoutineConfig } from './config.js';
import { readEnv } from './env.js';

// The local state of sealkeeper routine (VOU-138, VOU-599).
//
// A routine run is a plain loop the API drives (VOU-594). The CLI asks the
// routine route for the next action, carries it out and asks again until
// the answer is done. The agent gets a task's spec or a submission to judge
// as a question with no tools, answers by text, and the CLI submits that
// text or sends it back as a verdict. No command the agent could run takes
// part, so the CLI keeps no routine rules of its own. The API holds the run
// to the limits and the allowlist routine.json sends with every call. The
// loop is in routine-run.ts, and a Mastra routine (VOU-601) runs the same
// loop in the operator's process with the same files.
//
// routine-run.json holds the run id, its pid and a deadline. It is created
// exclusively at the start of a run, so two runs never overlap.
//
// routine.jsonl under the CLI home is the routine's own log, one JSON object
// a line. One run line per run, and a line for every step the API answered,
// every submit, failed submit, verdict, answer the agent did not give,
// limit that stopped the agent and failed sync at the end of a run. A
// first run's watcher reads the lines of its run as they come, see
// routine-watch.ts (RS-9). The API counts the day against the limits from
// its own records, never from this log.

export type RoutinePaths = {
  log: string;
  lock: string;
  // Where the agent runs. Outside the CLI home and empty, since the agent
  // has no tools and needs no files. The answers the CLI submits are kept
  // here for the operator, under .sealkeeper-answers.
  work: string;
  // Where the scheduler sends the job's output.
  out: string;
};

export function routinePaths(p: Paths = paths()): RoutinePaths {
  return {
    log: join(p.home, 'routine.jsonl'),
    lock: join(p.home, 'routine-run.json'),
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
      `the routine's working directory ${work} is inside ${p.home}, which holds the key`,
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
  // The API answered done after the run did its work.
  'done',
  // The API had nothing to do, no agent was started.
  'nothing',
  // The wall clock or the token cap stopped it.
  'stopped',
  // The agent, the API or the key failed.
  'failed',
  // Off, or another run was active. Nothing was asked.
  'skipped',
  // The caller's signal stopped it, a Mastra routine only (VOU-620). An
  // older CLI skips the line, as any line it does not read.
  'aborted',
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

const Count = z.number().int();

const RoutineEntry = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    at: At,
    runId: z.string(),
    // The runtime the run put its questions to, claude-code, openclaw or
    // mastra, a string so a value a newer CLI writes still reads. Absent on
    // a run that was off and on lines written before VOU-601.
    runtime: z.string().optional(),
    outcome: RunOutcome,
    reason: z.string().optional(),
    // What failed, a RunFailure of routine-run.ts, so the
    // screen says the fix. A string, so a value a newer CLI writes still
    // reads. Absent when nothing failed and on lines written before it.
    failure: z.string().optional(),
    startedAt: At,
    agentStarted: z.boolean(),
    // Tasks handed over that were not game tasks, answers submitted,
    // verdicts sent and tasks posted. posted is absent on lines written
    // before POST-7.
    claimed: Count,
    submitted: Count,
    confirmed: Count,
    posted: Count.optional(),
    // Submits SealKeeper verified, and duel and challenge tasks handed
    // over. Absent on lines written before VOU-599.
    verified: Count.optional(),
    duels: Count.optional(),
    challenge: Count.optional(),
    tokens: Count.nullable(),
    costUsd: z.number().nullable(),
    // What the run did with the agent card init wrote, a value of
    // CardRefresh in card.ts, a string so a value a newer CLI writes still
    // reads (VOU-383). Absent when init wrote none, and on lines written
    // before it.
    card: z.string().optional(),
  }),
  // One step the API answered. action is the API's, taskId the task the
  // step touched, with its type and its kind for a task to solve, and
  // label what the API said a step that hands nothing over did.
  z.object({
    kind: z.literal('step'),
    at: At,
    runId: z.string(),
    step: Count,
    action: z.string(),
    taskId: z.string().optional(),
    taskType: z.string().optional(),
    taskKind: z.string().optional(),
    label: z.string().optional(),
  }),
  // An answer submitted, with the task's state after it, verified for a
  // task SealKeeper checked and submitted for one that waits for its
  // poster (RS-9).
  z.object({
    kind: z.literal('submit'),
    at: At,
    runId: z.string(),
    taskId: z.string(),
    taskType: z.string().optional(),
    state: z.string().optional(),
  }),
  // A submit SealKeeper or the CLI refused, with why, the verification
  // failure or the error code. Its own kind, so no submit count includes
  // it.
  z.object({
    kind: z.literal('submit_failed'),
    at: At,
    runId: z.string(),
    taskId: z.string(),
    taskType: z.string().optional(),
    reason: z.string(),
  }),
  // A verdict sent back with the next call, which the API reports.
  z.object({
    kind: z.literal('confirm'),
    at: At,
    runId: z.string(),
    taskId: z.string(),
    taskType: z.string().optional(),
    outcome: z.enum(['success', 'failure']),
  }),
  // A task or a submission the agent gave no answer for, with why.
  // released is true when the claim was given back, so it costs nothing.
  z.object({
    kind: z.literal('unanswered'),
    at: At,
    runId: z.string(),
    taskId: z.string(),
    taskType: z.string().optional(),
    reason: z.string(),
    released: z.boolean(),
  }),
  // The sync at the end of a run failed (VOU-627). The run's events stay
  // in the local log and go with the next sync. An older CLI skips the
  // line, as any line it does not read.
  z.object({
    kind: z.literal('sync_failed'),
    at: At,
    runId: z.string(),
  }),
  z.object({
    kind: z.literal('limit'),
    at: At,
    runId: z.string(),
    limit: z.enum(['minutesPerRun', 'tokensPerRun']),
    used: z.number().nullable(),
    cap: z.number().nullable(),
  }),
]);
export type RoutineEntry = z.infer<typeof RoutineEntry>;
export type RunEntry = Extract<RoutineEntry, { kind: 'run' }>;

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

// Every line that parses, in order. Anything else, such as a line of a
// kind an earlier CLI wrote, is skipped.
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

// A GitHub login or an operator slug, trimmed and lowercased, so two
// spellings of one compare equal.
export const normalLogin = (login: string): string =>
  login.trim().toLowerCase();

// The allowlist as the routine route takes it. The API matches slugs by
// slug and logins by login only, case ignored.
export function routineAllow(routine: RoutineConfig): RoutineAllow {
  return { slugs: routine.allowSlugs, logins: routine.allow };
}

// The allowlist as people read it, slugs first, each login marked as one.
export function allowedNames(routine: RoutineConfig): string {
  const names = [
    ...routine.allowSlugs,
    ...routine.allow.map((login) => `${login} (GitHub login)`),
  ];
  return names.length === 0 ? 'nobody yet' : names.join(', ');
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
