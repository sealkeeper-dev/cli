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
import { DAY_MS, TaskCategory } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import {
  ensureHome,
  type Paths,
  paths,
  type RoutineConfig,
  type RoutineLimitName,
  writeFileAtomic,
} from './config.js';
import { readEnv } from './env.js';
import { dayOf } from './log.js';
import { slugOfAnswer } from './operator-slug.js';
import { ROUTINE_TEMPLATES, templateById } from './task-templates.js';

// The guardrails of sealkeeper routine (VOU-138), shared by the routine
// command and by the task commands a routine run's agent calls.
//
// A routine run starts a headless agent with SEALKEEPER_ROUTINE_RUN set to
// the run id. Only that variable puts a command in routine mode, where
// prove, tasks outcome and tasks submit apply the routine rules whatever
// their options, tasks post takes only a template that makes its own input,
// and tasks claim and tasks pull are refused. A command the operator runs in
// another terminal while a run is going is a normal command. The Bash rules the agent gets allow only commands that
// keep the variable, see routine-agent.ts.
//
// routine-run.json holds the run id, its pid and a deadline. It is created
// exclusively at the start of a run, so two runs never overlap, and says
// nothing about which commands are in routine mode. Once the run has chosen
// a template to post, it holds that too, and tasks post in the run posts
// only that one, once (POST-7). With it, the category the run adopts a
// ready made task in, the template's own, and then tasks post --adopt in
// that category is the run's one post, with the template as its fallback
// (RT-12).
//
// routine.jsonl under the CLI home is the routine's own log, one JSON object
// a line. One run line per run, and a line for every claim, submit, failed
// submit, confirmation, post, skip, limit, pause and resume, and one for
// each prove once its claims are in. The daily caps are counted from it,
// per UTC day. A first run's watcher reads the lines of its run as they
// come, see routine-watch.ts (RS-9).

export const ROUTINE_RUN_ENV = 'SEALKEEPER_ROUTINE_RUN';

export type RoutinePaths = {
  log: string;
  lock: string;
  // Held while prove claims inside a run, so two claims at once cannot
  // pass the daily claim limit.
  claimLock: string;
  // Held while tasks outcome reports inside a run, so two reports at once
  // cannot pass the daily confirmation limit.
  confirmLock: string;
  // Held while tasks post posts inside a run, so two posts at once cannot
  // pass the daily post limit.
  postLock: string;
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
    confirmLock: join(p.home, 'routine-confirm.lock'),
    postLock: join(p.home, 'routine-post.lock'),
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
  // A claim the API refused because the task was posted too recently
  // (RT-8). Nothing waits for a person, a later run takes it.
  'too_new',
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
    // Template tasks posted (POST-7). Absent on lines written before it.
    posted: z.number().int().optional(),
    tokens: z.number().int().nullable(),
    costUsd: z.number().nullable(),
  }),
  z.object({
    kind: z.enum(['claim', 'submit', 'confirm', 'post']),
    at: At,
    runId: z.string(),
    taskId: z.string(),
    // The task type of a claim, so a run can prefer the seed types it has
    // done least (VOU-140), and of a post, the template's id, so a run can
    // post the template it posted least. Absent on lines written before it.
    taskType: z.string().optional(),
    // True on a claim of another operator's template task, which
    // networkClaimsPerDay counts, with the poster's operator slug, so one
    // operator gets at most one such claim a day (RT-8).
    network: z.boolean().optional(),
    operator: z.string().optional(),
    // On a post, true when it adopted a ready made task, with the category
    // it adopted in, and on a template post made in place of an adoption
    // why, candidate_none when none was waiting in that category and
    // api_too_old when the API does not take adoptions yet (RT-12).
    adopted: z.boolean().optional(),
    category: z.string().optional(),
    fallback: z.enum(['candidate_none', 'api_too_old']).optional(),
    // On a submit, the task's state after it, verified for a task
    // SealKeeper checked and submitted for one that waits for its poster,
    // and on a confirmation the outcome reported (RS-9). Absent on lines
    // written before it.
    state: z.string().optional(),
    outcome: z.enum(['success', 'failure']).optional(),
  }),
  // A submit in a routine run that SealKeeper refused, with why, the
  // verification failure or the API's error code (RS-9). Its own kind, so
  // the submit count of a run and of an older CLI never includes it.
  z.object({
    kind: z.literal('submit_failed'),
    at: At,
    runId: z.string(),
    taskId: z.string(),
    taskType: z.string().optional(),
    reason: z.string(),
  }),
  // A prove in a routine run once its claims are in (RS-9). claimed is the
  // tasks it claimed now, tasks all it handed the agent, the tasks the
  // agent held already included.
  z.object({
    kind: z.literal('prove'),
    at: At,
    runId: z.string(),
    claimed: z.number().int(),
    tasks: z.number().int(),
  }),
  // An operator whose task this agent failed, so the routine takes no
  // template task of that operator again (RT-8). tasks submit writes it on
  // the first failed submit of a network claim in a routine run, and
  // outside a run on the failed submit that ends a claim.
  z.object({
    kind: z.literal('barred'),
    at: At,
    taskId: z.string(),
    operator: z.string(),
  }),
  z.object({
    kind: z.literal('skip'),
    at: At,
    runId: z.string(),
    action: z.enum(['claim', 'confirm']),
    taskId: z.string(),
    reason: SkipReason,
    // The poster's or claimant's operator slug, when known. A GitHub login
    // on lines written before VOU-196.
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
      'postsPerDay',
      'minutesPerRun',
      'tokensPerRun',
      // Today's counted tasks reached the daily ceiling (VOU-140). used and
      // cap are the counted tasks and the ceiling.
      'dailyCountCeiling',
      // SealKeeper refused an adoption past its own daily cap (RT-12). used
      // and cap are that cap, null when its answer did not say it.
      'adoptsPerDay',
    ]),
    used: z.number().nullable(),
    cap: z.number().nullable(),
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
  post: 'postsPerDay',
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

