// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ListDuelsRequest } from '@sealkeeper/schema';
import type { Command } from 'commander';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from '../api.js';
import { type Input, readYesNo, streamInput } from '../ask.js';
import { type CardRefresh, readCardRecord, refreshCard } from '../card.js';
import { cliInvocation, cliProgram } from '../claude-code-settings.js';
import { loadRoutineConfig, requireConfig } from '../cli-config.js';
import {
  type Config,
  type Paths,
  paths,
  type RoutineConfig,
  type RoutineLimits,
  type RoutineSchedule,
  readConfig,
  readRoutineConfig,
  sealkeeperRoot,
  writeRoutineConfig,
} from '../config.js';
import { readEnv } from '../env.js';
import { tildePath } from '../files.js';
import {
  HIGHEST_ISSUED,
  loadGoal,
  postingBehind,
  shownLevel,
} from '../goal.js';
import { KeyError, loadSigner, type Signer } from '../identity.js';
import { cli, printedInvocation } from '../invocation.js';
import { stderr, stdout, stdoutStyled, wantsJson } from '../output.js';
import {
  type AgentResponse,
  operatorSlugOf,
  type TaskResponse,
} from '../responses.js';
import {
  acquireLock,
  allowedNames,
  appendRoutine,
  barredOperators,
  budgetOf,
  ensureWorkDir,
  failureStreak,
  type GameEntry,
  isAllowed,
  networkBudgetOf,
  networkOperatorsToday,
  nextRoutinePost,
  ROUTINE_RUN_ENV,
  type RoutineEntry,
  type RunEntry,
  type RunOutcome,
  type RunPost,
  readLiveLock,
  readRoutine,
  removeLock,
  routinePaths,
  SKIP_LIST_DAYS,
  type SkipEntry,
  setRunPost,
} from '../routine.js';
import {
  type AgentResult,
  type Confirmable,
  claudeArgs,
  findOnPath,
  routinePrompt,
  runAgent,
  type Spawner,
  spawnAgent,
} from '../routine-agent.js';
import {
  copyPaths,
  copyVersion,
  removeCopy,
  routineJobWarnings,
  runsCopy,
  writeCopy,
} from '../routine-copy.js';
import {
  applyPlan,
  commandLine,
  detectScheduler,
  execRunner,
  jobName,
  LINGER_NOTE,
  lingers,
  type Plan,
  planInstall,
  type Runner,
  removeJob,
  removeJobByName,
  type SchedulerEnv,
  SchedulerError,
  schtasksName,
} from '../routine-scheduler.js';
import {
  onSigint,
  type SpinnerStream,
  type StartedRun,
  type StartSpec,
  startDetached,
  watchRun,
} from '../routine-watch.js';
import { createStyle } from '../style.js';
import { serverHeld } from '../tasks.js';
import { dailyCeilingReached, todayOf } from '../today.js';
import { VERSION } from '../version.js';
import { readGameStatus } from './game.js';
import {
  logSkips,
  PosterLookup,
  type RoutineCandidates,
  routineCandidates,
  routineHeld,
} from './run-routine.js';
import { awaitingVerdict, fetchSubmission } from './tasks-outcome.js';

// sealkeeper routine (VOU-136, VOU-138). An opt-in daily run that works
// toward the next level unattended.
//
// install writes one daily job with the operator's own scheduler, after one
// short block and a yes, and offers the first run (RS-1, RS-3). The job runs
// a copy of this CLI under the home (RS-2) with routine run, which checks whether there is
// anything to do within the day's limits and, only then, starts the agent
// headless with the run instructions. When the game is on for the agent
// and it has game units left or a duel running, the agent plays the game
// after the task work, and a run with no task work starts it for the game
// alone (GAME-14, gameSteps in routine-agent.ts). Everything a run does is
// held to the routine rules in routine.ts and logged in routine.jsonl.
// sealkeeper status shows the schedule, the last run and what waits for a
// person (routineView). pause, resume and remove are the kill switch.

export type RoutineDeps = {
  fetch: typeof fetch;
  run?: Runner;
  spawner?: Spawner;
  platform?: () => NodeJS.Platform;
  homedir?: () => string;
  uid?: () => number;
  stdin?: () => Input;
  findAgent?: (name: string) => Promise<string | null>;
  // The CLI's node and script paths, and the same quoted for a shell.
  cli?: () => { program: string[]; invocation: string };
  // Tests shorten the wall clock with this.
  msPerMinute?: number;
  // How the first run starts, detached by default (RS-9). Tests run it in
  // this process with startInProcess.
  startRun?: RunStarter;
  // Ctrl-C while a first run is watched, SIGINT by default.
  interrupt?: (stop: () => void) => () => void;
  // Whether stdout is a terminal, for the spinner and the event lines.
  stdoutTTY?: () => boolean;
  // How often a watcher reads routine.jsonl.
  pollMs?: number;
};

// Starts one routine run to watch, as the first run after an install.
export type RunStarter = (spec: StartSpec, deps: RoutineDeps) => StartedRun;

// A routine run in this process, for tests, which start no real process.
export const startInProcess: RunStarter = (spec, deps) => {
  const p = paths(readEnv('SEALKEEPER_HOME', spec.env) ?? sealkeeperRoot());
  return {
    ended: (async () => {
      const config = await readConfig(p);
      if (config === null) return 'no agent is set up';
      await routineRun(deps, config, await readRoutineConfig(p), p, spec.runId);
      return null;
    })().catch((error: Error) => error.message),
  };
};

// Set by init and routine install on the first run they start, so the run
// logs under the id they watch (RS-9). Read by routine run only.
export const RUN_ID_ENV = 'SEALKEEPER_ROUTINE_RUN_ID';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const defaultRoutineDeps: RoutineDeps = {
  fetch: (...args) => fetch(...args),
};

export const DEFAULT_TIME = '10:00';
export const AGENTS = ['claude-code'] as const;
// Frameworks with no headless mode the routine could start.
const NOT_HEADLESS: Record<string, string> = {
  openclaw:
    'OpenClaw has no headless mode the routine can start. Have your own scheduler start the agent with the output of sealkeeper run --json, see the README',
  mastra:
    'a Mastra agent runs inside your own program, so there is nothing for the routine to start. Call sealkeeper run --json from a scheduled job of that program, see the README',
};

const FAILURES_TO_PAUSE = 3;
const LIST_LIMIT = 100;
// Pages of this agent's submitted tasks a run reads at most. One page
// holds 100, far more than a run confirms in a day.
const MAX_SUBMITTED_PAGES = 3;

export function register(
  parent: Command,
  deps: RoutineDeps = defaultRoutineDeps,
): Command {
  const routine = parent
    .command('routine')
    .description('An opt-in daily run that works toward the next level');

  routine
    .command('install')
    .description('Write a daily job with your scheduler, after asking')
    .option('--time <HH:MM>', 'local time of day to run', DEFAULT_TIME)
    .option('--agent <agent>', 'the agent to start headless', 'claude-code')
    .option('--yes', 'install without asking, for scripts')
    .action(async function (
      this: Command,
      options: { time: string; agent: string; yes?: boolean },
    ): Promise<void> {
      await install(this, deps, options);
    });

  routine
    .command('run')
    .description('One routine run now. The installed job calls this')
    .action(async function (this: Command): Promise<void> {
      await runOnce(this, deps);
    });

  routine
    .command('remove')
    .description(
      'Remove the daily job routine install wrote, also after logout or agent delete',
    )
    .action(async function (this: Command): Promise<void> {
      await remove(this, deps);
    });

  routine
    .command('pause')
    .description('Stop routine runs from doing anything until resume')
    .action(async function (this: Command): Promise<void> {
      await pause(this);
    });

  routine
    .command('resume')
    .description('Let routine runs work again after a pause')
    .action(async function (this: Command): Promise<void> {
      await resume(this);
    });

  return routine;
}

