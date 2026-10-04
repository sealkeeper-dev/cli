// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RoutineNextRequest, type TaskOutcome } from '@sealkeeper/schema';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from './api.js';
import { type CardRefresh, refreshCard } from './card.js';
import { releaseClaim } from './commands/release.js';
import { SubmitRefused, submitAnswer } from './commands/submit.js';
import {
  type Config,
  type Paths,
  paths,
  type RoutineConfig,
  readConfig,
  writeFileAtomic,
} from './config.js';
import { KeyError, loadSigner, type Signer } from './identity.js';
import { cli } from './invocation.js';
import type { RoutineAnswerResponse } from './responses.js';
import {
  acquireLock,
  appendRoutine,
  ensureWorkDir,
  type RoutineEntry,
  type RunEntry,
  type RunOutcome,
  readRoutine,
  removeLock,
  routineAllow,
} from './routine.js';
import type {
  AgentProblem,
  AgentResult,
  AgentRuntime,
  RoutineRuntimeName,
} from './routine-agent.js';
import {
  answerOf,
  judgePrompt,
  type RoutineJudgeItem,
  type RoutineTask,
  taskPrompt,
  verdictOf,
} from './routine-prompt.js';
import { durationText } from './sync.js';
import { recordClaims } from './tasks.js';

// One routine run, the loop the API drives (VOU-599). sealkeeper routine
// run starts it from the scheduler's job with Claude Code or OpenClaw, and
// routine(agent) from sealkeeper/mastra in the operator's own process
// (VOU-601). Every runtime gets the same loop, and the runtime only puts
// one question to one agent, see routine-agent.ts. This file is part of
// the Mastra bundle, so it imports nothing that installs a job.

