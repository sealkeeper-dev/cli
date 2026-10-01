// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto';
import { GAME, GAME_TASK_ORIGINS, OpenTasksRequest } from '@sealkeeper/schema';
import type { Command } from 'commander';
import type { z } from 'zod';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from './api.js';
import { type Input, streamInput } from './ask.js';
import { requireConfig } from './cli-config.js';
import { type Config, type Paths, paths } from './config.js';
import {
  declaredFingerprint,
  refusesFingerprint,
} from './declared-fingerprint.js';
import { type EmitInput, emit } from './emit.js';
import { KeyError, loadSigner, type Signer } from './identity.js';
import { dayOf, readDaysFrom } from './log.js';
import { stderr, stdout } from './output.js';
import {
  agentHandle,
  type ListTasksPage,
  type TaskResponse,
} from './responses.js';

// What tasks pull, claim, submit, post and show and prove share. fetch is
// injectable so tests can stand in for the API. isTTY says whether stdout
// is a terminal, which prove reads to tell a person from an agent.
// claudeDir and cwd say where prove looks for the Claude Code hooks.
// stdin is where tasks outcome asks the poster, which tests replace.
export type TasksDeps = {
  fetch: typeof fetch;
  isTTY?: () => boolean;
  claudeDir?: () => string;
  cwd?: () => string;
  stdin?: () => Input;
};

export const defaultTasksDeps: TasksDeps = {
  fetch: (...args) => fetch(...args),
  stdin: () => streamInput(process.stdin),
};

export type TaskSession = {
  config: Config;
  signer: Signer;
  api: ApiClient;
};

// Config, key and API client for a task command. Ends the command with the
// init hint when either the config or the key is missing.
export async function openTaskSession(
  cmd: Command,
  deps: TasksDeps,
): Promise<TaskSession> {
  const config = await requireConfig(cmd);
  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
  });
  // Signed for the API this session talks to, so aud is its origin.
  let signer: Signer;
  try {
    signer = await loadSigner(api.apiUrl);
  } catch (error) {
    if (error instanceof KeyError || error instanceof ApiError) {
      cmd.error(error.message);
    }
    throw error;
  }
  return { config, signer, api };
}

// Ends the command with the API's message. Anything else is a bug and is
// rethrown.
export function failOnApiError(cmd: Command, error: unknown): never {
  if (error instanceof ApiError) cmd.error(error.message);
  throw error;
}

// Appends the matching event to the local log, without syncing, so status
// and the log reflect the work. The write to the API already happened, so a
// failure here is a warning, not an error.
export async function recordEvent(input: EmitInput): Promise<void> {
  try {
    await emit(input);
  } catch (error) {
    stderr(
      `warning: could not record ${input.type} in the local log: ${(error as Error).message}`,
    );
  }
}