export function schedulerEnv(deps: RoutineDeps): SchedulerEnv {
  return {
    platform: (deps.platform ?? (() => process.platform))(),
    homedir: (deps.homedir ?? homedir)(),
    xdgConfigHome: readEnv('XDG_CONFIG_HOME'),
    uid: (deps.uid ?? (() => process.getuid?.() ?? 0))(),
  };
}

const cliOf = (deps: RoutineDeps) =>
  (
    deps.cli ?? (() => ({ program: cliProgram(), invocation: cliInvocation() }))
  )();

// install

// Everything install needs before it asks, so init can offer the same
// install after the Claude Code hooks. A string is the reason nothing can
// be installed, said as is. A scheduler that cannot be read throws a
// SchedulerError, and a broken routine.json a ConfigError.
export type PreparedInstall = {
  plan: Plan;
  agentCommand: string;
  current: RoutineConfig;
  env: SchedulerEnv;
  run: Runner;
  p: Paths;
  // The running CLI's script, copied to the home for the job (RS-2).
  source: string;
  // What the job runs, node, the copy and routine run.
  program: string[];
};

export const NO_CLAUDE =
  'claude was not found on PATH. Install Claude Code first, the routine starts it as claude -p';

export async function prepareInstall(
  deps: RoutineDeps,
  time: string,
  current?: RoutineConfig,
): Promise<PreparedInstall | string> {
  const run = deps.run ?? execRunner;
  const env = schedulerEnv(deps);
  const agentCommand = await (deps.findAgent ?? ((n) => findOnPath(n)))(
    'claude',
  );
  if (agentCommand === null) return NO_CLAUDE;
  const [node, source] = cliOf(deps).program;
  if (node === undefined || source === undefined) {
    return 'Run this from the sealkeeper CLI';
  }
  const routine = current ?? (await readRoutineConfig());
  const p = paths();
  // The job runs the copy, never the script that runs now, which may sit
  // in the npx cache (RS-2).
  const program = [node, copyPaths(p).script, 'routine', 'run'];
  const job = defaultJob(p, env);
  const scheduler = await detectScheduler(env, run);
  const planned = await planInstall(
    scheduler.kind,
    job,
    {
      time,
      program,
      env: jobEnv(p),
      home: p.home,
      outFile: routinePaths(p).out,
    },
    env,
    run,
  );
  const plan =
    scheduler.note === undefined
      ? planned
      : { ...planned, note: scheduler.note };
  return {
    plan,
    agentCommand,
    current: routine,
    env,
    run,
    p,
    source,
    program,
  };
}

// Copies the CLI for the job, then writes the job and records it in
// routine.json. A job from an earlier install under another name or
// scheduler goes first, so there is only ever one. Throws a
// SchedulerError when the copy cannot be written or the scheduler refuses.
export async function finishInstall(
  prepared: PreparedInstall,
  time: string,
): Promise<RoutineSchedule> {
  const { plan, current, env, run, p } = prepared;
  try {
    await writeCopy(prepared.source, p);
  } catch (error) {
    throw new SchedulerError(
      `nothing installed. This CLI could not be copied to ${copyPaths(p).script}: ${(error as Error).message}`,
    );
  }
  const old = current.schedule;
  if (old && (old.job !== plan.job || old.scheduler !== plan.scheduler)) {
    await removeJob(old, env, run);
  }
  await applyPlan(plan, run);
  const schedule: RoutineSchedule = {
    time,
    scheduler: plan.scheduler,
    agent: 'claude-code',
    agentCommand: prepared.agentCommand,
    job: plan.job,
    files: plan.files.map((f) => f.path),
    installedAt: new Date().toISOString(),
    program: prepared.program,
  };
  await writeRoutineConfig({ ...current, schedule }, p);
  return schedule;
}

// Refreshes the copy an installed job runs when its version is not this
// CLI's, as a repeat init does. Never when the running CLI is the copy.
// Returns whether it copied.
export async function refreshCopy(
  schedule: RoutineSchedule,
  deps: RoutineDeps,
  p: Paths = paths(),
): Promise<boolean> {
  if (schedule.program === undefined || !runsCopy(schedule.program, p)) {
    return false;
  }
  const source = cliOf(deps).program[1];
  if (source === undefined) return false;
  try {
    return (await writeCopy(source, p)) === 'copied';
  } catch {
    return false;
  }
}

export const installedLine = (time: string): string =>
  `Routine installed. It runs every day at ${time}. See it with ${cli('status')}, stop it with ${cli('routine pause')} or ${cli('routine remove')}.`;

async function install(
  cmd: Command,
  deps: RoutineDeps,
  options: { time: string; agent: string; yes?: boolean },
): Promise<void> {
  const json = wantsJson(cmd);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.time)) {
    cmd.error(`--time must be HH:MM on a 24 hour clock, got ${options.time}`);
  }
  if (!(AGENTS as readonly string[]).includes(options.agent)) {
    const why = NOT_HEADLESS[options.agent];
    cmd.error(
      why
        ? `nothing installed. ${why}`
        : `--agent must be one of ${AGENTS.join(', ')}, got ${options.agent}`,
    );
  }
  await requireConfig(cmd);
  const current = await loadRoutineConfig(cmd);
  let prepared: PreparedInstall | string;
  try {
    prepared = await prepareInstall(deps, options.time, current);
  } catch (error) {
    if (error instanceof SchedulerError) cmd.error(error.message);
    throw error;
  }
  if (typeof prepared === 'string') cmd.error(`nothing installed. ${prepared}`);

  // --json keeps the full preview, on stderr. A person reads the block.
  if (json) {
    for (const line of preview(prepared, options.time)) stderr(line);
  } else {
    const lines = blockLines(options.time, current.limits);
    for (const line of lines.slice(0, -1)) stdout(line);
    // The check line is dim where the terminal takes colour.
    const s = createStyle(process.stdout);
    stdoutStyled(s.line`${s.dim(checkLaterLine())}`);
  }

  let input: Input | undefined;
  if (options.yes !== true) {
    input = (deps.stdin ?? (() => streamInput(process.stdin)))();
    if (!input.isTTY) {
      cmd.error(
        `nothing installed. There is no terminal to ask, so run ${cli('routine install')} --yes after reading the lines above`,
      );
    }
    const yes = await askYes(input, (again) =>
      process.stderr.write(`${again}${INSTALL_QUESTION}`),
    );
    if (!yes) cmd.error('nothing installed');
  }

  let schedule: RoutineSchedule;
  try {
    schedule = await finishInstall(prepared, options.time);
  } catch (error) {
    if (error instanceof SchedulerError) cmd.error(error.message);
    throw error;
  }
  if (json) {
    stdout(
      JSON.stringify({ installed: true, schedule, limits: current.limits }),
    );
    return;
  }
  stdout(installedLine(options.time));
  // --yes is for scripts, which never start a run here.
  if (input === undefined) return;
  const now = await askYes(input, (again) =>
    process.stderr.write(`${again}${FIRST_RUN_QUESTION}`),
  );
  if (!now) {
    stdout(laterLine(options.time));
    return;
  }
  const routine = await loadRoutineConfig(cmd);
  await firstRun(deps, routine, prepared.p, {
    line: stdout,
    dim: stdout,
    indent: '',
  });
}

