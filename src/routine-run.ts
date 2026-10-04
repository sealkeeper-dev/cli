// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RoutineNextRequest, type TaskOutcome } from '@sealkeeper/schema';
import { clampMs } from './adapter-core.js';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from './api.js';
import { backgroundSync } from './background-sync.js';
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
import { type EmitInput, emit } from './emit.js';
import { createObserver } from './fingerprint-observer.js';
import { takeAskAgain } from './handed.js';
import { KeyError, loadSigner, type Signer } from './identity.js';
import { cli } from './invocation.js';
import { declaredModel } from './model-name.js';
import { modelNameOf, toolNameOf } from './names.js';
import { keepNudgeFresh } from './nudge.js';
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
// jitter of a wait (VOU-613). signal is the caller's of a Mastra routine,
// which stops the run as its limits do (VOU-620). sleep ends at once when
// it aborts. clock, in milliseconds, times the run's session and each
// answer for their events (VOU-627), performance.now by default.
export type RunDeps = {
  fetch: typeof fetch;
  msPerMinute?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  clock?: () => number;
};

// The agent of a run, made at the first question in the run's working
// folder. close runs when the run ends, for a transcript. unready is why
// the agent cannot be asked at all, which fails the run before its first
// step, as an OpenClaw routine with no model (VOU-623).
export type RunAgent = {
  runtime: RoutineRuntimeName;
  unready?: AgentProblem;
  start(workDir: string): { agent: AgentRuntime; close?: () => void };
};

// What failed in a failed run, kept in its run line as failure. The
// routine screen says the fix beside it (RUN_FAILURES in
// commands/routine.ts). agent_auth and agent_tools since VOU-601,
// api_later since VOU-613, agent_model since VOU-623.
export type RunFailure =
  | 'key'
  | 'api'
  | 'api_later'
  | 'old_api'
  | 'workdir'
  | 'agent_missing'
  | 'agent_failed'
  | 'agent_auth'
  | 'agent_tools'
  | 'agent_model';

const PROBLEM_FAILURE: Record<AgentProblem['kind'], RunFailure> = {
  auth: 'agent_auth',
  tools: 'agent_tools',
  model: 'agent_model',
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

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const end = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', end);
      resolve();
    };
    const timer = setTimeout(end, ms);
    signal?.addEventListener('abort', end, { once: true });
  });