// How much of networkClaimsPerDay is used on the UTC day of now, from the
// claim lines marked network (RT-8).
export function networkBudgetOf(
  entries: RoutineEntry[],
  routine: RoutineConfig,
  now: Date = new Date(),
): Budget {
  const day = dayOf(now);
  const used = entries.filter(
    (e) =>
      e.kind === 'claim' && e.network === true && dayOf(new Date(e.at)) === day,
  ).length;
  const cap = routine.limits.networkClaimsPerDay;
  return { used, cap, remaining: Math.max(0, cap - used) };
}

// Every operator slug on a barred line, lowercased (RT-8).
export function barredOperators(entries: RoutineEntry[]): Set<string> {
  return new Set(
    entries.flatMap((e) =>
      e.kind === 'barred' ? [e.operator.toLowerCase()] : [],
    ),
  );
}

// The operators of today's network claims, lowercased, so each operator
// gets at most one a day across every prove of every run (RT-8).
export function networkOperatorsToday(
  entries: RoutineEntry[],
  now: Date = new Date(),
): Set<string> {
  const day = dayOf(now);
  return new Set(
    entries.flatMap((e) =>
      e.kind === 'claim' &&
      e.network === true &&
      e.operator !== undefined &&
      dayOf(new Date(e.at)) === day
        ? [e.operator.toLowerCase()]
        : [],
    ),
  );
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

// A GitHub login or an operator slug, trimmed and lowercased, so two
// spellings of one compare equal.
export const normalLogin = (login: string): string =>
  login.trim().toLowerCase();

// The agent answer isAllowed reads, a poster or a claimant from
// GET /v1/agents/:id.
export type AllowedAgent = {
  handle?: string | null;
  operator: { login: string; slug?: string | null };
};

// True when the agent's operator is on the allowlist. An entry in
// allowSlugs matches the slug the API sent, operator.slug or the first half
// of the handle, never the login, so an answer without one matches no slug
// entry. An entry in allow, a GitHub login from before VOU-196, matches the
// login only, as it did when it was added, so a slug another operator
// picks never inherits it. Case does not matter on either side. An agent
// that could not be looked up is not allowed.
export function isAllowed(
  routine: RoutineConfig,
  agent: AllowedAgent | null | undefined,
): boolean {
  if (agent === null || agent === undefined) return false;
  const login = normalLogin(agent.operator.login);
  if (routine.allow.some((entry) => normalLogin(entry) === login)) return true;
  const slug = slugOfAnswer(agent);
  return (
    slug !== undefined &&
    routine.allowSlugs.some((entry) => normalLogin(entry) === slug)
  );
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
  // The template this run posts, when it chose one.
  post: z.string().min(1).optional(),
  // The category this run adopts a ready made task in, when it adopts
  // (RT-12). post is then the template it posts when none is waiting.
  adopt: TaskCategory.optional(),
  // The task id of that adoption, made once, so a retry after a lost answer
  // gets the same task back rather than adopting a second one.
  taskId: z.uuid().optional(),
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

// What a routine run chose to post. template is the template it posts,
// adopt the category it adopts a ready made task in first, or null when it
// posts the template straight away (RT-12). taskId is the id of that
// adoption, which setRunPost makes and runChoice gives back.
export type RunPost = {
  template: string;
  adopt: TaskCategory | null;
  taskId?: string;
};

// Records in the run lock what runId chose to post, a template id alone or
// a RunPost, with a new task id for an adoption unless the RunPost has one.
// Nothing when the lock is another run's or gone.
export async function setRunPost(
  runId: string,
  post: string | RunPost,
  p: Paths = paths(),
): Promise<void> {
  const lock = await readLock(p);
  if (lock === null || lock.runId !== runId) return;
  const chosen =
    typeof post === 'string'
      ? { post }
      : {
          post: post.template,
          ...(post.adopt === null
            ? {}
            : { adopt: post.adopt, taskId: post.taskId ?? randomUUID() }),
        };
  await writeFileAtomic(
    routinePaths(p).lock,
    `${JSON.stringify({ ...lock, ...chosen })}\n`,
  );
}

// What runId chose to post, from its live run lock, or null when it chose
// nothing or its lock is not live.
export async function runChoice(
  runId: string,
  p: Paths = paths(),
): Promise<RunPost | null> {
  const lock = await readLiveLock(p);
  if (lock === null || lock.runId !== runId || lock.post === undefined) {
    return null;
  }
  return {
    template: lock.post,
    adopt: lock.adopt ?? null,
    ...(lock.taskId === undefined ? {} : { taskId: lock.taskId }),
  };
}

// How long a command waits for another of the same run to let go of a
// routine lock, and when a lock counts as left behind.
const ROUTINE_LOCK_WAIT_MS = 60_000;
const ROUTINE_LOCK_STALE_MS = 5 * 60_000;
const ROUTINE_LOCK_POLL_MS = 100;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thrown when another command of the same run holds a routine lock for
// longer than a minute. The message is the line to show.
export class RoutineLockBusy extends Error {
  override name = 'RoutineLockBusy';
}

// Runs fn while holding the claim lock, so the daily claim budget is read,
// spent and logged by one prove at a time. Throws RoutineLockBusy when
// another prove holds it for more than a minute.
export function withClaimLock<T>(
  fn: () => Promise<T>,
  p: Paths = paths(),
  sleep: Sleep = realSleep,
): Promise<T> {
  return withRoutineLock(
    routinePaths(p).claimLock,
    'another prove of this routine run is still claiming, nothing was claimed',
    fn,
    p,
    sleep,
  );
}

// Runs fn while holding the confirm lock, so the daily confirmation budget
// is read, spent and logged by one tasks outcome at a time. Throws
// RoutineLockBusy when another one holds it for more than a minute.
export function withConfirmLock<T>(
  fn: () => Promise<T>,
  p: Paths = paths(),
  sleep: Sleep = realSleep,
): Promise<T> {
  return withRoutineLock(
    routinePaths(p).confirmLock,
    'another tasks outcome of this routine run is still reporting, nothing was reported',
    fn,
    p,
    sleep,
  );
}

// Runs fn while holding the post lock, so the daily post budget is read,
// spent and logged by one tasks post at a time. Throws RoutineLockBusy when
// another one holds it for more than a minute.
export function withPostLock<T>(
  fn: () => Promise<T>,
  p: Paths = paths(),
  sleep: Sleep = realSleep,
): Promise<T> {
  return withRoutineLock(
    routinePaths(p).postLock,
    'another tasks post of this routine run is still posting, nothing was posted',
    fn,
    p,
    sleep,
  );
}

// Runs fn while holding the lock file, created exclusively. A lock whose
// process is gone, or older than five minutes, is taken over. fn must throw
// rather than end the process, or the lock stays behind until it is stale.
async function withRoutineLock<T>(
  file: string,
  busy: string,
  fn: () => Promise<T>,
  p: Paths,
  sleep: Sleep,
): Promise<T> {
  await ensureHome(p);
  // The token says the lock is still this call's when it is removed.
  const token = randomUUID();
  const text = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })}\n`;
  const giveUp = Date.now() + ROUTINE_LOCK_WAIT_MS;
  while (!(await createExclusive(file, text))) {
    const seen = await readText(file);
    if (await lockFileStale(file)) {
      await takeOver(file, seen);
      continue;
    }
    if (Date.now() >= giveUp) throw new RoutineLockBusy(busy);
    await sleep(ROUTINE_LOCK_POLL_MS);
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

async function lockFileStale(file: string): Promise<boolean> {
  try {
    const made = (await stat(file)).mtimeMs;
    if (Date.now() - made > ROUTINE_LOCK_STALE_MS) return true;
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

// What a tasks post asks for, as refuseInRoutine reads it. template is the
// --template id, null for --type, --spec and --verify or the guided walk.
// adopt is the --adopt category, null without it.
export type PostAsk = {
  template: string | null;
  adopt?: string | null;
  input: boolean;
  assignee: boolean;
  outsideCwd: boolean;
};

// A command a routine run's agent may not use ends here, with the reason.
// With post, tasks post passes when it asks for a template that makes its
// own input and nothing else (POST-7), or for --adopt and nothing else
// (RT-12). The run's choice and the daily post limit are checked as it
// posts, see tasks-post.ts.
export async function refuseInRoutine(
  cmd: Command,
  command: string,
  post?: PostAsk,
): Promise<void> {
  if ((await activeRoutineRun()) === null) return;
  const why =
    post === undefined
      ? `${command} is not available during a routine run. A routine run claims through prove only, which takes tasks addressed to this agent by allowed operators, other operators' template tasks and seed tasks, and posts only by adopting a ready made task or from a template`
      : routinePostRefusal(post);
  if (why !== null) cmd.error(why);
}