// The two questions of install, yes by default (D-RS-1, D-RS-2).
export const INSTALL_QUESTION = 'Install? [Y/n] ';
export const FIRST_RUN_QUESTION =
  'Run the first one now, so you see it work? [Y/n] ';
// Asked again after an answer that is not yes or no, up to this many
// questions in all, and then no.
export const MAX_ASKS = 3;

// Asks a question whose default is yes. prompt writes it, with again in
// front after an unclear answer. A closed input is no.
export async function askYes(
  input: Input,
  prompt: (again: string) => void,
): Promise<boolean> {
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    prompt(asked === 0 ? '' : 'Please answer y or n. ');
    const answer = readYesNo(await input.readLine(), 'yes');
    if (answer !== 'unclear') return answer === 'yes';
  }
  return false;
}

// Said after a no to the first run. The job runs later today when its time
// has not come yet.
export function laterLine(time: string, now: Date = new Date()): string {
  return `It runs ${nextRunText(time, now)}. Run one any time with ${cli('routine run')}.`;
}

// Said after the first run's line.
export const seeRunsLine = (): string => `See every run with ${cli('status')}.`;

// Said as the first run starts, since the agent may take minutes.
export const firstRunLine = (minutes: number): string =>
  `First run started. It stops within ${minutes} minutes.`;

// Said once under the started line, on a terminal (RS-9).
export const watchHintLine = (): string =>
  `Ctrl-C stops watching, the run keeps going. See it with ${cli('status')}.`;

// Said after a Ctrl-C.
export const STOPPED_WATCHING = 'Stopped watching. The run keeps going.';

const stdoutIsTTY = (deps: RoutineDeps): boolean =>
  (deps.stdoutTTY ?? (() => process.stdout.isTTY === true))();

// How the first run's lines are printed. init indents and dims them,
// routine install prints them as they are.
export type FirstRunPrint = {
  line: (text: string) => void;
  dim: (text: string) => void;
  indent: string;
};

// The first run after an install, as init and routine install start it
// (RS-3, RS-9). It runs detached, the command the scheduler runs, so it
// keeps going when the watching ends. The watcher prints a line per event
// as the run logs it, a spinner with the elapsed time on a terminal, then
// the run line and where to see every run. Ctrl-C ends the watching only.
export async function firstRun(
  deps: RoutineDeps,
  routine: RoutineConfig,
  p: Paths,
  print: FirstRunPrint,
): Promise<void> {
  const runId = randomUUID();
  const program = routine.schedule?.program ?? [
    ...cliOf(deps).program,
    'routine',
    'run',
  ];
  const { [ROUTINE_RUN_ENV]: _, ...env } = process.env;
  const started = (deps.startRun ?? startDetached)(
    {
      runId,
      program,
      env: {
        ...env,
        [RUN_ID_ENV]: runId,
        // What it prints, such as a pause's reason, names the CLI as this
        // one does.
        SEALKEEPER_INVOCATION: printedInvocation(),
        ...(homeEnv(p) === undefined ? {} : { SEALKEEPER_HOME: p.home }),
      },
      cwd: p.home,
      outFile: routinePaths(p).out,
    },
    deps,
  );
  const tty = stdoutIsTTY(deps);
  print.dim(firstRunLine(routine.limits.minutesPerRun));
  if (tty) print.dim(watchHintLine());
  const watched = await watchRun({
    runId,
    p,
    ended: started.ended,
    line: print.line,
    spinner: tty ? (process.stdout as SpinnerStream) : null,
    indent: print.indent,
    interrupt: deps.interrupt ?? onSigint,
    pollMs: deps.pollMs,
  });
  switch (watched.kind) {
    case 'done':
      for (const line of reportLines(watched)) print.line(line);
      break;
    case 'detached':
      print.line(STOPPED_WATCHING);
      break;
    case 'lost':
      print.line(
        watched.error === null
          ? `The first run ended without its run line. Its output is in ${tildePath(routinePaths(p).out)}.`
          : `The first run did not start, ${watched.error}.`,
      );
      break;
  }
  print.dim(seeRunsLine());
}

// The job name install gives this CLI home.
const defaultJob = (p: Paths, env: SchedulerEnv): string =>
  jobName(p.home, paths(join(env.homedir, '.sealkeeper')).home);

// PATH so the agent's launcher finds node under a scheduler's bare
// environment, and SEALKEEPER_HOME for any home but the root. The job does
// not start in the folder that picked the agent, so for a named home or a
// SEALKEEPER_HOME elsewhere it must say which one.
function jobEnv(p: Paths): Record<string, string> {
  const env: Record<string, string> = {};
  const path = process.env.PATH;
  if (path) env.PATH = path;
  const home = homeEnv(p);
  if (home !== undefined) env.SEALKEEPER_HOME = home;
  // The agent's working directory follows it, so the scheduled run and
  // agent delete agree on where it is.
  const cache = readEnv('XDG_CACHE_HOME');
  if (cache) env.XDG_CACHE_HOME = cache;
  return env;
}

// SEALKEEPER_HOME for a home that is not the root, else undefined.
const homeEnv = (p: Paths): string | undefined =>
  resolve(p.home) === resolve(sealkeeperRoot()) ? undefined : p.home;

// Said in status and after a failed agent. The routine's Claude
// Code loads none of the operator's settings files, see claudeArgs.
export const NO_SETTINGS_NOTE =
  "The routine's Claude Code runs without your Claude Code settings, so a login from an apiKeyHelper or an env block in settings.json does not reach it.";

// The one block init and routine install show before they ask (RS-1). A
// header with the time, four short rows with the limits from routine.json,
// then where to check it later. The scheduler and the job file are in
// status only.
export const BLOCK_TITLE = 'Daily routine';

export const blockHeadTail = (time: string): string =>
  `${time}, only when there is work`;

export function routineRows(limits: RoutineLimits): [string, string][] {
  return [
    ['Claims', 'Seed tasks and tasks from operators you allow'],
    ['Posts', '1 task a day when posting is behind'],
    ['Limits', limitsText(limits)],
    ['Why', 'Verified tasks get your agent to bronze'],
  ];
}

export const checkLaterLine = (): string =>
  `Check it later with ${cli('status')}`;

// The width of the label column of the rows.
export const BLOCK_LABEL = 9;

