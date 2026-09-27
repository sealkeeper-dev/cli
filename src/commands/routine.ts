// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from '../api.js';
import { type Input, isYes, streamInput } from '../ask.js';
import {
  cliInvocation,
  cliProgram,
  isNpxCopy,
} from '../claude-code-settings.js';
import { loadRoutineConfig, requireConfig } from '../cli-config.js';
import {
  type Paths,
  paths,
  type RoutineConfig,
  type RoutineLimits,
  type RoutineSchedule,
  readRoutineConfig,
  sealkeeperRoot,
  writeRoutineConfig,
} from '../config.js';
import { readEnv } from '../env.js';
import { tildePath } from '../files.js';
import { HIGHEST_ISSUED, loadGoal, shownLevel } from '../goal.js';
import { KeyError, loadSigner, type Signer } from '../identity.js';
import { cli } from '../invocation.js';
import { stderr, stdout, wantsJson } from '../output.js';
import {
  type AgentResponse,
  operatorSlugOf,
  type TaskResponse,
} from '../responses.js';
import {
  acquireLock,
  allowedNames,
  appendRoutine,
  budgetOf,
  ensureWorkDir,
  failureStreak,
  isAllowed,
  type RoutineEntry,
  type RunEntry,
  type RunOutcome,
  readLiveLock,
  readRoutine,
  removeLock,
  routinePaths,
  SKIP_LIST_DAYS,
  type SkipEntry,
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
  applyPlan,
  commandLine,
  detectScheduler,
  execRunner,
  jobName,
  type Plan,
  planInstall,
  type Runner,
  removeJob,
  removeJobByName,
  type SchedulerEnv,
  SchedulerError,
} from '../routine-scheduler.js';
import { dailyCeilingReached, todayOf } from '../today.js';
import {
  logSkips,
  PosterLookup,
  type RoutineCandidates,
  routineCandidates,
  routineHeld,
  serverHeld,
} from './prove.js';
import { awaitingVerdict, fetchSubmission } from './tasks-outcome.js';

// sealkeeper routine (VOU-136, VOU-138). An opt-in daily run that works
// toward the next level unattended.
//
// install writes one daily job with the operator's own scheduler, after a
// preview and a yes. The job runs routine run, which checks whether there is
// anything to do within the day's limits and, only then, starts the agent
// headless with the prove instructions. Everything a run does is held to
// the routine rules in routine.ts and logged in routine.jsonl. status shows
// the schedule, the last run and what waits for a person. pause, resume and
// remove are the kill switch.

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
};

export const defaultRoutineDeps: RoutineDeps = {
  fetch: (...args) => fetch(...args),
};