const ROUTINE_TEMPLATE_IDS = ROUTINE_TEMPLATES.map((t) => t.id).join(', ');

// Why a routine run may not make this post, or null when it may.
export function routinePostRefusal(post: PostAsk): string | null {
  const adopt = post.adopt ?? null;
  if (post.template === null && adopt === null) {
    return `nothing posted. During a routine run tasks post takes only --adopt <category> or --template with one of ${ROUTINE_TEMPLATE_IDS}`;
  }
  const template =
    post.template === null ? undefined : templateById(post.template);
  if (
    template !== undefined &&
    !ROUTINE_TEMPLATES.some((t) => t.id === template.id)
  ) {
    return `nothing posted. ${template.id} needs input a person writes, so during a routine run only ${ROUTINE_TEMPLATE_IDS} post`;
  }
  if (post.input) {
    return 'nothing posted. During a routine run a template makes its own input, so --input is refused';
  }
  if (post.assignee) {
    return 'nothing posted. During a routine run a post goes to every agent, so --for is refused';
  }
  if (post.outsideCwd) {
    return 'nothing posted. --allow-outside-cwd is refused during a routine run';
  }
  return null;
}

// The template a routine run posts next. The one of ROUTINE_TEMPLATES it
// has posted least, from the post lines of routine.jsonl, the first in
// order on a tie.
export function nextRoutineTemplate(entries: RoutineEntry[]): string {
  const posted = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === 'post' && e.taskType !== undefined) {
      posted.set(e.taskType, (posted.get(e.taskType) ?? 0) + 1);
    }
  }
  let best = ROUTINE_TEMPLATES[0] as (typeof ROUTINE_TEMPLATES)[number];
  for (const t of ROUTINE_TEMPLATES) {
    if ((posted.get(t.id) ?? 0) < (posted.get(best.id) ?? 0)) best = t;
  }
  return best.id;
}

// What a routine run posts (RT-12). The template nextRoutineTemplate picks,
// and first a ready made task adopted in that template's category, so the
// choice of template stands and the category comes from the template.
export function nextRoutinePost(entries: RoutineEntry[]): RunPost {
  const template = nextRoutineTemplate(entries);
  return { template, adopt: templateById(template)?.category ?? null };
}