// The block as routine install prints it, without style. init prints the
// same lines with the label dim and the check line dim.
export function blockLines(time: string, limits: RoutineLimits): string[] {
  return [
    `${BLOCK_TITLE}   ${blockHeadTail(time)}`,
    '',
    ...routineRows(limits).map(
      ([label, text]) => `  ${label.padEnd(BLOCK_LABEL)}${text}`,
    ),
    '',
    checkLaterLine(),
  ];
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

// 300000 as 300k, only for whole thousands, anything else as it is.
const tokenCount = (n: number) =>
  n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString('en-US');

// The day's limits in the order claims, posts, minutes, tokens.
export function limitsText(limits: RoutineLimits): string {
  return `${plural(limits.claimsPerDay, 'claim', 'claims')}, ${plural(limits.postsPerDay, 'post', 'posts')}, ${limits.minutesPerRun} min, ${tokenCount(limits.tokensPerRun)} tokens a day`;
}

// Everything install writes and runs, in full, for --json on stderr and
// for tests. A person reads the block instead.
export function preview(prepared: PreparedInstall, time: string): string[] {
  const { plan, agentCommand, current: routine } = prepared;
  const lines = [
    `Every day at ${time}, ${plan.scheduler} runs ${cli('routine run')}.`,
    `When there is work within the daily limits it starts ${agentCommand} -p with the sealkeeper run instructions. Otherwise it starts nothing.`,
    '',
    'Unattended runs claim only seed tasks and tasks addressed to this agent by operators on the allowlist, and confirm only submissions from those operators. They post only when the goal says posting is behind, adopting a ready made task whose answer SealKeeper knows, or a template task SealKeeper checks when none is waiting. Everything else waits for you in status.',
    NO_SETTINGS_NOTE,
    ...(plan.note === undefined ? [] : [plan.note]),
    `Allowlist: ${allowedNames(routine)}. Add an operator with ${cli('config routine allow <operator>')}.`,
    '',
    'Limits',
    ...limitLines(routine.limits).map((l) => `  ${l}`),
    `Change them with ${cli('config routine set <limit> <value>')}.`,
    '',
    `Copies ${prepared.source} to ${prepared.program[1]}`,
  ];
  for (const file of plan.files) {
    lines.push('', `Writes ${file.path}`, ...indentAll(file.text));
  }
  if (plan.preview) lines.push('', ...plan.preview);
  lines.push('', 'Runs');
  for (const command of plan.commands) {
    lines.push(
      `  ${commandLine(command)}${command.input === undefined ? '' : ' (with the crontab above)'}`,
    );
  }
  lines.push('');
  return lines;
}

const indentAll = (text: string) =>
  text
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => `  ${l}`);

const LIMIT_TEXT: Record<keyof RoutineLimits, [string, string]> = {
  claimsPerDay: ['claims-per-day', 'tasks claimed per day'],
  networkClaimsPerDay: [
    'network-claims-per-day',
    "of those, other operators' template tasks",
  ],
  confirmsPerDay: ['confirms-per-day', 'outcomes confirmed per day'],
  postsPerDay: ['posts-per-day', 'tasks posted or adopted per day'],
  minutesPerRun: [
    'minutes-per-run',
    'minutes per run, then the agent is stopped',
  ],
  tokensPerRun: ['tokens-per-run', 'tokens per run, then the agent is stopped'],
};

export function limitLines(limits: RoutineLimits): string[] {
  return (Object.keys(LIMIT_TEXT) as (keyof RoutineLimits)[]).map(
    (key) => `${String(limits[key]).padStart(7)}  ${LIMIT_TEXT[key][1]}`,
  );
}

// The option names config routine set takes, to the config keys.
export const LIMIT_OPTIONS = Object.fromEntries(
  (Object.keys(LIMIT_TEXT) as (keyof RoutineLimits)[]).map((key) => [
    LIMIT_TEXT[key][0],
    key,
  ]),
) as Record<string, keyof RoutineLimits>;

// run

type RunTally = Pick<RunEntry, 'claimed' | 'submitted' | 'confirmed'> & {
  posted: number;
};

async function runOnce(cmd: Command, deps: RoutineDeps): Promise<void> {
  const json = wantsJson(cmd);
  const config = await requireConfig(cmd);
  const routine = await loadRoutineConfig(cmd);
  if (!routine.schedule) {
    cmd.error(`no routine is installed, run ${cli('routine install')} first`);
  }
  // The id a first run's watcher chose, else a new one.
  const given = readEnv(RUN_ID_ENV);
  const runId = given !== undefined && UUID.test(given) ? given : randomUUID();
  const p = paths();
  // By hand in a terminal, the run's events as they happen (RS-9). Ctrl-C
  // stops the run itself here, as it always has.
  const running = routineRun(deps, config, routine, p, runId);
  if (!json && stdoutIsTTY(deps)) {
    await watchRun({
      runId,
      p,
      ended: running.then(
        () => null,
        () => null,
      ),
      line: stdout,
      spinner: process.stdout,
      interrupt: null,
      pollMs: deps.pollMs,
    });
  }
  const report = await running;
  if (json) {
    stdout(JSON.stringify({ ...report.entry, paused: report.paused }));
  } else {
    for (const line of reportLines(report)) stdout(line);
  }
  if (report.entry.outcome === 'failed') process.exitCode = 1;
}

// What one run did, and the reason the routine paused itself after it,
// null when it did not.
export type RunReport = { entry: Omit<RunEntry, 'at'>; paused: string | null };

// The run line, and the pause when the run paused the routine.
export function reportLines(report: RunReport): string[] {
  return [
    runLine(report.entry),
    ...(report.paused ? [`The routine paused itself. ${report.paused}`] : []),
  ];
}