export const DEFAULT_TIME = '10:00';
export const AGENTS = ['claude-code'] as const;
// Frameworks with no headless mode the routine could start.
const NOT_HEADLESS: Record<string, string> = {
  openclaw:
    'OpenClaw has no headless mode the routine can start. Have your own scheduler start the agent with the output of sealkeeper prove --json, see the README',
  mastra:
    'a Mastra agent runs inside your own program, so there is nothing for the routine to start. Call sealkeeper prove --json from a scheduled job of that program, see the README',
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
    .description('Write a daily job with your scheduler, after a preview')
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
    .command('status')
    .description('Schedule, limits, the last run and what waits for you')
    .action(async function (this: Command): Promise<void> {
      await status(this);
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
  // Whether this CLI runs from the npx cache, which the job would point at.
  npx: boolean;
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
  const { program } = cliOf(deps);
  if (program.length === 0) return 'Run this from the sealkeeper CLI';
  const routine = current ?? (await readRoutineConfig());
  const p = paths();
  const job = defaultJob(p, env);
  const scheduler = await detectScheduler(env, run);
  const planned = await planInstall(
    scheduler.kind,
    job,
    {
      time,
      program: [...program, 'routine', 'run'],
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
    npx: isNpxCopy(program[1]),
  };
}

// Writes the job the preview showed and records it in routine.json. A job
// from an earlier install under another name or scheduler goes first, so
// there is only ever one. Throws a SchedulerError when the scheduler
// refuses.
export async function finishInstall(
  prepared: PreparedInstall,
  time: string,
): Promise<RoutineSchedule> {
  const { plan, current, env, run } = prepared;
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
  };
  await writeRoutineConfig({ ...current, schedule });
  return schedule;
}

export const installedLine = (time: string): string =>
  `Routine installed. It runs every day at ${time}. See it with ${cli('routine status')}, stop it with ${cli('routine pause')} or ${cli('routine remove')}.`;

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

  const print = json ? stderr : stdout;
  for (const line of preview(
    prepared.plan,
    options.time,
    prepared.agentCommand,
    current,
    prepared.npx,
  )) {
    print(line);
  }

  if (options.yes !== true) {
    const input = (deps.stdin ?? (() => streamInput(process.stdin)))();
    if (!input.isTTY) {
      cmd.error(
        `nothing installed. There is no terminal to ask, so run ${cli('routine install')} --yes after reading the preview above`,
      );
    }
    process.stderr.write(INSTALL_QUESTION);
    if (!isYes(await input.readLine())) cmd.error('nothing installed');
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
}

export const INSTALL_QUESTION = 'Install this daily routine? [y/N] ';

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
  if (resolve(p.home) !== resolve(sealkeeperRoot())) {
    env.SEALKEEPER_HOME = p.home;
  }
  // The agent's working directory follows it, so the scheduled run and
  // agent delete agree on where it is.
  const cache = readEnv('XDG_CACHE_HOME');
  if (cache) env.XDG_CACHE_HOME = cache;
  return env;
}

// Said in the preview and after a failed agent. The routine's Claude Code
// loads none of the operator's settings files, see claudeArgs.
export const NO_SETTINGS_NOTE =
  "The routine's Claude Code runs without your Claude Code settings, so a login from an apiKeyHelper or an env block in settings.json does not reach it.";

// Said in the preview, and by init before its question, when the CLI runs
// from the npx cache. The job points at that copy, and npm can clear it.
export const NPX_NOTE =
  'This CLI runs from the npx cache, which npm can clear, and the job points at this copy. For a job that keeps working, run npm i -g sealkeeper and then sealkeeper routine install.';

export function preview(
  plan: Plan,
  time: string,
  agentCommand: string,
  routine: RoutineConfig,
  npx = false,
): string[] {
  const lines = [
    `Every day at ${time}, ${plan.scheduler} runs ${cli('routine run')}.`,
    `When there is work within the daily limits it starts ${agentCommand} -p with the sealkeeper prove instructions. Otherwise it starts nothing.`,
    '',
    'Unattended runs claim only seed tasks and tasks addressed to this agent by operators on the allowlist, and confirm only submissions from those operators. They never post tasks. Everything else waits for you in routine status.',
    NO_SETTINGS_NOTE,
    ...(npx ? [NPX_NOTE] : []),
    ...(plan.note === undefined ? [] : [plan.note]),
    `Allowlist: ${allowedNames(routine)}. Add an operator with ${cli('config routine allow <operator>')}.`,
    '',
    'Limits',
    ...limitLines(routine.limits).map((l) => `  ${l}`),
    `Change them with ${cli('config routine set <limit> <value>')}.`,
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
  confirmsPerDay: ['confirms-per-day', 'outcomes confirmed per day'],
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

type RunTally = Pick<RunEntry, 'claimed' | 'submitted' | 'confirmed'>;

async function runOnce(cmd: Command, deps: RoutineDeps): Promise<void> {
  const json = wantsJson(cmd);
  const config = await requireConfig(cmd);
  const routine = await loadRoutineConfig(cmd);
  if (!routine.schedule) {
    cmd.error(`no routine is installed, run ${cli('routine install')} first`);
  }
  const schedule = routine.schedule;
  const runId = randomUUID();
  const startedAt = new Date();
  const p = paths();

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
    };
    await appendRoutine(entry, p);
    let paused: string | null = null;
    if (outcome === 'failed') {
      paused = await pauseAfterFailures(p);
    }
    if (json) {
      stdout(JSON.stringify({ ...entry, paused }));
    } else {
      stdout(runLine(entry));
      if (paused) stdout(`The routine paused itself. ${paused}`);
    }
    if (outcome === 'failed') process.exitCode = 1;
  };

  if (routine.paused) {
    await finish('skipped', `paused: ${routine.paused.reason}`, null);
    return;
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
    return;
  }
  try {
    await lockedRun();
  } finally {
    await removeLock(runId, p);
  }

  // The rest of the run, while this run holds the lock.
  async function lockedRun(): Promise<void> {
    const entries = await readRoutine(p);
    const claims = budgetOf(entries, 'claim', routine);
    const confirms = budgetOf(entries, 'confirm', routine);
    if (claims.remaining === 0 && confirms.remaining === 0) {
      for (const [limit, budget] of [
        ['claimsPerDay', claims],
        ['confirmsPerDay', confirms],
      ] as const) {
        await appendRoutine(
          { kind: 'limit', runId, limit, used: budget.used, cap: budget.cap },
          p,
        );
      }
      await finish('stopped', 'the daily limits are spent', null);
      return;
    }

    const goal = await loadGoal({ fetch: deps.fetch }).catch(() => null);
    if (
      goal !== null &&
      goal.nextLevel === null &&
      goal.pending.addressed === 0 &&
      goal.pending.outcomes === 0 &&
      (goal.pending.posterOutcomes ?? 0) === 0
    ) {
      await finish(
        'nothing',
        `level ${shownLevel(goal.level)} is ${HIGHEST_ISSUED}`,
        null,
      );
      return;
    }
    // Counted evidence (VOU-140). Once today's counted tasks reach the daily
    // ceiling, more work today would verify and count toward nothing, so the
    // run starts no agent and waits for the next UTC day.
    const today = todayOf(goal);
    if (today !== null && dailyCeilingReached(today)) {
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
      await finish(
        'stopped',
        `today's ${today.ceiling} counted tasks are done, more would not count until midnight UTC`,
        null,
      );
      return;
    }

    // What there is to do, read before any agent starts. The key is loaded
    // here rather than through openTaskSession, which ends the command on a
    // missing or broken key. That exit would skip the finally that removes
    // the run lock and leave no run line (cli-adapters-tasks-5).
    let api: ApiClient;
    let signer: Signer;
    try {
      api = createApiClient({
        apiUrl: resolveApiUrl({ config: config.apiUrl }),
        fetch: deps.fetch,
      });
      signer = await loadSigner(api.apiUrl);
    } catch (error) {
      if (error instanceof KeyError || error instanceof ApiError) {
        await finish(
          'failed',
          error instanceof KeyError
            ? `the agent key could not be loaded: ${error.message}`
            : `could not read the API: ${error.message}`,
          null,
        );
        return;
      }
      throw error;
    }
    let held: TaskResponse[];
    let found: RoutineCandidates;
    let confirm: Confirmable[];
    try {
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
          ? await routineCandidates(api, posters, signer, config, routine)
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
    } catch (error) {
      if (error instanceof ApiError) {
        await finish(
          'failed',
          `could not read the API: ${error.message}`,
          null,
        );
        return;
      }
      throw error;
    }

    if (held.length === 0 && found.tasks.length === 0 && confirm.length === 0) {
      const why =
        claims.remaining === 0
          ? 'the daily claim limit is spent and nothing waits for a confirmation'
          : 'no seed tasks, allowed addressed tasks or confirmations to do';
      await finish('nothing', why, null);
      return;
    }

    const { invocation } = cliOf(deps);
    let work: string;
    try {
      work = await ensureWorkDir(p);
    } catch (error) {
      await finish(
        'failed',
        `no working directory: ${(error as Error).message}`,
        null,
      );
      return;
    }
    const agent = await runAgent(
      {
        command: schedule.agentCommand,
        args: claudeArgs(invocation),
        input: routinePrompt(invocation, confirm),
        cwd: work,
        env: {
          ...process.env,
          SEALKEEPER_ROUTINE_RUN: runId,
          SEALKEEPER_INVOCATION: invocation,
        },
        timeoutMs,
        tokenCap: routine.limits.tokensPerRun,
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
      `Claimed ${entry.claimed}, submitted ${entry.submitted}, confirmed ${entry.confirmed}.`,
    );
    parts.push(`${spent(entry)}.`);
  }
  return parts.join(' ');
}

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

// status

async function status(cmd: Command): Promise<void> {
  await requireConfig(cmd);
  const routine = await loadRoutineConfig(cmd);
  const entries = await readRoutine();
  const now = new Date();
  const today = {
    claims: budgetOf(entries, 'claim', routine, now),
    confirms: budgetOf(entries, 'confirm', routine, now),
  };
  const runs = entries.filter((e): e is RunEntry => e.kind === 'run');
  const lastRun = runs.at(-1) ?? null;
  const waiting = waitingForPerson(entries, now);
  const active = await readLiveLock();

  if (wantsJson(cmd)) {
    stdout(
      JSON.stringify({
        installed: routine.schedule !== undefined,
        schedule: routine.schedule ?? null,
        paused: routine.paused ?? null,
        running: active !== null,
        limits: routine.limits,
        today: {
          claimed: today.claims.used,
          confirmed: today.confirms.used,
        },
        allow: routine.allow,
        allowSlugs: routine.allowSlugs,
        lastRun,
        waiting,
      }),
    );
    return;
  }

  const s = routine.schedule;
  stdout(
    s
      ? `Routine   every day at ${s.time} with ${s.scheduler}, starts ${s.agentCommand}`
      : `Routine   not installed. ${cli('routine install')} sets it up`,
  );
  if (routine.paused) {
    stdout(`Paused    ${routine.paused.reason}`);
  }
  if (active !== null) stdout('Running   a run is going now');
  stdout(
    `Today     claimed ${today.claims.used} of ${today.claims.cap}, confirmed ${today.confirms.used} of ${today.confirms.cap}`,
  );
  stdout(
    `Per run   ${routine.limits.minutesPerRun} minutes, ${routine.limits.tokensPerRun.toLocaleString('en-US')} tokens`,
  );
  stdout(`Allowed   ${allowedNames(routine)}`);
  stdout(
    lastRun
      ? `Last run  ${lastRun.at}. ${runLine(lastRun)}`
      : 'Last run  none yet',
  );
  if (waiting.length === 0) return;
  stdout('');
  stdout(`Waiting for you, from the last ${SKIP_LIST_DAYS} days`);
  for (const item of waiting) stdout(`  ${waitingLine(item)}`);
}

// Skipped work from the last week, newest first, one line per task and
// action.
export function waitingForPerson(
  entries: RoutineEntry[],
  now: Date,
): SkipEntry[] {
  const since = now.getTime() - SKIP_LIST_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const out: SkipEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as RoutineEntry;
    if (e.kind !== 'skip' || Date.parse(e.at) < since) continue;
    const key = `${e.action}:${e.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function waitingLine(skip: SkipEntry): string {
  const by = skip.operator ? ` from ${skip.operator}` : '';
  const type = skip.taskType ? ` ${skip.taskType}` : '';
  switch (skip.reason) {
    case 'open_task':
      return `open${type} task ${skip.taskId}${by}. Look first with ${cli(`tasks show ${skip.taskId}`)}`;
    case 'poster_not_allowed':
      return `addressed${type} task ${skip.taskId}${by}, not on the allowlist. Look first with ${cli(`tasks show ${skip.taskId}`)}`;
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
