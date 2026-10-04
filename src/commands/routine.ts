// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GameCap,
  OperatorSlug,
  RoutineNextRequest,
  type TaskOutcome,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from '../api.js';
import { cleanAnswer, type Input, readYesNo, streamInput } from '../ask.js';
import { type CardRefresh, readCardRecord, refreshCard } from '../card.js';
import { cliInvocation, cliProgram } from '../claude-code-settings.js';
import { loadRoutineConfig, requireConfig } from '../cli-config.js';
import {
  type Config,
  ConfigError,
  type Paths,
  paths,
  ROUTINE_LIMIT_MAX,
  ROUTINE_LIMIT_MIN,
  ROUTINE_TIME,
  type RoutineConfig,
  type RoutineLimits,
  type RoutineSchedule,
  readConfig,
  readRoutineConfig,
  sealkeeperRoot,
  writeFileAtomic,
  writeRoutineConfig,
} from '../config.js';
import { readEnv } from '../env.js';
import { tildePath } from '../files.js';
import { BAD_CAP, changeGame, gameRefusal, readGameStatus } from '../game.js';
import { KeyError, loadSigner, type Signer } from '../identity.js';
import { cli, printedInvocation } from '../invocation.js';
import { readOperatorSlug } from '../operator-slug.js';
import {
  JSON_FLAG,
  JSON_HELP,
  stderr,
  stdout,
  stdoutStyled,
  wantsJson,
} from '../output.js';
import { gameOnHint } from '../refusal.js';
import type { RoutineAnswerResponse } from '../responses.js';
import {
  acquireLock,
  allowedNames,
  appendRoutine,
  ensureWorkDir,
  normalLogin,
  type RoutineEntry,
  type RunEntry,
  type RunOutcome,
  readLiveLock,
  readRoutine,
  removeLock,
  routineAllow,
  routinePaths,
} from '../routine.js';
import {
  type AgentResult,
  type AgentRuntime,
  claudeCodeRuntime,
  findOnPath,
  type Spawner,
  Transcript,
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
  answerOf,
  judgePrompt,
  type RoutineJudgeItem,
  type RoutineTask,
  taskPrompt,
  verdictOf,
} from '../routine-prompt.js';
import {
  applyPlan,
  commandLine,
  detectScheduler,
  execRunner,
  jobFiles,
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
import { VERSION } from '../version.js';
import { releaseClaim } from './release.js';
import { recordClaims } from './run.js';
import { SubmitRefused, submitAnswer } from './submit.js';

/*
 * sealkeeper routine (VOU-136, VOU-138, VOU-599), the routine verb of the
 * core commands. An opt-in daily run that works toward the next level
 * unattended.
 *
 *   routine      Not set up, the guided setup in a terminal: the agent
 *                found on this machine, the time, tasks only or tasks and
 *                the game, the limits, then the job with the operator's
 *                own scheduler and one run now, watched (RS-9). Set up, the
 *                routine screen. --files prints the job in full.
 *   routine on   Writes the job, or writes it again.
 *   routine off  Removes the job. Nothing runs until on.
 *   routine set  The time, a limit, whether to play the game, the game cap
 *                and the allowlist.
 *   routine run  Hidden. The job runs it.
 *
 * Every form that changes something takes --yes, which stands for the
 * user's clear yes, so an agent may run it after that yes. Without --yes
 * and without a terminal it refuses and changes nothing.
 *
 * The job runs a copy of this CLI under the home (RS-2) with routine run,
 * a plain loop over the routine route (VOU-594), which the API drives. The
 * CLI asks for the next action with the run id, the limits and the
 * allowlist, and carries out what is left for it. A task goes to the agent
 * as one question with no tools, its spec, its schema and the answer
 * rules, and the text it answers is written and submitted through the
 * submit path. A submission to judge goes to the agent the same way, and
 * its verdict goes back with the next call, which the API reports through
 * the outcome path. It stops when the API says done, at the wall clock or
 * at the token cap, whichever comes first. The agent never runs a command,
 * so a spec cannot make it run one. sealkeeper status shows the last run in
 * short (routineView).
 */

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
  // The wait before a step is asked again, tests pass none.
  sleep?: (ms: number) => Promise<void>;
};

// Starts one routine run to watch, as the first run after a setup.
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

// Set by init and the setup on the first run they start, so the run logs
// under the id they watch (RS-9). Read by routine run only.
export const RUN_ID_ENV = 'SEALKEEPER_ROUTINE_RUN_ID';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const defaultRoutineDeps: RoutineDeps = {
  fetch: (...args) => fetch(...args),
};

// The runtimes the routine can start, by name, with how people read it.
const RUNTIME_NAME: Record<RoutineSchedule['agent'], string> = {
  'claude-code': 'Claude Code',
};