// One routine run for the installed schedule, as the job runs it. Logs the
// run line and returns it. Prints nothing. runId is the id its lines carry,
// a new one unless a watcher chose it (RS-9).
export async function routineRun(
  deps: RoutineDeps,
  config: Config,
  routine: RoutineConfig,
  p: Paths = paths(),
  runId: string = randomUUID(),
): Promise<RunReport> {
  const schedule = routine.schedule;
  const startedAt = new Date();
  let report: RunReport | null = null;
  // What the refresh did with the card, unset when card write wrote none.
  let card: string | null = null;
  // Whether the agent has the game section (GAME-14).
  let game = false;

  const finish = async (
    outcome: RunOutcome,
    reason: string | undefined,
    agent: AgentResult | null,
  ): Promise<void> => {
    const entries = await readRoutine(p);
    const entry: Omit<RunEntry, 'at'> = {
      kind: 'run',
      runId,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      startedAt: startedAt.toISOString(),
      agentStarted: agent !== null,
      ...tally(entries, runId),
      tokens: agent?.tokens ?? null,
      costUsd: agent?.costUsd ?? null,
      ...(card === null ? {} : { card }),
      ...(game ? { game: gameTally(entries, runId) } : {}),
    };
    await appendRoutine(entry, p);
    let paused: string | null = null;
    if (outcome === 'failed') {
      paused = await pauseAfterFailures(p);
    }
    report = { entry, paused };
  };
  const done = (): RunReport => {
    if (report === null) throw new Error('the routine run ended with no line');
    return report;
  };

  if (schedule === undefined) {
    await finish('skipped', 'no routine is installed', null);
    return done();
  }
  if (routine.paused) {
    await finish('skipped', `paused: ${routine.paused.reason}`, null);
    return done();
  }
  // Taken exclusively before anything is read, so two runs started at once
  // never both go on. Released when the run ends.
  const minutes = routine.limits.minutesPerRun;
  const timeoutMs = minutes * (deps.msPerMinute ?? 60_000);
  const locked = await acquireLock(
    {
      runId,
      pid: process.pid,
      deadline: new Date(Date.now() + timeoutMs + LOCK_MARGIN_MS).toISOString(),
    },
    p,
  );
  if (!locked) {
    await finish('skipped', 'another routine run is still going', null);
    return done();
  }
  const agentCommand = schedule.agentCommand;
  try {
    await lockedRun();
  } finally {
    await removeLock(runId, p);
  }
  return done();

  // The rest of the run, while this run holds the lock.
  async function lockedRun(): Promise<void> {
    // The card first, before the run decides whether there is work, so a
    // run with nothing to do or its limits spent still refreshes it
    // (VOU-383). In this process, never by the agent, and it spends no
    // limit. It never fails the run.
    card = await refreshCard(config, { fetch: deps.fetch }, p);
    const tasks = await taskWork();
    if (tasks.kind === 'failed') {
      await finish('failed', tasks.reason, null);
      return;
    }
    // The game (GAME-14), apart from the task work and its limits, since
    // SealKeeper holds it to the game cap. A run whose task work stopped
    // still starts the agent for the game alone.
    const session = tasks.session ?? (await openSession());
    game = 'api' in session && (await playsGame(session.api, session.signer));
    if (tasks.kind === 'stop' && !game) {
      await finish(tasks.outcome, tasks.reason, null);
      return;
    }
    const work: TaskPlan =
      tasks.kind === 'work' ? tasks : { confirm: [], post: null, run: false };

    const { invocation } = cliOf(deps);
    let workDir: string;
    try {
      workDir = await ensureWorkDir(p);
    } catch (error) {
      await finish(
        'failed',
        `no working directory: ${(error as Error).message}`,
        null,
      );
      return;
    }
    // tasks post in this run reads the choice from the run lock and posts
    // nothing else, the adoption or its template.
    const { post } = work;
    if (post !== null) await setRunPost(runId, post, p);
    const agent = await runAgent(
      {
        command: agentCommand,
        args: claudeArgs(invocation, post, game),
        input: routinePrompt(invocation, work.confirm, {
          post,
          run: work.run,
          game,
        }),
        cwd: workDir,
        env: agentEnv(runId, invocation, p),
        timeoutMs,
        tokenCap: routine.limits.tokensPerRun,
        // Kept for the operator, never printed (RS-10).
        transcript: { path: copyPaths(p).transcript },
      },
      deps.spawner ?? spawnAgent,
    );

    if (agent.stoppedFor !== null) {
      const used =
        agent.stoppedFor === 'minutesPerRun' ? minutes : (agent.tokens ?? 0);
      const cap =
        agent.stoppedFor === 'minutesPerRun'
          ? minutes
          : routine.limits.tokensPerRun;
      await appendRoutine(
        { kind: 'limit', runId, limit: agent.stoppedFor, used, cap },
        p,
      );
    }
    if (agent.error !== undefined) {
      await finish('failed', `the agent did not start: ${agent.error}`, null);
    } else if (agent.stoppedFor === 'minutesPerRun') {
      await finish('failed', `stopped after ${minutes} minutes`, agent);
    } else if (agent.stoppedFor === 'tokensPerRun') {
      await finish(
        'stopped',
        `stopped at the limit of ${routine.limits.tokensPerRun} tokens`,
        agent,
      );
    } else if (agent.exitCode !== 0) {
      await finish(
        'failed',
        `the agent exited with ${agent.exitCode}. If it could not log in, its Claude Code runs without your settings files, so a login from an apiKeyHelper or an env block in settings.json does not reach it`,
        agent,
      );
    } else {
      await finish('done', undefined, agent);
    }
  }

  // The task work of the run, read before any agent starts. stop is why
  // there is none, with the outcome the run ends with when the game does
  // not start the agent either, failed ends the run whatever the game.
  async function taskWork(): Promise<
    | {
        kind: 'stop';
        outcome: RunOutcome;
        reason: string;
        session?: Session;
      }
    | { kind: 'failed'; reason: string }
    | ({ kind: 'work' } & TaskPlan & { session: Session })
  > {
    const entries = await readRoutine(p);
    const claims = budgetOf(entries, 'claim', routine);
    const confirms = budgetOf(entries, 'confirm', routine);
    const posts = budgetOf(entries, 'post', routine);
    // A limit line for each spent limit. The post limit is named only when
    // it is spent too.
    const spent = async () => {
      for (const [limit, budget] of [
        ['claimsPerDay', claims],
        ['confirmsPerDay', confirms],
        ['postsPerDay', posts],
      ] as const) {
        if (limit === 'postsPerDay' && budget.remaining > 0) continue;
        await appendRoutine(
          { kind: 'limit', runId, limit, used: budget.used, cap: budget.cap },
          p,
        );
      }
      return {
        kind: 'stop',
        outcome: 'stopped',
        reason: 'the daily limits are spent',
      } as const;
    };
    if (
      claims.remaining === 0 &&
      confirms.remaining === 0 &&
      posts.remaining === 0
    ) {
      return spent();
    }

    const goal = await loadGoal({ fetch: deps.fetch, paths: p }).catch(
      () => null,
    );
    // What to post once this run, when the goal says posting is behind and
    // the day's post limit has room (POST-7). A ready made task adopted in
    // the category of the template it would post, that template when none
    // is waiting (RT-12).
    const post =
      posts.remaining > 0 && goal !== null && postingBehind(goal)
        ? nextRoutinePost(entries)
        : null;
    if (claims.remaining === 0 && confirms.remaining === 0 && post === null) {
      return spent();
    }
    if (
      goal !== null &&
      goal.nextLevel === null &&
      goal.pending.addressed === 0 &&
      goal.pending.outcomes === 0 &&
      (goal.pending.posterOutcomes ?? 0) === 0
    ) {
      return {
        kind: 'stop',
        outcome: 'nothing',
        reason: `level ${shownLevel(goal.level)} is ${HIGHEST_ISSUED}`,
      };
    }
    // Counted evidence (VOU-140). Once today's counted tasks reach the daily
    // ceiling, more work today would verify and count toward nothing, so the
    // run claims and confirms nothing and waits for the next UTC day. A post
    // counts for the poster apart from that ceiling, so it still goes.
    const today = todayOf(goal);
    const ceiling = today !== null && dailyCeilingReached(today);
    if (today !== null && ceiling) {
      await appendRoutine(
        {
          kind: 'limit',
          runId,
          limit: 'dailyCountCeiling',
          used: today.counted,
          cap: today.ceiling,
        },
        p,
      );
      if (post === null) {
        return {
          kind: 'stop',
          outcome: 'stopped',
          reason: `today's ${today.ceiling} counted tasks are done, more would not count until midnight UTC`,
        };
      }
    }

    // What there is to do, read before any agent starts. The key is loaded
    // here rather than through openTaskSession, which ends the command on a
    // missing or broken key. That exit would skip the finally that removes
    // the run lock and leave no run line (cli-adapters-tasks-5).
    const session = await openSession();
    if (!('api' in session)) return { kind: 'failed', reason: session.error };
    const { api, signer } = session;
    let held: TaskResponse[] = [];
    let found: RoutineCandidates = { tasks: [], skipped: [] };
    let confirm: Confirmable[] = [];
    try {
      // Only the post is left once the ceiling is reached, so nothing is
      // read for claims or confirmations.
      if (!ceiling) {
        const now = Date.now();
        const posters = new PosterLookup(api);
        // Held tasks the routine may not work wait for a person, like open
        // tasks from others, and start no agent.
        const kept = await routineHeld(
          posters,
          (await serverHeld(api, signer.agentId)).filter(
            (task) => Date.parse(task.expiresAt) > now,
          ),
          config,
          routine,
        );
        held = kept.tasks;
        found =
          claims.remaining > 0
            ? await routineCandidates(
                api,
                posters,
                signer,
                config,
                routine,
                undefined,
                {
                  networkRemaining: networkBudgetOf(entries, routine).remaining,
                  barredOperators: barredOperators(entries),
                  operatorsToday: networkOperatorsToday(entries),
                },
              )
            : { tasks: [], skipped: [] };
        const pending = await pendingConfirmations(
          api,
          signer,
          routine,
          confirms.remaining,
        );
        confirm = pending.confirm;
        await logSkips(
          entries,
          [...kept.skipped, ...found.skipped, ...pending.skipped],
          runId,
          now,
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          kind: 'failed',
          reason: `could not read the API: ${error.message}`,
        };
      }
      throw error;
    }

    if (
      held.length === 0 &&
      found.tasks.length === 0 &&
      confirm.length === 0 &&
      post === null
    ) {
      return {
        kind: 'stop',
        outcome: 'nothing',
        reason:
          claims.remaining === 0
            ? 'the daily claim limit is spent and nothing waits for a confirmation'
            : "no seed tasks, allowed addressed tasks, other operators' template tasks or confirmations to do",
        session,
      };
    }
    return { kind: 'work', confirm, post, run: !ceiling, session };
  }

  // The API client and the agent key, or why they could not be had.
  async function openSession(): Promise<Session> {
    try {
      const api = createApiClient({
        apiUrl: resolveApiUrl({ config: config.apiUrl }),
        fetch: deps.fetch,
      });
      return { api, signer: await loadSigner(api.apiUrl, p) };
    } catch (error) {
      if (error instanceof KeyError) {
        return { error: `the agent key could not be loaded: ${error.message}` };
      }
      if (error instanceof ApiError) {
        return { error: `could not read the API: ${error.message}` };
      }
      throw error;
    }
  }
}

