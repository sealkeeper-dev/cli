// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto';
import {
  GAME,
  GAME_TASK_ORIGINS,
  type RequestPurpose,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from './api.js';
import { type Input, streamInput } from './ask.js';
import { backgroundSync } from './background-sync.js';
import { requireConfig } from './cli-config.js';
import { type Config, type Paths, paths } from './config.js';
import {
  declaredFingerprint,
  refusesFingerprint,
} from './declared-fingerprint.js';
import { type EmitInput, emit } from './emit.js';
import { keepHanded } from './handed.js';
import { KeyError, loadSigner, type Signer } from './identity.js';
import { cli } from './invocation.js';
import { dayOf, readDaysFrom } from './log.js';
import { keepNudgeFresh } from './nudge.js';
import { stderr, stdout } from './output.js';
import type { CoreAnswerResponse, TaskResponse } from './responses.js';

// What run, submit, release, claim, post and outcome share. fetch is
// injectable so tests can stand in for the API. isTTY says whether stdout
// is a terminal, which run reads to tell a person from an agent.
// claudeDir and cwd say where run looks for the Claude Code hooks.
// stdin is where outcome asks the poster, which tests replace.
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

// What a task command does once it wrote a task event (VOU-627). Task work
// is SealKeeper work, so it starts a sync through the gate every automatic
// sync takes, as a routine run does at its end (backgroundSync), and
// refreshes the goal the session summary reads (keepNudgeFresh). The gate
// sends nothing before the operator's first sync showed the events and
// asked, nothing with auto sync off and nothing inside the throttle. Both
// are side tasks that print nothing and never reject, so a command starts
// it after its write and awaits it after its output, and a failure never
// fails the command.
export async function afterTaskWork(
  deps: Pick<TasksDeps, 'fetch'>,
): Promise<void> {
  await Promise.all([
    backgroundSync({ fetch: deps.fetch }),
    keepNudgeFresh(deps.fetch),
  ]);
}

// Signs and sends a claim, submit or outcome request with the declared
// fingerprint (VB-3), and once more without it when the API refuses the
// field, so a fingerprint never costs the request. request is the payload
// its schema already parsed, purpose the route it is for. What send throws
// otherwise is thrown.
export async function sendWithFingerprint<T>(
  signer: Signer,
  request: object,
  purpose: RequestPurpose,
  send: (envelope: string) => Promise<T>,
): Promise<T> {
  const declared = await declaredFingerprint();
  if (declared.fingerprint === undefined) {
    return send(await signer.sign(request, purpose));
  }
  try {
    return await send(await signer.sign({ ...request, ...declared }, purpose));
  } catch (error) {
    if (!refusesFingerprint(error)) throw error;
    return send(await signer.sign(request, purpose));
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Lowercase hex sha256 of the UTF-8 bytes of the text. outcome signs it
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

// A duel or weekly challenge task (D-GAME-5). Its spec reaches its
// claimant only in the claim, submit and release answers, timed from the
// claim, and every other read, GET /v1/tasks/:id included, shows {}.
export const isGameTask = (task: Pick<TaskResponse, 'origin'>): boolean =>
  (GAME_TASK_ORIGINS as readonly string[]).includes(task.origin ?? '');

// The kinds a handed over task of a duel or a challenge has, its origin.
const GAME_KINDS: ReadonlySet<string> = new Set(GAME_TASK_ORIGINS);

// What a repeated claim prints for the spec of a game task, which
// every read but its first claim shows as {}.
export const GAME_SPEC_AT_CLAIM =
  'The spec of a duel or challenge task is shown only in the answer to its claim.';

// The submits of a duel side, one today, as duel and submit word it.
export const DUEL_SUBMITS =
  GAME.duelSubmits === 1 ? 'one submit' : `${GAME.duelSubmits} submits`;

// The submits of each weekly challenge task, one today, as challenge and
// submit word it.
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

// The placeholder in the submit command of a task an agent is handed.
export const ANSWER_FILE = '<answer file>';

// The exact submit command of a task an agent is handed, with the answer
// file to fill in, spelled with this machine's invocation.
export const submitCommand = (taskId: string): string =>
  `${cli(`submit ${taskId}`)} --file ${ANSWER_FILE}`;

// The claimed tasks a list of the server reads at most, one page.
const HELD_LIMIT = 100;

// The claimed tasks the server says this agent holds, which include claims
// made on another machine. The API filters on the claimant, so other
// agents' claims never push these off the page (VOU-208), and the claim
// cap keeps them to one page. Throws what the API client throws.
export async function serverHeld(
  api: ApiClient,
  agentId: string,
): Promise<TaskResponse[]> {
  const claimed = await api.listTasks({
    state: 'claimed',
    claimant: agentId,
    limit: HELD_LIMIT,
  });
  return claimed.filter((task) => task.claimantAgentId === agentId);
}

// One task in full, as claim prints it. The spec, the schema when
// there is one and the two ways to submit. tail replaces the submit lines,
// as outcome does for the poster.
export function taskDetail(
  task: TaskResponse,
  now: number,
  tail?: string[],
): string[] {
  const lines = [
    `Task ${task.id}. type ${task.taskType}. ${task.state}. expires ${relative(Date.parse(task.expiresAt) - now)}.`,
    ...(task.assignee
      ? [`Addressed to ${task.assignee.handle}. Only that agent can claim it.`]
      : []),
    // A game task read anywhere but its claim shows {}, so it gets one
    // line instead of an empty spec.
    ...(isGameTask(task) && Object.keys(task.spec).length === 0
      ? [GAME_SPEC_AT_CLAIM]
      : ['Spec:', indentText(JSON.stringify(task.spec, null, 2))]),
  ];
  if (task.verification.kind === 'schema') {
    lines.push(
      'The answer must be JSON that matches this schema:',
      indentText(JSON.stringify(task.verification.jsonSchema, null, 2)),
    );
  }
  if (tail !== undefined) return [...lines, ...tail];
  lines.push(
    'Submit with:',
    `  ${cli(`submit ${task.id}`)} --file <path you choose>`,
    `  ${cli(`submit ${task.id}`)} --text <answer>`,
  );
  if (task.verification.kind === 'counterparty') {
    lines.push('The poster confirms this one, so it verifies once they agree.');
  }
  return lines;
}

export function indentText(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// in 12 minutes, in 47 hours, in 3 days. A time already past reads as now.
function relative(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 120) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 72) return `in ${hours} hours`;
  return `in ${Math.floor(hours / 24)} days`;
}

// A task id the API does not know, said by claim and release.
export const NOT_FOUND = 'no task with this id';

// The claims in the local log, so status and the log reflect the work. The
// answer holds the tasks claimed before as well, so only a task the log
// does not hold yet is recorded. run, challenge, duel and the routine's
// run all use it. What submit needs of the spec of each duel or challenge
// task is kept too, since only this answer shows that spec (keepHanded).
export async function recordClaims(
  answer: Pick<CoreAnswerResponse, 'tasks'>,
): Promise<void> {
  await keepHanded(answer.tasks.filter((task) => GAME_KINDS.has(task.kind)));
  const known = new Set(await unsubmittedClaims());
  const fresh = answer.tasks.filter((task) => !known.has(task.id));
  for (const task of fresh) {
    await recordEvent({
      type: 'task.claimed',
      payload: { task_id: task.id, task_type: task.type },
    });
  }
}