export function register(
  parent: Command,
  deps: RoutineDeps = defaultRoutineDeps,
): Command {
  const routine = parent
    .command('routine')
    .description(
      'Set up the daily run when it is not, else show it. on, off and set manage it',
    )
    .option('--files', 'print the job the scheduler runs, in full')
    .option(JSON_FLAG, JSON_HELP)
    .option(
      '--yes',
      "set it up with the settings shown, only after the user's clear yes",
    )
    .action(async function (
      this: Command,
      options: { files?: boolean; yes?: boolean },
    ): Promise<void> {
      await routineCommand(this, deps, options);
    });

  routine
    .command('on')
    .description('Write the daily job, or write it again')
    .option('--yes', "write it without asking, only after the user's clear yes")
    .action(async function (
      this: Command,
      options: { yes?: boolean },
    ): Promise<void> {
      await on(this, deps, options);
    });

  routine
    .command('off')
    .description('Remove the daily job, nothing runs until on')
    .option(
      '--yes',
      "remove it without a terminal, only after the user's clear yes",
    )
    .action(async function (
      this: Command,
      options: { yes?: boolean },
    ): Promise<void> {
      await off(this, deps, options);
    });

  const set = routine
    .command('set')
    .description(
      'Change the time, a limit, the game, the game cap or the allowlist',
    )
    .option('--time <HH:MM>', 'local time of day to run, on a 24 hour clock')
    .option('--game <on|off>', 'whether the routine also plays the game');
  for (const [name, key] of Object.entries(LIMIT_OPTIONS)) {
    set.option(
      `--${name} <n>`,
      `${LIMIT_TEXT[key][1]}, ${ROUTINE_LIMIT_MIN[key]} to ${ROUTINE_LIMIT_MAX[key]}`,
    );
  }
  set
    .option('--game-cap <n>', 'the most game units this agent uses a UTC day')
    .option(
      '--allow <operator>',
      'let the routine take addressed tasks and submissions from an operator, by slug',
    )
    .option('--disallow <operator>', 'take an operator off the allowlist')
    .option(
      '--yes',
      "change it without a terminal, only after the user's clear yes",
    )
    .action(async function (this: Command, options: SetOptions): Promise<void> {
      await setRoutine(this, deps, options);
    });

  routine
    .command('run', { hidden: true })
    .description('One routine run now. The installed job calls this')
    .action(async function (this: Command): Promise<void> {
      await runOnce(this, deps);
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

const inputOf = (deps: RoutineDeps): Input =>
  (deps.stdin ?? (() => streamInput(process.stdin)))();

// Ends the command unless --yes stands for the user's yes or a person can
// answer in a terminal. Returns the terminal, or undefined with --yes.
function yesOrTerminal(
  cmd: Command,
  deps: RoutineDeps,
  yes: boolean | undefined,
  form: string,
): Input | undefined {
  if (yes === true) return undefined;
  const input = inputOf(deps);
  if (!input.isTTY) {
    cmd.error(
      `nothing changed. There is no terminal to ask, so run ${cli(`${form} --yes`)} after the user's clear yes`,
    );
  }
  return input;
}

// install

// Everything an install needs before it asks, so init can offer the same
// install after the Claude Code hooks. A string is the reason nothing can
// be installed, said as is. A scheduler that cannot be read throws a
// SchedulerError.
type PreparedInstall = {
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
  'claude was not found on PATH. Install Claude Code first, the routine asks it each task as claude -p';

// The agent the routine starts, from what is found on this machine. Claude
// Code today, OpenClaw and Mastra later (VOU-601).
async function findRuntime(deps: RoutineDeps): Promise<string | null> {
  return (deps.findAgent ?? ((n) => findOnPath(n)))('claude');
}

export async function prepareInstall(
  deps: RoutineDeps,
  time: string,
  current?: RoutineConfig,
): Promise<PreparedInstall | string> {
  const run = deps.run ?? execRunner;
  const env = schedulerEnv(deps);
  const agentCommand = await findRuntime(deps);
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

// Copies the CLI for the job, then writes the job and records it and its
// time in routine.json, clearing a pause an earlier CLI left unless
// keepPause (routine set). routine.json is written only once the job is.
// A job from an earlier install under another name or scheduler goes
// first, so there is only ever one. Throws a SchedulerError when the copy
// cannot be written or the scheduler refuses.
async function finishInstall(
  prepared: PreparedInstall,
  time: string,
  options: { keepPause?: boolean } = {},
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
  const { paused, ...rest } = current;
  await writeRoutineConfig(
    {
      ...rest,
      ...(options.keepPause === true && paused !== undefined ? { paused } : {}),
      time,
      schedule,
    },
    p,
  );
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

const installedLine = (time: string): string =>
  `Routine on. It runs every day at ${time}. See it with ${cli('routine')}, turn it off with ${cli('routine off')}.`;

// The questions of the setup, yes by default (D-RS-1, D-RS-2).
export const INSTALL_QUESTION = 'Install? [Y/n] ';
export const FIRST_RUN_QUESTION =
  'Run the first one now, so you see it work? [Y/n] ';
export const timeQuestion = (time: string): string =>
  `What time should it run each day, local? [${time}] `;
export const WORK_QUESTION = 'Tasks only, or tasks and the game? [T/g] ';
// Asked again after an answer that is not one it takes, up to this many
// questions in all, and then the default, or no.
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

// Asks for a time on a 24 hour clock, current on an empty answer or a
// closed input, and again after one that is not HH:MM.
async function askTime(
  input: Input,
  current: string,
  print: SetupPrint,
): Promise<string> {
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    print.ask(
      `${asked === 0 ? '' : 'Please answer HH:MM, such as 09:30. '}${timeQuestion(current)}`,
    );
    const line = await input.readLine();
    if (line === null) return current;
    const answer = cleanAnswer(line).trim();
    if (answer === '') return current;
    if (ROUTINE_TIME.test(answer)) return answer;
  }
  return current;
}

// Asks tasks only or tasks and the game, tasks only on an empty answer, a
// closed input or no clear answer.
async function askGame(input: Input, print: SetupPrint): Promise<boolean> {
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    print.ask(`${asked === 0 ? '' : 'Please answer t or g. '}${WORK_QUESTION}`);
    const line = await input.readLine();
    if (line === null) return false;
    const answer = cleanAnswer(line).trim().toLowerCase();
    if (answer === '' || answer === 't' || answer === 'tasks') return false;
    if (answer === 'g' || answer === 'game') return true;
  }
  return false;
}

// Said after a no to the first run. The job runs later today when its time
// has not come yet.
function laterLine(time: string, now: Date = new Date()): string {
  return `It runs ${nextRunText(time, now)}.`;
}

// Said after the first run's line.
export const seeRunsLine = (): string =>
  `See every run with ${cli('routine')}.`;

// Said as the first run starts, since the agent may take minutes.
export const firstRunLine = (minutes: number): string =>
  `First run started. It stops within ${minutes} minutes.`;

// Said once under the started line, on a terminal (RS-9).
export const watchHintLine = (): string =>
  `Ctrl-C stops watching, the run keeps going. See it with ${cli('routine')}.`;

// Said after a Ctrl-C.
export const STOPPED_WATCHING = 'Stopped watching. The run keeps going.';

const stdoutIsTTY = (deps: RoutineDeps): boolean =>
  (deps.stdoutTTY ?? (() => process.stdout.isTTY === true))();

// How the first run's lines are printed. init indents and dims them, the
// setup prints them as they are.
type FirstRunPrint = {
  line: (text: string) => void;
  dim: (text: string) => void;
  indent: string;
};

// The first run after a setup, as init and routine start it (RS-3, RS-9).
// It runs detached, the command the scheduler runs, so it keeps going when
// the watching ends. The watcher prints a line per event as the run logs
// it, a spinner with the elapsed time on a terminal, then the run line and
// where to see every run. Ctrl-C ends the watching only.
async function firstRun(
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
  const started = (deps.startRun ?? startDetached)(
    {
      runId,
      program,
      env: {
        ...process.env,
        [RUN_ID_ENV]: runId,
        // What it prints names the CLI as this one does.
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
      for (const line of reportLines(watched.entry)) print.line(line);
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

// The job name an install gives this CLI home.
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

// Said on the routine screen and after a failed agent. The routine's Claude
// Code loads none of the operator's settings files, see claudeArgs.
export const NO_SETTINGS_NOTE =
  "The routine's Claude Code runs without your Claude Code settings, so a login from an apiKeyHelper or an env block in settings.json does not reach it.";

// The one block init and the setup show before they ask (RS-1). A header
// with the time, four short rows with the limits from routine.json, then
// where to check it later. The scheduler and the job file are on the
// routine screen only.
export const BLOCK_TITLE = 'Daily routine';

const blockHeadTail = (time: string): string =>
  `${time}, only when there is work`;

function routineRows(limits: RoutineLimits): [string, string][] {
  return [
    ['Claims', 'Seed tasks and tasks from operators you allow'],
    ['Posts', '1 task a day when posting is behind'],
    ['Limits', limitsText(limits)],
    ['Why', 'Verified tasks get your agent to bronze'],
  ];
}

const checkLaterLine = (): string => `Check it later with ${cli('routine')}`;

// The width of the label column of the rows.
const BLOCK_LABEL = 9;

// The block as the setup prints it, without style. init prints the same
// lines with the label dim and the check line dim.
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

// Everything an install writes and runs, in full, for on --json on stderr
// and for tests. A person reads the block instead.
export function preview(prepared: PreparedInstall, time: string): string[] {
  const { plan, agentCommand, current: routine } = prepared;
  const lines = [
    `Every day at ${time}, ${plan.scheduler} runs ${cli('routine run')}.`,
    `It asks SealKeeper for the next step until there is none, and gives ${agentCommand} -p each task and each submission to judge as a question, with no tools. When there is nothing to do it starts nothing.`,
    '',
    'SealKeeper picks every step within the limits and the allowlist below. Runs claim only seed tasks, tasks addressed to this agent by operators on the allowlist and template tasks of other operators SealKeeper checks, and judge only submissions from operators on the allowlist. They post only when the goal says posting is behind. Everything else waits for you in status.',
    NO_SETTINGS_NOTE,
    ...(plan.note === undefined ? [] : [plan.note]),
    `Allowlist: ${allowedNames(routine)}. Add an operator with ${cli('routine set --allow <operator>')}.`,
    '',
    'Limits',
    ...limitLines(routine.limits).map((l) => `  ${l}`),
    `Change them with ${cli('routine set')}.`,
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
  confirmsPerDay: ['confirms-per-day', 'submissions judged per day'],
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

// The limits on the routine screen, one a line, each with the option of
// routine set that changes it.
function limitRows(limits: RoutineLimits): string[] {
  return (Object.keys(LIMIT_TEXT) as (keyof RoutineLimits)[]).map(
    (key) => `${limits[key]} ${LIMIT_TEXT[key][1]}, --${LIMIT_TEXT[key][0]}`,
  );
}

// The option names routine set takes, to the config keys.
export const LIMIT_OPTIONS = Object.fromEntries(
  (Object.keys(LIMIT_TEXT) as (keyof RoutineLimits)[]).map((key) => [
    LIMIT_TEXT[key][0],
    key,
  ]),
) as Record<string, keyof RoutineLimits>;

// routine

async function routineCommand(
  cmd: Command,
  deps: RoutineDeps,
  options: { files?: boolean; yes?: boolean },
): Promise<void> {
  await requireConfig(cmd);
  const current = await loadRoutineConfig(cmd);
  if (options.files === true) {
    await printFiles(cmd, deps, current);
    return;
  }
  if (current.schedule !== undefined) {
    await printScreen(cmd, deps);
    return;
  }
  if (options.yes === true) {
    await install(cmd, deps, current, undefined);
    return;
  }
  const input = inputOf(deps);
  if (!input.isTTY || wantsJson(cmd)) {
    await printScreen(cmd, deps);
    return;
  }
  const failed = await guidedSetup(deps, current, input, plainPrint());
  if (failed !== null) cmd.error(failed);
}

// How the guided setup prints and asks. init indents its lines and dims
// some, the routine command prints them as they are. ask writes a
// question, with again in front after an unclear answer.
export type SetupPrint = FirstRunPrint & { ask: (text: string) => void };

// The routine command's own print, on stdout with its questions on stderr.
const plainPrint = (): SetupPrint => {
  const s = createStyle(process.stdout);
  return {
    line: stdout,
    dim: (text) => stdoutStyled(s.line`${s.dim(text)}`),
    indent: '',
    ask: (text) => process.stderr.write(text),
  };
};

// The guided setup (VOU-599), the one routine and init share. The agent
// found on this machine, the time, tasks only or tasks and the game, the
// block with the limits, then the install and one run now, watched. null
// once it is installed, else why nothing was installed. A scheduler that
// cannot be read or refuses is said as its reason.
export async function guidedSetup(
  deps: RoutineDeps,
  current: RoutineConfig,
  input: Input,
  print: SetupPrint,
): Promise<string | null> {
  const agent = await findRuntime(deps);
  if (agent === null) return `nothing installed. ${NO_CLAUDE}`;
  print.line(`Agent     ${RUNTIME_NAME['claude-code']}, ${tildePath(agent)}`);
  const time = await askTime(input, current.time, print);
  const game = await askGame(input, print);
  const chosen = { ...current, time, game };
  const installed = await installJob(deps, chosen, input, print, {
    gameOn: game,
  });
  if (typeof installed === 'string') return installed;
  print.line(installedLine(time));
  await offerFirstRun(deps, input, installed, print);
  return null;
}

// Why a setup installed nothing when the person said no.
export const NOTHING_INSTALLED = 'nothing installed';

// What an install wrote, for the lines after it.
type Installed = { schedule: RoutineSchedule; saved: RoutineConfig; p: Paths };

// Writes the job with the settings in routine, after the block and a yes
// in a terminal, or at once with --yes (input undefined). print null is a
// --json run, which keeps the full preview, on stderr. Turns the game on
// only when the person chose tasks and the game in the setup (gameOn),
// never from routine on or --yes, so a game the person turned off stays
// off. A string is why nothing was installed.
async function installJob(
  deps: RoutineDeps,
  routine: RoutineConfig,
  input: Input | undefined,
  print: SetupPrint | null,
  options: { gameOn?: boolean } = {},
): Promise<Installed | string> {
  let prepared: PreparedInstall | string;
  try {
    prepared = await prepareInstall(deps, routine.time, routine);
  } catch (error) {
    if (error instanceof SchedulerError) return error.message;
    throw error;
  }
  if (typeof prepared === 'string') return `nothing installed. ${prepared}`;

  if (print === null) {
    for (const line of preview(prepared, routine.time)) stderr(line);
  } else {
    const lines = blockLines(routine.time, routine.limits);
    for (const line of lines.slice(0, -1)) print.line(line);
    print.dim(checkLaterLine());
  }
  if (input !== undefined) {
    const ask = print?.ask ?? ((text: string) => process.stderr.write(text));
    const yes = await askYes(input, (again) =>
      ask(`${again}${INSTALL_QUESTION}`),
    );
    if (!yes) return NOTHING_INSTALLED;
  }

  let schedule: RoutineSchedule;
  try {
    schedule = await finishInstall(prepared, routine.time);
  } catch (error) {
    if (error instanceof SchedulerError) return error.message;
    throw error;
  }
  if (options.gameOn === true) await gameOn(deps, prepared.p);
  try {
    const saved = await readRoutineConfig(prepared.p);
    return { schedule, saved, p: prepared.p };
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
}

// Offers one run now after an install in a terminal, and watches it.
async function offerFirstRun(
  deps: RoutineDeps,
  input: Input,
  { saved, p }: Installed,
  print: SetupPrint,
): Promise<void> {
  const now = await askYes(input, (again) =>
    print.ask(`${again}${FIRST_RUN_QUESTION}`),
  );
  if (!now) {
    print.line(laterLine(saved.time));
    return;
  }
  await firstRun(deps, saved, p, print);
}

// routine on and routine --yes. The install, then its line, or with --json
// what was written. A terminal is offered one run now.
async function install(
  cmd: Command,
  deps: RoutineDeps,
  routine: RoutineConfig,
  input: Input | undefined,
): Promise<void> {
  const json = wantsJson(cmd);
  const print = json ? null : plainPrint();
  const installed = await installJob(deps, routine, input, print);
  if (typeof installed === 'string') cmd.error(installed);
  const { schedule, saved } = installed;
  if (print === null) {
    stdout(
      JSON.stringify({
        on: true,
        schedule,
        time: saved.time,
        game: saved.game,
        limits: saved.limits,
      }),
    );
    return;
  }
  print.line(installedLine(routine.time));
  // --yes is for scripts and agents, which never start a run here.
  if (input === undefined) return;
  await offerFirstRun(deps, input, installed, print);
}

// Turns the game on for a routine that plays it, the person's own choice
// in the setup, with one line. A routine run never turns it on. A failure
// is said in one line and never fails the setup.
async function gameOn(deps: RoutineDeps, p: Paths): Promise<void> {
  const session = await openSession(deps, p);
  if ('error' in session) return;
  try {
    if ((await readGameStatus(session)).enabled) return;
    await changeGame(session, { enabled: true });
    stderr('Game on, so the routine plays it.');
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    stderr(
      `The game could not be turned on, ${gameRefusal(error)}. The routine plays it once the game is on.`,
    );
  }
}

// on

async function on(
  cmd: Command,
  deps: RoutineDeps,
  options: { yes?: boolean },
): Promise<void> {
  await requireConfig(cmd);
  const current = await loadRoutineConfig(cmd);
  // A job that is on is written again with no question.
  const input =
    current.schedule === undefined
      ? yesOrTerminal(cmd, deps, options.yes, 'routine on')
      : undefined;
  await install(cmd, deps, current, input);
}

// off

async function off(
  cmd: Command,
  deps: RoutineDeps,
  options: { yes?: boolean },
): Promise<void> {
  yesOrTerminal(cmd, deps, options.yes, 'routine off');
  await requireConfig(cmd);
  const p = paths();
  const routine = await loadRoutineConfig(cmd);
  const env = schedulerEnv(deps);
  const run = deps.run ?? execRunner;
  let result: { removed: string[]; kept: string[] };
  try {
    // Without a job in routine.json, as after logout or agent delete in an
    // earlier version, the job this home would have is looked for by name,
    // and only what carries the marker goes.
    result = routine.schedule
      ? await removeJob(routine.schedule, env, run)
      : await removeJobByName(defaultJob(p, env), env, run);
  } catch (error) {
    if (error instanceof SchedulerError) cmd.error(error.message);
    throw error;
  }
  const { schedule: _, paused: __, ...rest } = routine;
  if (routine.schedule || routine.paused) await writeRoutineConfig(rest, p);
  // The copy of the CLI the job ran goes with it (RS-2).
  result.removed.push(...(await removeCopy(p)));
  if (wantsJson(cmd)) {
    stdout(JSON.stringify({ on: false, ...result }));
    return;
  }
  if (!routine.schedule && result.removed.length === 0) {
    stdout('The routine is off already, nothing removed.');
    for (const path of result.kept) {
      stdout(`  kept ${tildePath(path)}, it was not written by SealKeeper`);
    }
    return;
  }
  stdout(`Routine off. Nothing runs until ${cli('routine on')}.`);
  for (const line of removedLines(result)) stdout(line);
  stdout(
    `The time, the limits, the allowlist and ${tildePath(routinePaths(p).log)} are kept.`,
  );
}

// set

type SetOptions = {
  time?: string;
  game?: string;
  gameCap?: string;
  allow?: string;
  disallow?: string;
  yes?: boolean;
} & Partial<Record<keyof RoutineLimits, string>>;

async function setRoutine(
  cmd: Command,
  deps: RoutineDeps,
  options: SetOptions,
): Promise<void> {
  const limitKeys = Object.values(LIMIT_OPTIONS).filter(
    (key) => options[key] !== undefined,
  );
  if (
    options.time === undefined &&
    options.game === undefined &&
    options.gameCap === undefined &&
    options.allow === undefined &&
    options.disallow === undefined &&
    limitKeys.length === 0
  ) {
    cmd.error(
      `give what to change, such as ${cli('routine set --time 09:30')}. ${cli('routine set --help')} lists every option`,
    );
  }
  // Every value is checked before anything changes.
  if (options.time !== undefined && !ROUTINE_TIME.test(options.time)) {
    cmd.error(`--time must be HH:MM on a 24 hour clock, got ${options.time}`);
  }
  if (
    options.game !== undefined &&
    options.game !== 'on' &&
    options.game !== 'off'
  ) {
    cmd.error(`--game takes on or off, got ${options.game}`);
  }
  const limits: Partial<RoutineLimits> = {};
  for (const key of limitKeys) {
    const value = options[key] ?? '';
    const n = Number(value);
    const [min, max] = [ROUTINE_LIMIT_MIN[key], ROUTINE_LIMIT_MAX[key]];
    if (!/^\d+$/.test(value) || n < min || n > max) {
      cmd.error(
        `--${LIMIT_TEXT[key][0]} takes a whole number from ${min} to ${max}`,
      );
    }
    limits[key] = n;
  }
  let gameCap: number | undefined;
  if (options.gameCap !== undefined) {
    const cap = GameCap.safeParse(
      /^\d+$/.test(options.gameCap.trim()) ? Number(options.gameCap) : NaN,
    );
    if (!cap.success) cmd.error(BAD_CAP(options.gameCap));
    gameCap = cap.data;
  }
  yesOrTerminal(cmd, deps, options.yes, 'routine set');
  const config = await requireConfig(cmd);
  let current = await loadRoutineConfig(cmd);
  if (options.allow !== undefined) {
    current = await changeAllow(cmd, config, current, options.allow, 'add');
  }
  if (options.disallow !== undefined) {
    current = await changeAllow(
      cmd,
      config,
      current,
      options.disallow,
      'remove',
    );
  }
  const next: RoutineConfig = {
    ...current,
    ...(options.time === undefined ? {} : { time: options.time }),
    ...(options.game === undefined ? {} : { game: options.game === 'on' }),
    limits: { ...current.limits, ...limits },
  };
  // A job that is on runs at the new time from today. It is planned before
  // anything changes, so a scheduler or an agent that is gone changes
  // nothing, and finishInstall writes routine.json only once the job is
  // written.
  let prepared: PreparedInstall | undefined;
  if (
    options.time !== undefined &&
    next.schedule !== undefined &&
    next.schedule.time !== options.time
  ) {
    try {
      const planned = await prepareInstall(deps, options.time, next);
      if (typeof planned === 'string') cmd.error(`nothing changed. ${planned}`);
      prepared = planned;
    } catch (error) {
      if (error instanceof SchedulerError) cmd.error(error.message);
      throw error;
    }
  }
  const lines: string[] = [];
  let game: Awaited<ReturnType<typeof changeGame>> | undefined;
  if (gameCap !== undefined) {
    const session = await openSession(deps, paths());
    if ('error' in session) cmd.error(session.error);
    game = await changeGame(session, { cap: gameCap }).catch(
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        return cmd.error(gameRefusal(error));
      },
    );
    const offHint = game.enabled ? '' : ` The game is off, ${gameOnHint()}`;
    lines.push(
      `Game cap ${game.cap} units a UTC day, ${game.usedToday} used today.${offHint}`,
    );
  }
  if (prepared === undefined) {
    await writeRoutineConfig(next);
  } else {
    // A new time keeps a pause an earlier CLI left, only on clears it.
    try {
      await finishInstall(prepared, next.time, {
        keepPause: true,
      });
    } catch (error) {
      if (error instanceof SchedulerError) cmd.error(error.message);
      throw error;
    }
  }
  const saved = await loadRoutineConfig(cmd);
  if (wantsJson(cmd)) {
    stdout(
      JSON.stringify({
        time: saved.time,
        game: saved.game,
        limits: saved.limits,
        allow: saved.allow,
        allowSlugs: saved.allowSlugs,
        ...(game === undefined ? {} : { gameCap: game.cap }),
      }),
    );
    return;
  }
  if (options.time !== undefined) {
    lines.push(
      saved.schedule === undefined
        ? `Time ${saved.time}, from the next ${cli('routine on')}.`
        : `Time ${saved.time}. It runs ${nextRunText(saved.time)}.`,
    );
  }
  if (options.game !== undefined) {
    lines.push(
      saved.game
        ? 'The routine plays the game after its tasks, while the game is on.'
        : 'The routine works tasks only.',
    );
  }
  for (const key of limitKeys) {
    lines.push(`${LIMIT_TEXT[key][0]} is ${saved.limits[key]}.`);
  }
  if (options.allow !== undefined) {
    const op = normalLogin(options.allow);
    lines.push(
      `${op} is allowed. Routine runs may claim tasks ${op} addresses to this agent and judge submissions from ${op}.`,
    );
  }
  if (options.disallow !== undefined) {
    lines.push(`${normalLogin(options.disallow)} is off the allowlist.`);
  }
  for (const line of lines) stdout(line);
}

// New entries are operator slugs (VOU-196), as posters are shown by their
// handle, slug/name, and go to allowSlugs. Entries in allow are GitHub
// logins added before, still matched by login, never by slug. None is
// moved across, since a login and a slug of one spelling can belong to two
// operators. disallow takes a name off both lists, a login that is no slug
// included. Returns the settings with the change, unwritten.
async function changeAllow(
  cmd: Command,
  config: Config,
  current: RoutineConfig,
  raw: string,
  change: 'add' | 'remove',
): Promise<RoutineConfig> {
  const operator = normalLogin(raw);
  const same = (entry: string) => normalLogin(entry) === operator;
  const listed = current.allow.some(same) || current.allowSlugs.some(same);
  if (
    (change === 'add' || !listed) &&
    !OperatorSlug.safeParse(operator).success
  ) {
    cmd.error(
      `not an operator slug: ${raw}. A slug is the first half of a handle, lowercase letters, digits and single hyphens`,
    );
  }
  const own =
    (await readOperatorSlug(config.agentId)) ??
    normalLogin(config.operatorLogin);
  if (change === 'add' && own === operator) {
    cmd.error(
      'tasks between agents of the same operator never count, so your own operator is not added',
    );
  }
  const allow =
    change === 'add'
      ? current.allow
      : current.allow.filter((entry) => !same(entry));
  const allowSlugs =
    change === 'add'
      ? [...new Set([...current.allowSlugs, operator])].sort()
      : current.allowSlugs.filter((entry) => !same(entry));
  return { ...current, allow, allowSlugs };
}

// run

async function runOnce(cmd: Command, deps: RoutineDeps): Promise<void> {
  const json = wantsJson(cmd);
  const config = await requireConfig(cmd);
  const routine = await loadRoutineConfig(cmd);
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
  const entry = await running;
  if (json) {
    stdout(JSON.stringify(entry));
  } else {
    for (const line of reportLines(entry)) stdout(line);
  }
  if (entry.outcome === 'failed') process.exitCode = 1;
}

// What went wrong in a failed run, by the failure its run line names, and
// the fix said beside it.
export const RUN_FAILURES: Record<string, () => string> = {
  key: () => `Run ${cli('init')} to set this agent up again.`,
  api: () => 'Check the network. The next run tries again.',
  old_api: () =>
    'This SealKeeper API has no routine route yet. The next run tries again.',
  workdir: () => 'Fix the folder named above, then the next run tries again.',
  agent_missing: () =>
    `Install Claude Code, then run ${cli('routine on')} so the job finds claude.`,
  agent_failed: () =>
    `Check that claude -p answers in a terminal. ${NO_SETTINGS_NOTE}`,
};

// The run line, and the fix when the run failed.
export function reportLines(entry: Omit<RunEntry, 'at'>): string[] {
  const fix =
    entry.failure === undefined ? undefined : RUN_FAILURES[entry.failure];
  return [runLine(entry), ...(fix === undefined ? [] : [`Fix: ${fix()}`])];
}

// How long past the wall clock limit the run lock lasts, for the card and
// the last call. A lock whose process is gone is stale sooner.
const LOCK_MARGIN_MS = 10 * 60_000;

// How often a step is asked again after the API said it is busy or could
// not be reached, and the wait between. A step asked again is a no-op on
// the server, so this is safe.
const STEP_TRIES = 3;
const STEP_RETRY_MS = 2_000;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/*
 * One routine run, as the job runs it. Logs every step and the run line
 * and returns the run line. Prints nothing. runId is the id its lines
 * carry, a new one unless a watcher chose it (RS-9).
 *
 * The loop. Ask the routine route for step n with the run id, the limits,
 * the allowlist, the game choice and the verdict of the step before, if
 * any. Log the step. done ends the run. task puts the task to the agent
 * and submits the text it answers through the submit path, and gives a
 * task it could not answer back through the release path, unless it is a
 * duel or challenge task, which has no release. judge puts the submission
 * to the agent and keeps its verdict for the next call. Every other action
 * is something the API did. Then step n + 1. The wall clock and the token
 * cap are checked before each call, and the agent gets what is left of
 * both.
 */
export async function routineRun(
  deps: RoutineDeps,
  config: Config,
  routine: RoutineConfig,
  p: Paths = paths(),
  runId: string = randomUUID(),
): Promise<Omit<RunEntry, 'at'>> {
  const schedule = routine.schedule;
  const startedAt = new Date();
  const minutes = routine.limits.minutesPerRun;
  const timeoutMs = minutes * (deps.msPerMinute ?? 60_000);
  const deadline = startedAt.getTime() + timeoutMs;
  const tokenCap = routine.limits.tokensPerRun;
  const sleep = deps.sleep ?? realSleep;
  let card: CardRefresh | null = null;
  let agentStarted = false;
  let tokens: number | null = null;
  let costUsd: number | null = null;
  let entry: Omit<RunEntry, 'at'> | null = null;

  const finish = async (
    outcome: RunOutcome,
    reason?: string,
    failure?: keyof typeof RUN_FAILURES,
  ): Promise<void> => {
    entry = {
      kind: 'run',
      runId,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(failure === undefined ? {} : { failure }),
      startedAt: startedAt.toISOString(),
      agentStarted,
      ...tally(await readRoutine(p), runId),
      tokens,
      costUsd,
      ...(card === null ? {} : { card }),
    };
    await appendRoutine(entry, p);
  };
  const done = (): Omit<RunEntry, 'at'> => {
    if (entry === null) throw new Error('the routine run ended with no line');
    return entry;
  };

  if (schedule === undefined) {
    await finish('skipped', 'the routine is off');
    return done();
  }
  if (routine.paused) {
    await finish(
      'skipped',
      `paused by an earlier CLI, ${routine.paused.reason}. Run ${cli('routine on')} to run it again`,
    );
    return done();
  }
  // Taken exclusively before anything is read, so two runs started at once
  // never both go on. Released when the run ends.
  const locked = await acquireLock(
    {
      runId,
      pid: process.pid,
      deadline: new Date(deadline + LOCK_MARGIN_MS).toISOString(),
    },
    p,
  );
  if (!locked) {
    await finish('skipped', 'another routine run is still going');
    return done();
  }
  try {
    await lockedRun();
  } finally {
    await removeLock(runId, p);
  }
  return done();

  // The rest of the run, while this run holds the lock.
  async function lockedRun(): Promise<void> {
    // The card first, so a run with nothing to do still refreshes it
    // (VOU-383). In this process, never by the agent, and it takes no
    // step. It never fails the run.
    card = await refreshCard(config, { fetch: deps.fetch }, p);
    const session = await openSession(deps, p, config);
    if ('error' in session) {
      await finish('failed', session.error, session.failure);
      return;
    }
    let workDir: string;
    try {
      workDir = await ensureWorkDir(p);
    } catch (error) {
      await finish(
        'failed',
        `no working directory: ${(error as Error).message}`,
        'workdir',
      );
      return;
    }
    // The agent, made at the first question, and every question of the
    // run goes to one transcript, which a run that asks nothing leaves as
    // it was (RS-10).
    let transcript: Transcript | null = null;
    let made: AgentRuntime | null = null;
    const runtime = (): AgentRuntime => {
      if (made === null) {
        transcript = Transcript.open(copyPaths(p).transcript);
        made = claudeCodeRuntime({
          command: (schedule as RoutineSchedule).agentCommand,
          cwd: workDir,
          env: agentEnv(),
          spawner: deps.spawner,
          transcript,
        });
      }
      return made;
    };
    try {
      await loop(session, runtime, workDir);
    } finally {
      (transcript as Transcript | null)?.close();
    }
  }

  // The steps of the run, until done, a limit or a failure.
  async function loop(
    session: LiveSession,
    runtime: () => AgentRuntime,
    workDir: string,
  ): Promise<void> {
    let step = 0;
    let verdict: { taskId: string; outcome: TaskOutcome; type: string } | null =
      null;
    let worked = false;
    for (;;) {
      // A verdict still held at a limit goes with one more call, so the
      // agent's judgement is never dropped. That call only delivers it.
      const over = overLimit();
      if (over !== null && verdict === null) {
        await stop(over);
        return;
      }
      let answer: RoutineAnswerResponse;
      try {
        answer = await askStep(session, step, verdict);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        await finish(
          'failed',
          `could not read the API: ${error.message}`,
          error.status === 404 ? 'old_api' : 'api',
        );
        return;
      }
      if (verdict !== null) {
        await appendRoutine(
          {
            kind: 'confirm',
            runId,
            taskId: verdict.taskId,
            taskType: verdict.type,
            outcome: verdict.outcome,
          },
          p,
        );
        verdict = null;
      }
      const r = answer.routine;
      const task = r.action === 'task' ? answer.tasks[0] : undefined;
      await appendRoutine(
        {
          kind: 'step',
          runId,
          step: r.step,
          action: r.action,
          ...(r.taskId ? { taskId: r.taskId } : {}),
          ...(task
            ? { taskId: task.id, taskType: task.type, taskKind: task.kind }
            : {}),
          ...(r.judge ? { taskType: r.judge.type } : {}),
          ...(answer.next.length > 0
            ? { label: answer.next.map((a) => a.label).join(' ') }
            : {}),
        },
        p,
      );
      if (r.action === 'done') {
        await finish(
          worked ? 'done' : 'nothing',
          doneReason(r.reason, answer.limited?.message ?? null, worked),
        );
        return;
      }
      if (over !== null) {
        // A task this last call handed over goes back, unless it is a game
        // task, which a later run is handed again.
        if (task !== undefined) {
          await recordClaims(answer);
          await giveUp(session, task, 'the run stopped before an answer');
        }
        await stop(over);
        return;
      }
      worked = true;
      if (task !== undefined) {
        await recordClaims(answer);
        if ((await solve(session, task)) === 'stop') return;
      } else if (r.action === 'judge' && r.judge !== null) {
        const outcome = await judge(r.judge);
        if (outcome === 'stop') return;
        if (outcome !== null) {
          verdict = { taskId: r.judge.taskId, outcome, type: r.judge.type };
        }
      }
      step = r.step + 1;
    }

    // Asks for one step, again after a busy step or an API it could not
    // reach, which the API answers as a no-op.
    async function askStep(
      s: LiveSession,
      n: number,
      v: { taskId: string; outcome: TaskOutcome } | null,
    ): Promise<RoutineAnswerResponse> {
      for (let tries = 1; ; tries++) {
        try {
          const request = RoutineNextRequest.parse({
            runId,
            step: n,
            limits: {
              claimsPerDay: routine.limits.claimsPerDay,
              networkClaimsPerDay: routine.limits.networkClaimsPerDay,
              confirmsPerDay: routine.limits.confirmsPerDay,
              postsPerDay: routine.limits.postsPerDay,
            },
            allow: routineAllow(routine),
            game: routine.game,
            ...(v === null
              ? {}
              : { verdict: { taskId: v.taskId, outcome: v.outcome } }),
            issuedAt: new Date().toISOString(),
          });
          return await s.api.routineNext(
            s.signer.agentId,
            await s.signer.sign(request),
          );
        } catch (error) {
          const again =
            error instanceof ApiError &&
            (error.code === 'routine_step_busy' ||
              error.status === 0 ||
              error.status >= 500);
          if (!again || tries >= STEP_TRIES) throw error;
          await sleep(STEP_RETRY_MS);
        }
      }
    }

    // The wall clock or the token cap, when the run is past one.
    function overLimit(): 'minutesPerRun' | 'tokensPerRun' | null {
      if (Date.now() >= deadline) return 'minutesPerRun';
      if (tokens !== null && tokens >= tokenCap) return 'tokensPerRun';
      return null;
    }

    async function stop(limit: 'minutesPerRun' | 'tokensPerRun') {
      await appendRoutine(
        {
          kind: 'limit',
          runId,
          limit,
          used: limit === 'minutesPerRun' ? minutes : tokens,
          cap: limit === 'minutesPerRun' ? minutes : tokenCap,
        },
        p,
      );
      await finish(
        'stopped',
        limit === 'minutesPerRun'
          ? `stopped after ${minutes} minutes`
          : `stopped at the limit of ${tokenCap} tokens`,
      );
    }

    // One question to the agent with what is left of the wall clock and the
    // token cap. Ends the run and answers stop when the agent was stopped,
    // did not start or failed.
    async function ask(prompt: string): Promise<AgentResult | 'stop'> {
      agentStarted = true;
      const result = await runtime().ask({
        prompt,
        timeoutMs: Math.max(1, deadline - Date.now()),
        tokenCap: Math.max(1, tokenCap - (tokens ?? 0)),
      });
      if (result.tokens !== null) tokens = (tokens ?? 0) + result.tokens;
      if (result.costUsd !== null) costUsd = (costUsd ?? 0) + result.costUsd;
      if (result.stoppedFor !== null) {
        await stop(result.stoppedFor);
        return 'stop';
      }
      if (result.error !== undefined) {
        await finish(
          'failed',
          `the agent did not start: ${result.error}`,
          'agent_missing',
        );
        return 'stop';
      }
      if (result.exitCode !== 0) {
        await finish(
          'failed',
          `the agent exited with ${result.exitCode}`,
          'agent_failed',
        );
        return 'stop';
      }
      return result;
    }

    // A task to solve. The text the agent answers is kept in the working
    // folder and submitted. A task it gave no answer for, or whose answer
    // was refused, is given back unless it is a game task.
    async function solve(
      s: LiveSession,
      task: RoutineTask & { kind: string },
    ): Promise<'stop' | null> {
      const result = await ask(taskPrompt(task));
      if (result === 'stop') {
        await giveUp(s, task, 'the run stopped before an answer');
        return 'stop';
      }
      const text = answerOf(result.text, task.spec);
      if (text === null) {
        await giveUp(s, task, 'the agent gave no answer');
        return null;
      }
      await keepAnswer(workDir, task.id, text);
      try {
        const sent = await submitAnswer(s, task.id, text, { routine: true });
        await appendRoutine(
          {
            kind: 'submit',
            runId,
            taskId: task.id,
            taskType: task.type,
            state: sent.result.state,
          },
          p,
        );
      } catch (error) {
        if (!(error instanceof SubmitRefused || error instanceof ApiError)) {
          throw error;
        }
        await appendRoutine(
          {
            kind: 'submit_failed',
            runId,
            taskId: task.id,
            taskType: task.type,
            reason:
              error instanceof SubmitRefused
                ? (error.verification ?? error.code)
                : error.code,
          },
          p,
        );
        if (!isGame(task)) await releaseQuietly(s, task.id);
      }
      return null;
    }

    async function giveUp(
      s: LiveSession,
      task: RoutineTask & { kind: string },
      reason: string,
    ): Promise<void> {
      const released = !isGame(task) && (await releaseQuietly(s, task.id));
      await appendRoutine(
        {
          kind: 'unanswered',
          runId,
          taskId: task.id,
          taskType: task.type,
          reason,
          released,
        },
        p,
      );
    }

    // A submission to judge. The verdict, or null when the agent could not
    // tell, and then a person judges it.
    async function judge(
      item: RoutineJudgeItem,
    ): Promise<TaskOutcome | null | 'stop'> {
      const result = await ask(judgePrompt(item));
      if (result === 'stop') return 'stop';
      const outcome = verdictOf(result.text);
      if (outcome === null) {
        await appendRoutine(
          {
            kind: 'unanswered',
            runId,
            taskId: item.taskId,
            taskType: item.type,
            reason: 'the agent could not tell, a person judges it',
            released: false,
          },
          p,
        );
      }
      return outcome;
    }
  }
}

const isGame = (task: { kind: string }) =>
  task.kind === 'duel' || task.kind === 'challenge';

// Gives a claim back, true when it went. A release that fails leaves the
// claim, which a later run hands over again.
async function releaseQuietly(
  s: LiveSession,
  taskId: string,
): Promise<boolean> {
  try {
    await releaseClaim(s, taskId);
    return true;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}

// Keeps the answer the agent gave under .sealkeeper-answers in the working
// folder, mode 600, for the operator to read. Never fails the run.
async function keepAnswer(
  workDir: string,
  taskId: string,
  text: string,
): Promise<void> {
  try {
    const dir = join(workDir, '.sealkeeper-answers');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, `${taskId}.txt`), text);
  } catch {
    // Not kept.
  }
}

// Why a run is done, in words, from the API's reason and what limited it.
function doneReason(
  reason: string | null,
  limited: string | null,
  worked: boolean,
): string {
  if (reason === 'step_limit')
    return 'the run took the most steps one run takes';
  if (reason === 'day_limit') return "today's most routine steps are taken";
  if (limited !== null) return limited.replace(/\.$/, '');
  return worked
    ? 'nothing more to do within the limits'
    : 'nothing to do within the limits';
}

// The agent's environment, the job's own, without the watcher's run id.
// The agent has no tools, so nothing in it reaches a command.
function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { [RUN_ID_ENV]: _, ...rest } = env;
  return rest;
}

// The API client and the agent key of a run, or why they could not be had.
type LiveSession = { api: ApiClient; signer: Signer };
type Session = LiveSession | { error: string; failure: 'key' | 'api' };

// The key is loaded here rather than through openTaskSession, which ends
// the command on a missing or broken key. That exit would skip the finally
// that removes the run lock and leave no run line (cli-adapters-tasks-5).
async function openSession(
  deps: RoutineDeps,
  p: Paths,
  given?: Config,
): Promise<Session> {
  try {
    const config = given ?? (await readConfig(p));
    if (config === null) {
      return { error: 'no agent is set up', failure: 'key' };
    }
    const api = createApiClient({
      apiUrl: resolveApiUrl({ config: config.apiUrl }),
      fetch: deps.fetch,
    });
    return { api, signer: await loadSigner(api.apiUrl, p) };
  } catch (error) {
    if (error instanceof KeyError) {
      return {
        error: `the agent key could not be loaded: ${error.message}`,
        failure: 'key',
      };
    }
    if (error instanceof ApiError) {
      return {
        error: `could not read the API: ${error.message}`,
        failure: 'api',
      };
    }
    throw error;
  }
}

type RunTally = Pick<
  RunEntry,
  | 'claimed'
  | 'submitted'
  | 'confirmed'
  | 'posted'
  | 'verified'
  | 'duels'
  | 'challenge'
>;

// What a run did, from its lines. claimed counts the tasks handed over that
// are not game tasks, submitted every answer sent, right or wrong, posted
// the post steps that posted a task.
export function tally(entries: RoutineEntry[], runId: string): RunTally {
  const mine = entries.filter((e) => 'runId' in e && e.runId === runId);
  const tasks = (kinds: string[]) =>
    mine.filter(
      (e) =>
        e.kind === 'step' &&
        e.action === 'task' &&
        e.taskKind !== undefined &&
        kinds.includes(e.taskKind),
    ).length;
  return {
    claimed: tasks(['seed', 'addressed', 'exchange']),
    submitted: mine.filter(
      (e) => e.kind === 'submit' || e.kind === 'submit_failed',
    ).length,
    verified: mine.filter((e) => e.kind === 'submit' && e.state === 'verified')
      .length,
    confirmed: mine.filter((e) => e.kind === 'confirm').length,
    posted: mine.filter(
      (e) => e.kind === 'step' && e.action === 'post' && e.taskId !== undefined,
    ).length,
    duels: tasks(['duel']),
    challenge: tasks(['challenge']),
  };
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
    parts.push(`${countsText(entry)}.`);
    parts.push(`${spent(entry)}.`);
  }
  const card = entry.card === undefined ? undefined : CARD_TEXT.get(entry.card);
  if (card !== undefined) parts.push(card);
  return parts.join(' ');
}

// What a run did, in the order claimed, solved, verified, posted,
// confirmed, duels, challenge.
export function countsText(entry: Omit<RunEntry, 'at'>): string {
  return `Claimed ${entry.claimed}, solved ${entry.submitted}, verified ${entry.verified ?? 0}, posted ${entry.posted ?? 0}, confirmed ${entry.confirmed}, duels ${entry.duels ?? 0}, challenge ${entry.challenge ?? 0}`;
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

// The routine as status and the routine screen show it. Everything here is
// local, read from routine.json, routine.jsonl and the scheduler, so it
// shows offline.

export type RoutineView = {
  // What status --json carries under local.routine, and routine --json.
  json: Record<string, unknown>;
  // The lines of the Routine section of status, without the label.
  lines: string[];
  // The routine screen.
  screen: string[];
  // The job's copy is out of date or gone (RS-2), said on stderr.
  warnings: string[];
};

/*
 * The routine, on or off, the next run, what the last run did and its fix
 * when it failed, with the linger note where it applies. status shows the
 * short lines, which end by naming routine for the full screen. The screen
 * adds the runtime, the work, the limits, the allowlist, where the job is,
 * the transcript and the card. json keeps every detail. A routine.json
 * that cannot be read is said in one line, never thrown, so it never fails
 * status.
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
    return { json: { error: why }, lines: [why], screen: [why], warnings: [] };
  }
  const config = await readConfig(p).catch(() => null);
  const entries = await readRoutine(p);
  const lastRun =
    entries.filter((e): e is RunEntry => e.kind === 'run').at(-1) ?? null;
  const active = await readLiveLock(p);
  const warnings = await routineJobWarnings(p);
  const transcript = existsSync(copyPaths(p).transcript)
    ? copyPaths(p).transcript
    : null;
  const cardRecord =
    config === null ? null : await readCardRecord(config.agentId, p);
  const s = routine.schedule;
  // The time the job was written with, which routine set keeps in step.
  const nextRun =
    s === undefined || routine.paused ? null : nextRunText(s.time, now);
  // Without lingering systemd stops the timer at logout (RS-4).
  const linger =
    s?.scheduler === 'systemd' &&
    !(await lingers(schedulerEnv(deps), deps.run ?? execRunner));

  const json = {
    installed: s !== undefined,
    on: s !== undefined && routine.paused === undefined,
    schedule: s ?? null,
    time: routine.time,
    game: routine.game,
    paused: routine.paused ?? null,
    running: active !== null,
    nextRun,
    limits: routine.limits,
    allow: routine.allow,
    allowSlugs: routine.allowSlugs,
    lastRun,
    transcript,
    card:
      cardRecord === null
        ? null
        : { path: cardRecord.path, writtenAt: cardRecord.writtenAt },
    copy: {
      path: copyPaths(p).script,
      version: await copyVersion(p),
      cliVersion: VERSION,
    },
    notes: [NO_SETTINGS_NOTE, ...(linger ? [LINGER_NOTE] : [])],
    warnings,
  };

  const state =
    s === undefined
      ? 'off'
      : routine.paused
        ? `off, paused by an earlier CLI, ${routine.paused.reason}. ${cli('routine on')} runs it again`
        : `on, every day at ${s.time} with ${s.scheduler}, next run ${nextRun}`;
  const last: string[] = [];
  if (lastRun !== null) {
    const [line, ...fix] = reportLines(lastRun);
    last.push(`last run ${lastRun.at}. ${line}`, ...fix);
  } else if (s !== undefined) {
    last.push('last run none yet');
  }

  const lines = [
    s === undefined ? `off. ${cli('routine')} sets it up` : state,
    ...(active !== null ? ['a run is going now'] : []),
    ...last,
    ...(linger ? [LINGER_NOTE] : []),
    `See all of it with ${cli('routine')}`,
  ];

  const row = (label: string, text: string) => `${label.padEnd(11)}${text}`;
  const screen = [
    row('Routine', state),
    ...(s === undefined
      ? []
      : [
          row(
            'Agent',
            `${RUNTIME_NAME[s.agent]}, ${tildePath(s.agentCommand)}`,
          ),
        ]),
    row(
      'Work',
      routine.game
        ? 'tasks, then the game while it is on'
        : 'tasks only, no game',
    ),
    ...limitRows(routine.limits).map((l, i) => row(i === 0 ? 'Limits' : '', l)),
    row('Allowed', allowedNames(routine)),
    ...(s === undefined
      ? []
      : jobWhere(s, schedulerEnv(deps)).map((l) => row('Job', l))),
    ...(active !== null ? [row('Running', 'a run is going now')] : []),
    ...(lastRun === null
      ? [row('Last run', s === undefined ? 'none' : 'none yet')]
      : [
          row('Last run', lastRun.at),
          ...reportLines(lastRun).map((l) => row('', l)),
        ]),
    // Where the last run's transcript is, never what it says (RS-10).
    ...(transcript === null ? [] : [row('Transcript', tildePath(transcript))]),
    // The card init wrote, which each run refreshes (VOU-383).
    ...(cardRecord === null
      ? []
      : [
          row(
            'Card',
            `${tildePath(cardRecord.path)}, last written ${cardRecord.writtenAt}`,
          ),
        ]),
    ...(linger ? ['', LINGER_NOTE] : []),
    '',
    s === undefined
      ? `Set it up with ${cli('routine')} in a terminal, or ${cli('routine --yes')} after the user's clear yes. Change the settings first with ${cli('routine set')}.`
      : `Change it with ${cli('routine set')}, turn it off with ${cli('routine off')}. ${cli('routine --files')} prints the job.`,
  ];
  return { json, lines, screen, warnings };
}

async function printScreen(cmd: Command, deps: RoutineDeps): Promise<void> {
  const view = await routineView(deps);
  if (wantsJson(cmd)) {
    stdout(JSON.stringify(view.json));
  } else {
    for (const line of view.screen) stdout(line);
  }
  for (const line of view.warnings) stderr(line);
}

// --files, the job the scheduler runs, in full.
async function printFiles(
  cmd: Command,
  deps: RoutineDeps,
  routine: RoutineConfig,
): Promise<void> {
  if (routine.schedule === undefined) {
    cmd.error(
      `the routine is off, there is no job. ${cli('routine on')} writes it`,
    );
  }
  let files: { label: string; text: string }[];
  try {
    files = await jobFiles(routine.schedule, deps.run ?? execRunner);
  } catch (error) {
    if (error instanceof SchedulerError) cmd.error(error.message);
    throw error;
  }
  if (wantsJson(cmd)) {
    stdout(JSON.stringify({ files }));
    return;
  }
  files.forEach((file, i) => {
    if (i > 0) stdout('');
    stdout(file.label);
    for (const line of indentAll(file.text)) stdout(line);
  });
}

// Where the job is (RS-4), one line for each file, the crontab entry or
// the task.
function jobWhere(s: RoutineSchedule, env: SchedulerEnv): string[] {
  switch (s.scheduler) {
    case 'launchd':
    case 'systemd':
      return s.files.map((f) => `file ${tildePath(f, env.homedir)}`);
    case 'cron':
      return [`in the crontab, marked ${s.job}`];
    case 'schtasks':
      return [`in Task Scheduler, ${schtasksName(s.job)}`];
  }
}

// When the job runs next, "today at 10:00" while its time has not come
// yet, else "tomorrow at 10:00", in local time.
export function nextRunText(time: string, now: Date = new Date()): string {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const today = now.getHours() * 60 + now.getMinutes() < hour * 60 + minute;
  return `${today ? 'today' : 'tomorrow'} at ${time}`;
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
// time, the limits and the allowlist. When every file of it was kept as
// not ours, the job stays recorded. null when none is installed. Throws
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