// What a run needs besides the agent. Tests shorten the wall clock with
// msPerMinute, pass a sleep that does not wait and a random source for the
// jitter of a wait (VOU-613).
export type RunDeps = {
  fetch: typeof fetch;
  msPerMinute?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

// The agent of a run, made at the first question in the run's working
// folder. close runs when the run ends, for a transcript.
export type RunAgent = {
  runtime: RoutineRuntimeName;
  start(workDir: string): { agent: AgentRuntime; close?: () => void };
};

// What failed in a failed run, kept in its run line as failure. The
// routine screen says the fix beside it (RUN_FAILURES in
// commands/routine.ts). agent_auth and agent_tools since VOU-601,
// api_later since VOU-613.
export type RunFailure =
  | 'key'
  | 'api'
  | 'api_later'
  | 'old_api'
  | 'workdir'
  | 'agent_missing'
  | 'agent_failed'
  | 'agent_auth'
  | 'agent_tools';

const PROBLEM_FAILURE: Record<AgentProblem['kind'], RunFailure> = {
  auth: 'agent_auth',
  tools: 'agent_tools',
  failed: 'agent_failed',
};

// How long past the wall clock limit the run lock lasts, for the card and
// the last call. A lock whose process is gone is stale sooner.
const LOCK_MARGIN_MS = 10 * 60_000;

// How often a step is asked again after the API said it is busy, rate
// limited or could not be reached, and the first wait between, which
// doubles with each try (VOU-613). A step asked again carries the same run
// id and step, which the API answers as a no-op, so this is safe.
const STEP_TRIES = 3;
const STEP_RETRY_MS = 2_000;
// The longest one wait of a run for the API, Retry-After included. A
// longer one, or one past the run's wall clock, ends the run as api_later.
const STEP_WAIT_MAX_MS = 2 * 60_000;

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
  deps: RunDeps,
  config: Config,
  routine: RoutineConfig,
  agent: RunAgent | null,
  p: Paths = paths(),
  runId: string = randomUUID(),
): Promise<Omit<RunEntry, 'at'>> {
  const startedAt = new Date();
  const minutes = routine.limits.minutesPerRun;
  const timeoutMs = minutes * (deps.msPerMinute ?? 60_000);
  const deadline = startedAt.getTime() + timeoutMs;
  const tokenCap = routine.limits.tokensPerRun;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  let card: CardRefresh | null = null;
  let agentStarted = false;
  let tokens: number | null = null;
  let costUsd: number | null = null;
  let entry: Omit<RunEntry, 'at'> | null = null;

  const finish = async (
    outcome: RunOutcome,
    reason?: string,
    failure?: RunFailure,
  ): Promise<void> => {
    entry = {
      kind: 'run',
      runId,
      ...(agent === null ? {} : { runtime: agent.runtime }),
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

  if (agent === null) {
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
    // The agent, made at the first question, so a run that asks nothing
    // starts nothing.
    let made: ReturnType<RunAgent['start']> | null = null;
    const runtime = (): AgentRuntime => {
      made ??= (agent as RunAgent).start(workDir);
      return made.agent;
    };
    try {
      await loop(session, runtime, workDir);
    } finally {
      (made as ReturnType<RunAgent['start']> | null)?.close?.();
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
        if (askedLater(error)) {
          await comeBackLater(error);
        } else {
          await finish(
            'failed',
            `could not read the API: ${error.message}`,
            error.status === 404 ? 'old_api' : 'api',
          );
        }
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
          if (!(error instanceof ApiError) || !askAgain(error)) throw error;
          if (tries >= STEP_TRIES || !(await backOff(error, tries))) {
            throw error;
          }
        }
      }
    }

    // Waits before try n + 1 after a refusal on try n, and false, with no
    // wait, when the wait does not fit. The wait is the API's Retry-After
    // when it sent one, never shorter than the backoff of 2 then 4
    // seconds, so a Retry-After of 0 is no tight loop. Up to half again
    // at random goes on top, so runs refused together do not come back
    // together. It fits when it is at most STEP_WAIT_MAX_MS and what is
    // left of the run's wall clock, so no wait is past the run's own end,
    // also in a Mastra operator's process. Retry-After is read as digits
    // only (api.ts), so a negative or non-numeric one is none, and one too
    // large to be a number is past every cap.
    async function backOff(error: ApiError, tries: number): Promise<boolean> {
      const asked = (error.retryAfterSec ?? 0) * 1000;
      const base = Math.max(asked, STEP_RETRY_MS * 2 ** (tries - 1));
      const room = Math.min(STEP_WAIT_MAX_MS, deadline - Date.now());
      if (!(base <= room)) return false;
      const spread = Math.min(Math.max(random(), 0), 1) * (base / 2);
      await sleep(Math.min(room, Math.floor(base + spread)));
      return true;
    }

    // Ends the run as api_later, the API asked it to come back later. The
    // seconds it asked for, at most, never the header itself.
    async function comeBackLater(error: ApiError): Promise<void> {
      const sec = error.retryAfterSec;
      await finish(
        'failed',
        sec !== null && sec <= DAY_SEC
          ? `the API asked this run to come back later, in ${durationText(sec * 1000)}`
          : 'the API asked this run to come back later',
        'api_later',
      );
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
      if (result.problem !== undefined) {
        await finish(
          'failed',
          result.problem.reason,
          PROBLEM_FAILURE[result.problem.kind],
        );
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
      // A submit the API rate limited is sent again after the wait a step
      // takes, since the API refused it before reading it (VOU-613). Past
      // the tries, or when the wait does not fit, it fails as any refused
      // submit, and a wait that does not fit ends the run.
      for (let tries = 1; ; tries++) {
        try {
          const sent = await submitAnswer(s, task.id, text, {
            routine: true,
          });
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
          return null;
        } catch (error) {
          if (!(error instanceof SubmitRefused || error instanceof ApiError)) {
            throw error;
          }
          const limited =
            error instanceof SubmitRefused ? error.rateLimited : error;
          const later =
            limited !== undefined && askedLater(limited) && askAgain(limited)
              ? limited
              : null;
          const fits =
            later !== null &&
            tries < STEP_TRIES &&
            (await backOff(later, tries));
          if (fits) continue;
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
          if (later !== null && tries < STEP_TRIES) {
            await comeBackLater(later);
            return 'stop';
          }
          return null;
        }
      }
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

const DAY_SEC = 24 * 60 * 60;

// A refusal the next try may get through, a busy step, a network failure,
// a 5xx and a 429 rate_limited, the burst answer of a quota. A 429 with a
// code of its own, such as game_cap_reached with Retry-After at the next
// 00:00 UTC, is about the day and is never asked again (VOU-613).
const askAgain = (error: ApiError): boolean =>
  error.code === 'routine_step_busy' ||
  error.status === 0 ||
  error.status >= 500 ||
  (error.status === 429 && error.code === 'rate_limited');

// A refusal that asks the run to come back later, a 429 or an answer with
// Retry-After, rather than an API it could not read.
const askedLater = (error: ApiError): boolean =>
  error.status === 429 || error.retryAfterSec !== null;

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

// The API client and the agent key of a run, or why they could not be had.
export type LiveSession = { api: ApiClient; signer: Signer };
type Session = LiveSession | { error: string; failure: 'key' | 'api' };

// The key is loaded here rather than through openTaskSession, which ends
// the command on a missing or broken key. That exit would skip the finally
// that removes the run lock and leave no run line (cli-adapters-tasks-5).
export async function openSession(
  deps: Pick<RunDeps, 'fetch'>,
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