// What stops a run before SealKeeper answers done, a limit or the caller.
type StopFor = NonNullable<AgentResult['stoppedFor']>;

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
 * is something the API did. Then step n + 1. The wall clock, the token
 * cap and the caller's signal are checked before each call, and the agent
 * gets what is left of both limits. An abort stops the run the way a limit
 * does, and also ends a wait for the API at once with no step asked after
 * it. A signal aborted before the call starts nothing and takes no lock.
 *
 * A run is SealKeeper work, so it records its activity in the local log
 * (VOU-627), the one place the CLI writes a session or a usage event. A
 * session.start, with the run id as the session id, when the run first
 * asks its agent, so a run that asks nothing records no session, and a
 * session.end with its duration when the run ends, whatever ends it. A
 * usage event for each answer the runtime reported tokens in and out for,
 * with the time the answer took and the model, see recordUsage. Once the
 * lock is released a run that held it syncs through the gate every
 * automatic sync takes, unless its caller aborted it, so nothing leaves
 * before the operator's first sync and nothing with auto sync off. A sync
 * that fails is a sync_failed line and never fails the run.
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
  const aborted = () => deps.signal?.aborted === true;
  const clock = deps.clock ?? (() => performance.now());
  // When the run first asked its agent, by clock, until its session.end is
  // written, then null again.
  let sessionAt: number | null = null;
  let card: CardRefresh | null = null;
  let agentStarted = false;
  let tokens: number | null = null;
  let costUsd: number | null = null;
  let entry: Omit<RunEntry, 'at'> | null = null;
  // The model the runtime reports for an answer goes to the runtime's
  // fingerprint source, as the live adapters write it, so the next sync
  // declares it (VOU-614). Written when the run sees a new id, never fails
  // the run.
  const observer =
    agent === null ? null : createObserver(agent.runtime, () => p);

  const finish = async (
    outcome: RunOutcome,
    reason?: string,
    failure?: RunFailure,
  ): Promise<void> => {
    await endSession();
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

  if (aborted()) {
    await finish('aborted', 'it never started');
    return done();
  }
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
  if (agent.unready !== undefined) {
    await finish(
      'failed',
      agent.unready.reason,
      PROBLEM_FAILURE[agent.unready.kind],
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
    // Also when the run threw, so no session is left open.
    await endSession();
    await removeLock(runId, p);
  }
  await syncAtEnd();
  return done();

  // Appends one event of the run's activity to the local log. A failure
  // only loses the event, never the run.
  async function record(input: EmitInput): Promise<void> {
    try {
      await emit({ ...input, version: config.version }, p);
    } catch {
      // Not recorded.
    }
  }

  async function startSession(): Promise<void> {
    if (sessionAt !== null) return;
    sessionAt = clock();
    await record({ type: 'session.start', payload: { session_id: runId } });
  }

  async function endSession(): Promise<void> {
    if (sessionAt === null) return;
    const ms = clock() - sessionAt;
    sessionAt = null;
    await record({
      type: 'session.end',
      payload: { session_id: runId, duration_ms: clampMs(ms) },
    });
  }

  // One usage event for an answer the agent gave, stopped by nothing, with
  // tokens in and out as its runtime reported them, the time it took and
  // the model when the runtime named one. An answer with no split writes
  // none, and no number is ever made up. The schema's ranges hold, and an
  // event outside them is not recorded.
  async function recordUsage(
    result: AgentResult,
    ms: number,
    model: string | null,
  ): Promise<void> {
    if (result.split === undefined) return;
    if (result.stoppedFor !== null || result.error !== undefined) return;
    await record({
      type: 'usage',
      payload: {
        tokens_in: result.split.tokensIn,
        tokens_out: result.split.tokensOut,
        latency_ms: clampMs(ms),
        ...(model === null ? {} : { model }),
      },
    });
  }

  // Through the gate, which says whether it may go, beside a refresh of the
  // goal the session summary reads (keepNudgeFresh). Never fails the run.
  // A run its caller aborted returns at once and sends nothing, and its
  // events go with the next sync.
  async function syncAtEnd(): Promise<void> {
    if (aborted()) return;
    const [synced] = await Promise.all([
      backgroundSync({ fetch: deps.fetch, paths: p }),
      keepNudgeFresh(deps.fetch, p),
    ]);
    if (synced !== 'failed') return;
    try {
      await appendRoutine({ kind: 'sync_failed', runId }, p);
    } catch {
      // Not kept.
    }
  }

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
      let answer: RoutineAnswerResponse | null;
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
      if (answer === null) {
        // The caller aborted while the run waited for the API.
        await stop('caller');
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
    // reach, which the API answers as a no-op. null when the caller aborted
    // during the wait, and then no step is asked again.
    async function askStep(
      s: LiveSession,
      n: number,
      v: { taskId: string; outcome: TaskOutcome } | null,
    ): Promise<RoutineAnswerResponse | null> {
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
          if (tries >= STEP_TRIES) throw error;
          const waited = await backOff(error, tries);
          if (aborted()) return null;
          if (!waited) throw error;
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
    // large to be a number is past every cap. The caller's abort ends the
    // wait at once, and then it is false.
    async function backOff(error: ApiError, tries: number): Promise<boolean> {
      const asked = (error.retryAfterSec ?? 0) * 1000;
      const base = Math.max(asked, STEP_RETRY_MS * 2 ** (tries - 1));
      const room = Math.min(STEP_WAIT_MAX_MS, deadline - Date.now());
      if (!(base <= room) || aborted()) return false;
      const spread = Math.min(Math.max(random(), 0), 1) * (base / 2);
      await sleep(Math.min(room, Math.floor(base + spread)), deps.signal);
      return !aborted();
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

    // The caller's abort, the wall clock or the token cap, when the run is
    // past one.
    function overLimit(): StopFor | null {
      if (aborted()) return 'caller';
      if (Date.now() >= deadline) return 'minutesPerRun';
      if (tokens !== null && tokens >= tokenCap) return 'tokensPerRun';
      return null;
    }

    // Ends the run where a limit or the caller stopped it. Only a limit has
    // a limit line.
    async function stop(limit: StopFor) {
      if (limit === 'caller') {
        await finish('aborted');
        return;
      }
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
      await startSession();
      const asked = clock();
      const result = await runtime().ask({
        prompt,
        timeoutMs: Math.max(1, deadline - Date.now()),
        tokenCap: Math.max(1, tokenCap - (tokens ?? 0)),
      });
      const took = clock() - asked;
      if (result.tokens !== null) tokens = (tokens ?? 0) + result.tokens;
      if (result.costUsd !== null) costUsd = (costUsd ?? 0) + result.costUsd;
      const model = toolNameOf(result.model);
      if (model !== null) {
        await observer?.model(model, modelNameOf(result.model));
      }
      await recordUsage(result, took, model);
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
    // folder and submitted, checked against the spec the step handed over,
    // since a game task's public read shows {} (VOU-635). A task it gave no
    // answer for, or whose answer was refused, is given back unless it is a
    // game task. A game task has no release, so every later run is handed
    // it again until it is submitted or its duel or challenge ends. One an
    // earlier run already answered gets the answer that run kept, and the
    // agent is not asked again. When a check here refuses that kept answer
    // before anything is sent, the agent is asked again and its new answer
    // replaces the kept one, at most GAME_ASKS_AGAIN times for a task
    // across runs, noted in handed.ts. Past that the run asks no more and
    // says the task needs the operator, and the kept answer stays.
    async function solve(
      s: LiveSession,
      task: RoutineTask & { kind: string },
    ): Promise<'stop' | null> {
      const kept = isGame(task) ? await keptAnswer(workDir, task.id) : null;
      if (kept !== null) {
        const sent = await submit(s, task, kept, null);
        if (sent !== 'local') return sent;
        const over = overLimit();
        if (over !== null) {
          await giveUp(s, task, 'the run stopped before an answer');
          await stop(over);
          return 'stop';
        }
        if (!(await takeAskAgain(task.id, GAME_ASKS_AGAIN, p))) {
          await appendRoutine(
            {
              kind: 'unanswered',
              runId,
              taskId: task.id,
              taskType: task.type,
              reason: `the kept answer fails a check before submit and the agent is asked again at most ${GAME_ASKS_AGAIN} times a task, so it needs the operator. Fix .sealkeeper-answers/${task.id}.txt in the routine's working folder, or submit it by hand`,
              released: false,
            },
            p,
          );
          return null;
        }
      }
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
      const sent = await submit(s, task, text, modelNameOf(result.model));
      return sent === 'local' ? null : sent;
    }

    // Submits one answer and logs it, local when a check here refused it
    // before anything was sent.
    async function submit(
      s: LiveSession,
      task: RoutineTask & { kind: string },
      text: string,
      solvedBy: string | null,
    ): Promise<'stop' | 'local' | null> {
      // A submit the API rate limited is sent again after the wait a step
      // takes, since the API refused it before reading it (VOU-613). Past
      // the tries, or when the wait does not fit, it fails as any refused
      // submit, and a wait that does not fit or that the caller aborts ends
      // the run.
      for (let tries = 1; ; tries++) {
        try {
          // The model the runtime reported for this answer, else the
          // one sync declares (VOU-615).
          const sent = await submitAnswer(s, task.id, text, {
            routine: true,
            spec: task.spec,
            modelName:
              solvedBy ?? (await declaredModel({ paths: p }))?.name ?? null,
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
            if (aborted()) await stop('caller');
            else await comeBackLater(later);
            return 'stop';
          }
          return error instanceof SubmitRefused && error.local ? 'local' : null;
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

// How often the agent is asked again for one game task whose kept answer
// a check refuses before submit, across runs (VOU-635). Small, since a game
// task has one submit and no release, so a later run is handed it again
// until it is submitted or ends.
const GAME_ASKS_AGAIN = 2;

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

// The answer an earlier run kept for this task, null when none is kept or
// it does not read.
async function keptAnswer(
  workDir: string,
  taskId: string,
): Promise<string | null> {
  try {
    const text = await readFile(
      join(workDir, '.sealkeeper-answers', `${taskId}.txt`),
      'utf8',
    );
    return text === '' ? null : text;
  } catch {
    return null;
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