// The agent's environment. SEALKEEPER_ROUTINE_RUN puts its commands under
// the routine rules. SEALKEEPER_INVOCATION is the invocation its Bash rules
// and prompt spell, so every command the CLI prints for it, such as each
// task's submit line from run --json, matches its rule exactly, whatever
// started the run (RS-11). SEALKEEPER_HOME names the home of this run, so a
// first run started from init in a bound folder works for that agent, as
// the job does. A watcher's run id stays with the run.
export function agentEnv(
  runId: string,
  invocation: string,
  p: Paths,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const { [RUN_ID_ENV]: _, ...rest } = env;
  return {
    ...rest,
    SEALKEEPER_ROUTINE_RUN: runId,
    SEALKEEPER_INVOCATION: invocation,
    ...(homeEnv(p) === undefined ? {} : { SEALKEEPER_HOME: p.home }),
  };
}

// What a run's agent does beside the game, see PromptWork.
type TaskPlan = {
  confirm: Confirmable[];
  post: RunPost | null;
  run: boolean;
};

// The API client and the agent key of a run, or why they could not be had.
type Session = { api: ApiClient; signer: Signer } | { error: string };

// Whether the run's agent plays the game (GAME-14). True when the game is
// on for this agent and it has game units left today, or a duel of it is
// running, whose task waits to be played whatever the units. Read with the
// signed game status and, with no units left, one signed page of one of
// its active duels. A read that fails, as on an API from before the game,
// is false, so the run goes on without the game.
export async function playsGame(
  api: ApiClient,
  signer: Signer,
): Promise<boolean> {
  try {
    const status = await readGameStatus({ api, signer });
    if (!status.enabled) return false;
    if (status.usedToday < status.cap) return true;
    const request = {
      state: 'active',
      limit: 1,
      issuedAt: new Date().toISOString(),
    };
    ListDuelsRequest.parse(request);
    return (await api.myDuels(await signer.sign(request))).duels.length > 0;
  } catch {
    return false;
  }
}

// What a run's game section did, from its game lines, each duel, task or
// seek once (GAME-14).
export function gameTally(
  entries: RoutineEntry[],
  runId: string,
): NonNullable<RunEntry['game']> {
  const count = (action: GameEntry['action']) =>
    new Set(
      entries.flatMap((e) =>
        e.kind === 'game' && e.runId === runId && e.action === action
          ? [e.id]
          : [],
      ),
    ).size;
  return {
    accepted: count('accept'),
    played: count('duel'),
    challenge: count('challenge'),
    seeks: count('seek'),
  };
}

// How long past the wall clock limit the run lock lasts, for the reads
// before the agent starts. A lock whose process is gone is stale sooner.
const LOCK_MARGIN_MS = 10 * 60_000;

function tally(entries: RoutineEntry[], runId: string): RunTally {
  const count = (kind: RoutineEntry['kind']) =>
    entries.filter((e) => e.kind === kind && 'runId' in e && e.runId === runId)
      .length;
  return {
    claimed: count('claim'),
    submitted: count('submit'),
    confirmed: count('confirm'),
    posted: count('post'),
  };
}

// After a failed run, pauses the routine when it was the third in a row.
// Returns the reason, or null when it did not pause.
async function pauseAfterFailures(p: Paths): Promise<string | null> {
  const entries = await readRoutine(p);
  if (failureStreak(entries) < FAILURES_TO_PAUSE) return null;
  const last = [...entries]
    .reverse()
    .find((e): e is RunEntry => e.kind === 'run');
  const reason = `${FAILURES_TO_PAUSE} failed runs in a row, the last: ${last?.reason ?? 'unknown'}. Run ${cli('routine resume')} once it is fixed`;
  const at = new Date().toISOString();
  // Read again, the run may have taken a while.
  const routine = await readRoutineConfig(p);
  await writeRoutineConfig({ ...routine, paused: { at, reason } }, p);
  await appendRoutine({ kind: 'pause', at, reason }, p);
  return reason;
}