// Signs and sends a claim, submit or outcome request with the declared
// fingerprint (VB-3), and once more without it when the API refuses the
// field, so a fingerprint never costs the request. request is the payload
// its schema already parsed. What send throws otherwise is thrown.
export async function sendWithFingerprint<T>(
  signer: Signer,
  request: object,
  send: (envelope: string) => Promise<T>,
): Promise<T> {
  const declared = await declaredFingerprint();
  if (declared.fingerprint === undefined) {
    return send(await signer.sign(request));
  }
  try {
    return await send(await signer.sign({ ...request, ...declared }));
  } catch (error) {
    if (!refusesFingerprint(error)) throw error;
    return send(await signer.sign(request));
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Lowercase hex sha256 of the UTF-8 bytes of the text. tasks outcome signs it
// as the evidence hash of the submission the poster read.
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Aligned key and value lines for human output.
export function fieldLines(fields: [string, string][]): string[] {
  const width = Math.max(...fields.map(([key]) => key.length));
  return fields.map(([key, value]) => `${key.padEnd(width)}  ${value}`);
}

export function printFields(fields: [string, string][]): void {
  for (const line of fieldLines(fields)) stdout(line);
}

// 2026-10-03 09:00 UTC, to the minute, how the game commands print a time.
export function utc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// poster is the poster's handle, given for an addressed task, whose spec
// comes from another operator.
export function taskSummary(task: TaskResponse, poster?: string) {
  return {
    id: task.id,
    taskType: task.taskType,
    state: task.state,
    verification: task.verification,
    expiresAt: task.expiresAt,
    spec: task.spec,
    ...(task.assignee ? { assignee: task.assignee.handle } : {}),
    ...(poster === undefined ? {} : { poster }),
  };
}

// The handle of the agent with this id, slug/name, as the API answers it.
// The id itself when the API does not answer, so a caller always has
// something to name.
export async function handleOrId(
  api: ApiClient,
  agentId: string,
): Promise<string> {
  try {
    return agentHandle(await api.getAgent(agentId));
  } catch {
    return agentId;
  }
}

// How long after its post another operator's open task is left for a
// person, the API's TASKS_MIN_AGE_MINUTES (RT-8). The API holds the real
// number and answers a routine claim that comes too early with 409 too_new
// and the seconds left, which wins. This is only a pre filter, so the
// routine's network source never asks for a young task. A claim without
// origin, a person's, never waits.
export const CLAIM_MIN_AGE_MS = 30 * 60_000;

// True when the task is old enough to claim by this machine's clock. An
// addressed task is, since its assignee claims at once, and so is a seed
// task, since no person waits to look at it.
export const claimableByAge = (
  task: TaskResponse,
  now: number = Date.now(),
): boolean =>
  Boolean(task.assignee) ||
  task.seed === true ||
  now - Date.parse(task.postedAt) >= CLAIM_MIN_AGE_MS;

// One page of the open pool as this agent sees it (VOU-200). The signed
// POST /v1/tasks/open leaves out the tasks it is barred from, which a claim
// would only get 409 claim_barred for. An API from before that route
// answers 404, and one that refuses this machine's clock answers
// issued_at_out_of_window, so either reads the public GET
// /v1/tasks?state=open instead, which still lists them and costs a 409 per
// barred task. The cursor goes back as the API sent it. Throws what the
// API client throws.
export async function openTasksPage(
  api: ApiClient,
  signer: Signer,
  query: Omit<z.input<typeof OpenTasksRequest>, 'issuedAt'>,
): Promise<ListTasksPage> {
  const request = { ...query, issuedAt: new Date().toISOString() };
  OpenTasksRequest.parse(request);
  try {
    return await api.listOpenTasks(await signer.sign(request));
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      !(error.status === 404 || error.code === 'issued_at_out_of_window')
    ) {
      throw error;
    }
  }
  return api.listTasksPage({ ...query, state: 'open' });
}

// The tasks in a GET /v1/tasks?assignee= answer that are really addressed
// to this agent and not posted by it, oldest first, whatever the server
// sent. prove, tasks pull --addressed and the status count share it.
export function addressedTo(
  tasks: TaskResponse[],
  agentId: string,
): TaskResponse[] {
  return tasks
    .filter(
      (task) => task.assignee?.id === agentId && task.posterAgentId !== agentId,
    )
    .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
}

// A duel or weekly challenge task (D-GAME-5). Its spec reaches its
// claimant only in the claim, submit and release answers, timed from the
// claim, and every other read, GET /v1/tasks/:id included, shows {}.
export const isGameTask = (task: Pick<TaskResponse, 'origin'>): boolean =>
  (GAME_TASK_ORIGINS as readonly string[]).includes(task.origin ?? '');

// What tasks show and a repeated tasks claim print for the spec of a game
// task, which the public read they make shows as {}.
// It holds before the claim and after it.
export const GAME_SPEC_AT_CLAIM =
  'The spec of a duel or challenge task is shown only in the answer to its claim.';

// The submits of a duel side, one today, as duel and tasks submit word it.
export const DUEL_SUBMITS =
  GAME.duelSubmits === 1 ? 'one submit' : `${GAME.duelSubmits} submits`;

// The submits of each weekly challenge task, one today, as challenge and
// tasks submit word it.
export const CHALLENGE_SUBMITS =
  GAME.challengeSubmits === 1
    ? 'one submit'
    : `${GAME.challengeSubmits} submits`;

// A task lives at most seven days, so a claim older than that is expired
// whatever happened to it. One more day covers the UTC day boundary.
const CLAIM_LOOKBACK_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

// Task ids this agent claimed in the local log with no task.submitted after,
// oldest first. The log only knows what this machine did, so a task may
// have expired since. Callers that need to know ask the API.
export async function unsubmittedClaims(
  now: Date = new Date(),
  p: Paths = paths(),
): Promise<string[]> {
  const claimed = new Set<string>();
  const first = dayOf(
    new Date(now.getTime() - (CLAIM_LOOKBACK_DAYS - 1) * DAY_MS),
  );
  // Through the newest day file, which after a clock rollback is named for
  // a day still to come and holds the latest claims and submissions.
  for (const event of await readDaysFrom(first, p)) {
    if (event.type === 'task.claimed') claimed.add(event.payload.task_id);
    if (event.type === 'task.submitted') {
      claimed.delete(event.payload.task_id);
    }
  }
  return [...claimed];
}