// Counterparty tasks this agent posted whose submission waits for its
// verdict and that a routine run may judge. Only submissions from operators
// on the allowlist, which this agent has not reported on yet, up to the
// confirmations left today. Others are returned as skips. Throws what the
// API client throws.
async function pendingConfirmations(
  api: ApiClient,
  signer: Signer,
  routine: RoutineConfig,
  remaining: number,
): Promise<{ confirm: Confirmable[]; skipped: RoutineCandidates['skipped'] }> {
  const confirm: Confirmable[] = [];
  const skipped: RoutineCandidates['skipped'] = [];
  // Only this agent's own tasks, so submitted tasks of other posters never
  // push these off the page (VOU-208). Oldest first, up to
  // MAX_SUBMITTED_PAGES pages.
  const submitted: TaskResponse[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SUBMITTED_PAGES; page++) {
    const read = await api.listTasksPage({
      state: 'submitted',
      poster: signer.agentId,
      limit: LIST_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    submitted.push(...read.tasks);
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  // Each claimant looked up once, null when the lookup fails.
  const claimants = new Map<string, AgentResponse | null>();
  for (const task of submitted) {
    if (!awaitingVerdict(task, signer.agentId)) continue;
    const claimant = task.claimantAgentId;
    if (claimant === null) continue;
    if (!claimants.has(claimant)) {
      let agent: AgentResponse | null = null;
      try {
        agent = await api.getAgent(claimant);
      } catch {
        // Unknown, so not allowed.
      }
      claimants.set(claimant, agent);
    }
    const agent = claimants.get(claimant) ?? null;
    if (!isAllowed(routine, agent)) {
      const slug = agent === null ? undefined : operatorSlugOf(agent);
      skipped.push({
        action: 'confirm',
        taskId: task.id,
        reason: 'claimant_not_allowed',
        taskType: task.taskType,
        ...(slug === undefined ? {} : { operator: slug }),
      });
      continue;
    }
    if (confirm.length >= remaining) continue;
    const read = await fetchSubmission(api, signer, task.id);
    if (read.reports.poster !== null) continue;
    const submission = read.task.submission;
    if (submission === undefined) continue;
    confirm.push({ task: read.task, submission });
  }
  return { confirm, skipped };
}

export function runLine(entry: Omit<RunEntry, 'at'>): string {
  const head: Record<RunOutcome, string> = {
    done: 'Routine run done.',
    nothing: 'Routine run found nothing to do, no agent started.',
    stopped: 'Routine run stopped.',
    failed: 'Routine run failed.',
    skipped: 'Routine run skipped, no agent started.',
  };
  const parts = [head[entry.outcome]];
  if (entry.reason) parts.push(`${capital(entry.reason)}.`);
  if (entry.agentStarted) {
    parts.push(
      `Claimed ${entry.claimed}, submitted ${entry.submitted}, confirmed ${entry.confirmed}, posted ${entry.posted ?? 0}.`,
    );
    parts.push(`${spent(entry)}.`);
  }
  const card = entry.card === undefined ? undefined : CARD_TEXT.get(entry.card);
  if (card !== undefined) parts.push(card);
  return parts.join(' ');
}

// The game line of the routine in status, the last run's counts
// (GAME-14).
export function gameText(game: NonNullable<RunEntry['game']>): string {
  return `last run accepted ${plural(game.accepted, 'invite', 'invites')}, played ${plural(game.played, 'duel', 'duels')}, submitted ${plural(game.challenge, 'challenge task', 'challenge tasks')}, opened ${plural(game.seeks, 'seek', 'seeks')}`;
}

// What a run did with the card, by the value refreshCard returned. A value
// a newer CLI wrote is left out.
const CARD_TEXT = new Map<string, string>([
  ['refreshed', 'Card refreshed.'],
  ['current', 'Card up to date.'],
  ['offline', 'Card kept, the API could not be reached.'],
  ['withheld', 'Card kept, no SEAL is issued for this agent now.'],
  ['gone', 'Card not refreshed, its file is gone.'],
  ['changed', 'Card not refreshed, the file holds another card.'],
  ['unwritable', 'Card not refreshed, its file could not be written.'],
  ['failed', 'Card not refreshed, the SEAL could not be read.'],
] satisfies [CardRefresh, string][]);

const capital = (text: string) =>
  text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;

function spent(entry: Pick<RunEntry, 'tokens' | 'costUsd'>): string {
  const tokens =
    entry.tokens === null
      ? 'No tokens reported'
      : `${entry.tokens.toLocaleString('en-US')} tokens`;
  return entry.costUsd === null
    ? tokens
    : `${tokens}, $${entry.costUsd.toFixed(2)}`;
}

// The routine part of status (VOU-596). Everything here is local, read
// from routine.json, routine.jsonl and the scheduler, so it shows offline.

export type RoutineView = {
  // What status --json carries under local.routine.
  json: Record<string, unknown>;
  // The lines of the Routine section of status, without the label.
  lines: string[];
  // The job's copy is out of date or gone (RS-2), said on stderr.
  warnings: string[];
};

/*
 * The routine as status shows it, on or off, the next run, what the last
 * run did and what waits for a person, with the linger note where it
 * applies. json keeps every detail, the limits, the allowlist, the job,
 * the copy, the transcript, the card and the warnings about the job's copy
 * of the CLI, which status says on stderr. A routine.json that cannot be read is said in one line, never
 * thrown, so it never fails status.
 */
export async function routineView(
  deps: RoutineDeps,
  p: Paths = paths(),
  now: Date = new Date(),
): Promise<RoutineView> {
  let routine: RoutineConfig;
  try {
    routine = await readRoutineConfig(p);
  } catch (error) {
    const why = (error as Error).message;
    return { json: { error: why }, lines: [why], warnings: [] };
  }
  const config = await readConfig(p).catch(() => null);
  const entries = await readRoutine(p);
  const today = {
    claims: budgetOf(entries, 'claim', routine, now),
    confirms: budgetOf(entries, 'confirm', routine, now),
    posts: budgetOf(entries, 'post', routine, now),
  };
  const lastRun =
    entries.filter((e): e is RunEntry => e.kind === 'run').at(-1) ?? null;
  const waiting = waitingForPerson(entries, now);
  const active = await readLiveLock(p);
  const warnings = await routineJobWarnings(p);
  const transcript = existsSync(copyPaths(p).transcript)
    ? copyPaths(p).transcript
    : null;
  const cardRecord =
    config === null ? null : await readCardRecord(config.agentId, p);
  const s = routine.schedule;
  const nextRun =
    s === undefined || routine.paused ? null : nextRunText(s.time, now);
  // Without lingering systemd stops the timer at logout (RS-4).
  const linger =
    s?.scheduler === 'systemd' &&
    !(await lingers(schedulerEnv(deps), deps.run ?? execRunner));

  const json = {
    installed: s !== undefined,
    schedule: s ?? null,
    paused: routine.paused ?? null,
    running: active !== null,
    nextRun,
    limits: routine.limits,
    today: {
      claimed: today.claims.used,
      confirmed: today.confirms.used,
      posted: today.posts.used,
    },
    allow: routine.allow,
    allowSlugs: routine.allowSlugs,
    lastRun,
    transcript,
    card:
      cardRecord === null
        ? null
        : { path: cardRecord.path, writtenAt: cardRecord.writtenAt },
    waiting,
    copy: {
      path: copyPaths(p).script,
      version: await copyVersion(p),
      cliVersion: VERSION,
    },
    notes: [NO_SETTINGS_NOTE, ...(linger ? [LINGER_NOTE] : [])],
    warnings,
  };

  const lines: string[] = [];
  if (s === undefined) {
    lines.push(`off, not installed. ${cli('routine install')} sets it up`);
  } else if (routine.paused) {
    lines.push(`paused, ${routine.paused.reason}`);
  } else {
    lines.push(
      `on, every day at ${s.time} with ${s.scheduler}, next run ${nextRun}`,
    );
  }
  if (active !== null) lines.push('a run is going now');
  if (s !== undefined) {
    lines.push(
      `today claimed ${today.claims.used} of ${today.claims.cap}, confirmed ${today.confirms.used} of ${today.confirms.cap}, posted ${today.posts.used} of ${today.posts.cap}`,
    );
  }
  if (s !== undefined) lines.push(...jobWhere(s, schedulerEnv(deps)));
  if (lastRun !== null) {
    lines.push(`last run ${lastRun.at}. ${runLine(lastRun)}`);
    // What the last run's game section did, when it had one (GAME-14).
    if (lastRun.game !== undefined) {
      lines.push(`game, ${gameText(lastRun.game)}`);
    }
  } else if (s !== undefined) {
    lines.push('last run none yet');
  }
  // Where the last run's transcript is, never what it says (RS-10).
  if (transcript !== null) lines.push(`transcript ${tildePath(transcript)}`);
  // The card card write last wrote, which each run refreshes (VOU-383).
  if (cardRecord !== null) {
    lines.push(
      `card ${tildePath(cardRecord.path)}, last written ${cardRecord.writtenAt}`,
    );
  }
  if (linger) lines.push(LINGER_NOTE);
  if (waiting.length > 0) {
    lines.push(`waiting for you, from the last ${SKIP_LIST_DAYS} days`);
    for (const item of waiting) lines.push(`  ${waitingLine(item)}`);
  }
  return { json, lines, warnings };
}

// Where the job is (RS-4), one line for each file, the crontab entry or
// the task.
function jobWhere(s: RoutineSchedule, env: SchedulerEnv): string[] {
  switch (s.scheduler) {
    case 'launchd':
    case 'systemd':
      return s.files.map((f) => `job file ${tildePath(f, env.homedir)}`);
    case 'cron':
      return [`job in the crontab, marked ${s.job}`];
    case 'schtasks':
      return [`job in Task Scheduler, ${schtasksName(s.job)}`];
  }
}

// When the job runs next, "today at 10:00" while its time has not come
// yet, else "tomorrow at 10:00", in local time.
export function nextRunText(time: string, now: Date = new Date()): string {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const today = now.getHours() * 60 + now.getMinutes() < hour * 60 + minute;
  return `${today ? 'today' : 'tomorrow'} at ${time}`;
}

// A skip that waits for a person, every reason but too_new.
type PersonSkip = SkipEntry & {
  reason: Exclude<SkipEntry['reason'], 'too_new'>;
};

// Skipped work from the last week, newest first, one line per task and
// action. A too_new skip is left out, since a later run takes the task.
export function waitingForPerson(
  entries: RoutineEntry[],
  now: Date,
): PersonSkip[] {
  const since = now.getTime() - SKIP_LIST_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const out: PersonSkip[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as RoutineEntry;
    if (e.kind !== 'skip' || Date.parse(e.at) < since) continue;
    if (e.reason === 'too_new') continue;
    const key = `${e.action}:${e.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, reason: e.reason });
  }
  return out;
}

function waitingLine(skip: PersonSkip): string {
  const by = skip.operator ? ` from ${skip.operator}` : '';
  const type = skip.taskType ? ` ${skip.taskType}` : '';
  switch (skip.reason) {
    case 'open_task':
      return `open${type} task ${skip.taskId}${by}. Take it with ${cli(`tasks claim ${skip.taskId}`)}`;
    case 'poster_not_allowed':
      return `addressed${type} task ${skip.taskId}${by}, not on the allowlist. Take it with ${cli(`tasks claim ${skip.taskId}`)}`;
    case 'claimant_not_allowed':
      return `submission to${type} task ${skip.taskId}${by}, not on the allowlist. Judge it with ${cli(`tasks outcome ${skip.taskId} success|failure`)}`;
  }
}

// remove, pause, resume

async function remove(cmd: Command, deps: RoutineDeps): Promise<void> {
  const p = paths();
  const routine = await loadRoutineConfig(cmd);
  const env = schedulerEnv(deps);
  const run = deps.run ?? execRunner;
  let result: { removed: string[]; kept: string[] };
  try {
    // Without settings, as after logout or agent delete in an earlier
    // version, the job this home would have is looked for by name, and
    // only what carries the marker goes.
    result = routine.schedule
      ? await removeJob(routine.schedule, env, run)
      : await removeJobByName(defaultJob(p, env), env, run);
  } catch (error) {
    if (error instanceof SchedulerError) cmd.error(error.message);
    throw error;
  }
  if (routine.schedule) {
    const { schedule: _, ...rest } = routine;
    await writeRoutineConfig(rest, p);
  }
  // The copy of the CLI the job ran goes with it (RS-2).
  result.removed.push(...(await removeCopy(p)));
  if (wantsJson(cmd)) {
    stdout(JSON.stringify(result));
    return;
  }
  if (!routine.schedule && result.removed.length === 0) {
    stdout('No routine job is installed, nothing removed.');
    for (const path of result.kept) {
      stdout(`  kept ${tildePath(path)}, it was not written by SealKeeper`);
    }
    return;
  }
  stdout('Routine removed. No more daily runs.');
  for (const line of removedLines(result)) stdout(line);
  stdout(
    `The limits, the allowlist and ${tildePath(routinePaths(p).log)} are kept.`,
  );
}

// What logout and agent delete say about the routine job.
export function jobLines(result: {
  removed: string[];
  kept: string[];
}): string[] {
  const head =
    result.removed.length > 0
      ? ['removed the daily routine job']
      : [
          'the daily routine job was kept, its files were not written by SealKeeper',
        ];
  return [...head, ...removedLines(result)];
}

export function removedLines(result: {
  removed: string[];
  kept: string[];
}): string[] {
  return [
    ...result.removed.map((path) => `  removed ${tildePath(path)}`),
    ...result.kept.map(
      (path) => `  kept ${tildePath(path)}, it was not written by SealKeeper`,
    ),
  ];
}

// The installed routine job, for logout and agent delete, which remove it
// with the rest. null when routine.json names none or does not read.
export async function installedJob(
  p: Paths = paths(),
): Promise<RoutineSchedule | null> {
  try {
    return (await readRoutineConfig(p)).schedule ?? null;
  } catch {
    return null;
  }
}

// Removes the job routine.json names and forgets it there, keeping the
// limits and the allowlist. When every file of it was kept as not ours,
// the job stays recorded. null when none is installed. Throws
// SchedulerError when the scheduler refuses.
export async function uninstallJob(
  deps: RoutineDeps,
  p: Paths = paths(),
): Promise<{ removed: string[]; kept: string[] } | null> {
  const schedule = await installedJob(p);
  const env = schedulerEnv(deps);
  const run = deps.run ?? execRunner;
  if (schedule === null) {
    // routine.json is missing, broken or names no job. The job this home
    // would have is looked for by name, so a deleted agent never keeps a
    // daily job. Only what carries the marker goes.
    const found = await removeJobByName(defaultJob(p, env), env, run);
    return found.removed.length === 0 && found.kept.length === 0 ? null : found;
  }
  const result = await removeJob(schedule, env, run);
  if (result.removed.length > 0 || result.kept.length === 0) {
    const { schedule: _, ...rest } = await readRoutineConfig(p);
    await writeRoutineConfig(rest, p);
    result.removed.push(...(await removeCopy(p)));
  }
  return result;
}

async function pause(cmd: Command): Promise<void> {
  const routine = await loadRoutineConfig(cmd);
  if (routine.paused) {
    say(cmd, { paused: routine.paused }, 'The routine is already paused.');
    return;
  }
  const paused = { at: new Date().toISOString(), reason: 'paused by you' };
  await writeRoutineConfig({ ...routine, paused });
  await appendRoutine({ kind: 'pause', ...paused });
  say(
    cmd,
    { paused },
    `Routine paused. Runs start no agent until ${cli('routine resume')}.`,
  );
}

async function resume(cmd: Command): Promise<void> {
  const routine = await loadRoutineConfig(cmd);
  if (!routine.paused) {
    say(cmd, { paused: null }, 'The routine is not paused.');
    return;
  }
  const { paused: _, ...rest } = routine;
  await writeRoutineConfig(rest);
  await appendRoutine({ kind: 'resume' });
  say(cmd, { paused: null }, 'Routine resumed.');
}

function say(cmd: Command, json: unknown, text: string): void {
  stdout(wantsJson(cmd) ? JSON.stringify(json) : text);
}
