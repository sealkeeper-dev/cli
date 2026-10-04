// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  MAX_SUBMISSION_BYTES,
  SubmitTaskRequest,
  TaskOutcomeRequest,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { readGuardedFile } from '../file-guard.js';
import { handedFinalLineFeed } from '../handed.js';
import { cli } from '../invocation.js';
import { containsPrivateKey } from '../key-guard.js';
import {
  endsInLineBreak,
  MAX_FAILED_SUBMITS,
  specAsksFinalLineFeed,
} from '../line-break.js';
import { declaredModel, refusesModelName } from '../model-name.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { TaskResponse } from '../responses.js';
import {
  afterTaskWork,
  CHALLENGE_SUBMITS,
  DUEL_SUBMITS,
  defaultTasksDeps,
  failOnApiError,
  isGameTask,
  openTaskSession,
  printFields,
  recordEvent,
  sendWithFingerprint,
  type TaskSession,
  type TasksDeps,
} from '../tasks.js';

export const AWAITING_POSTER = 'the poster must confirm the outcome';

// What the line break refusal says a wrong answer costs, by the task's
// origin.
function submitsLeft(origin: string | undefined): string {
  if (origin === 'duel') return `a duel side has ${DUEL_SUBMITS}`;
  if (origin === 'challenge') {
    return `a challenge task has ${CHALLENGE_SUBMITS}`;
  }
  return `a claim allows ${MAX_FAILED_SUBMITS} failed submits`;
}

/*
 * Whether the task's spec asks the answer to end in a line feed, null when
 * no spec of it can be seen here (VOU-635). From the spec the caller was
 * handed with the task when it gives one, as the routine does, else from
 * the public read. A duel or challenge task's public read shows {}, since
 * its spec reaches its claimant only in the answer that handed it over, so
 * for one of those it is what this machine kept from that answer
 * (handed.ts), null for a task handed over by an older CLI or on another
 * machine.
 */
async function asksFinalLineFeed(
  task: TaskResponse,
  handed: Record<string, unknown> | undefined,
): Promise<boolean | null> {
  if (handed !== undefined) return specAsksFinalLineFeed(handed);
  if (!isGameTask(task) || Object.keys(task.spec).length > 0) {
    return specAsksFinalLineFeed(task.spec);
  }
  return handedFinalLineFeed(task.id);
}

type SubmitOptions = {
  file?: string;
  text?: string;
  keepNewline?: boolean;
  allowOutsideCwd?: boolean;
};

// Why a submit sent nothing, or what SealKeeper refused. message is the
// line to show, code the API's error code, or the check here that refused
// it, verification the verification failure when SealKeeper checked the
// answer and found it wrong. rateLimited is the API's 429, kept so the
// routine waits for its Retry-After before the next step (VOU-613). local
// is true for a check here that refused the answer before anything was
// signed or sent, which has neither a verification nor an API error, so
// the routine asks its model again rather than send a kept answer that
// fails it (VOU-635).
export class SubmitRefused extends Error {
  override name = 'SubmitRefused';
  readonly rateLimited?: ApiError;
  readonly local: boolean;
  constructor(
    message: string,
    readonly code: string,
    readonly verification?: string,
    cause?: ApiError,
  ) {
    super(message);
    if (cause?.status === 429) this.rateLimited = cause;
    this.local = verification === undefined && cause === undefined;
  }
}

// What a submit did. task is the task before it, result after it.
export type Submitted = {
  task: TaskResponse;
  result: TaskResponse;
  awaitingPoster: boolean;
};

/*
 * One answer submitted, the path submit and the routine's run share
 * (VOU-599). Refuses an answer that holds this agent's key, a hash answer
 * that ends in a line break the spec does not ask for, or whose spec cannot
 * be seen here, unless keepNewline, and a schema answer that is not JSON,
 * before anything is signed. spec is the spec the caller was handed with
 * the task, which the routine passes, since a game task's public read
 * shows {} (asksFinalLineFeed). Then
 * signs and sends it with the declared fingerprint and the model name, and
 * notes it in the local log. modelName is the model that solved the task
 * (VOU-615), none when it is null or not a ModelName. An API that refuses
 * the name gets the submit again without it (refusesModelName). For a
 * counterparty task the claimant's success report follows, with origin
 * routine when routine is true. Throws SubmitRefused with the line to
 * show, and what the API client throws otherwise.
 */
export async function submitAnswer(
  session: Pick<TaskSession, 'signer' | 'api'>,
  id: string,
  submission: string,
  options: {
    keepNewline?: boolean;
    routine?: boolean;
    modelName?: string | null;
    spec?: Record<string, unknown>;
  } = {},
): Promise<Submitted> {
  if (await containsPrivateKey(submission)) {
    throw new SubmitRefused(
      "refusing to submit, the answer contains this agent's private key",
      'key_material',
    );
  }
  const request = SubmitTaskRequest.safeParse({ taskId: id, submission });
  if (!request.success) {
    throw new SubmitRefused(z.prettifyError(request.error), 'invalid');
  }
  const { signer, api } = session;
  const task = await api.getTask(id);

  // A schema task needs JSON, checked first so a submission that is not
  // JSON is never signed or sent. A hash task's digest goes only to its
  // poster, so the server alone checks a hash answer and says so with a
  // 422. Each failed submit costs one of the tries a claim allows, the
  // one submit of a duel side or a challenge task ends it, so a hash answer
  // with the line break most editors add is refused here unless the spec
  // asks for one or keepNewline says to send it. A spec that cannot be seen
  // here is never read as one that does not ask, so the refusal then never
  // says to remove the line break.
  const { verification } = task;
  if (
    verification.kind === 'hash' &&
    options.keepNewline !== true &&
    endsInLineBreak(submission)
  ) {
    const asks = await asksFinalLineFeed(task, options.spec);
    if (asks === false) {
      throw new SubmitRefused(
        `the answer ends in a line break, which almost always fails a hash task, and ${submitsLeft(task.origin)}. Nothing was sent. Remove the line break, or add --keep-newline to send it as is`,
        'line_break',
      );
    }
    if (asks === null) {
      throw new SubmitRefused(
        `the answer ends in a line break, and ${submitsLeft(task.origin)}. This task's spec shows only in the answer that handed it over, and it is not kept on this machine, so submit cannot tell whether the spec asks for one. Nothing was sent. If that spec asks the answer to end in a line feed, add --keep-newline to send it as is`,
        'line_break',
      );
    }
  }
  if (verification.kind === 'schema') {
    try {
      JSON.parse(submission);
    } catch {
      throw new SubmitRefused(
        'submission is not valid JSON, a schema task needs JSON, nothing was sent',
        'not_json',
      );
    }
  }

  // A counterparty task we already submitted, where reporting the outcome
  // failed last time. Skip straight to the outcome.
  const alreadySubmitted =
    verification.kind === 'counterparty' &&
    task.state === 'submitted' &&
    task.claimantAgentId === signer.agentId;

  let result = task;
  if (!alreadySubmitted) {
    const send = (payload: object) =>
      sendWithFingerprint(signer, payload, (envelope) =>
        api.submitTask(id, envelope),
      );
    const named = options.modelName
      ? SubmitTaskRequest.safeParse({
          ...request.data,
          modelName: options.modelName,
        })
      : null;
    const withModel = named?.success ? named.data : null;
    try {
      try {
        result = await send(withModel ?? request.data);
      } catch (error) {
        if (withModel === null || !refusesModelName(error)) throw error;
        result = await send(request.data);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'verification_failed') {
        const reason = error.issues[0]?.code ?? 'unknown';
        throw new SubmitRefused(
          `verification failed: ${reason}. ${error.message}`,
          error.code,
          reason,
        );
      }
      // A duel side past its 48 hours gets the duel's line, and a
      // challenge task from the week's close on the challenge's.
      throw new SubmitRefused(
        error.code === 'duel_deadline_passed' ||
          error.code === 'challenge_closed'
          ? refusal(error)
          : error.message,
        error.code,
        undefined,
        error,
      );
    }
    await recordEvent({
      type: 'task.submitted',
      payload: { task_id: result.id, task_type: result.taskType },
    });
  }

  // Counterparty tasks count only when both sides agree. The claimant
  // reports success now, and the poster confirms on their side.
  if (verification.kind === 'counterparty') {
    const outcome = TaskOutcomeRequest.parse({
      taskId: id,
      outcome: 'success',
      ...(options.routine === true ? { origin: 'routine' } : {}),
    });
    try {
      result = await sendWithFingerprint(signer, outcome, (envelope) =>
        api.postOutcome(id, envelope),
      );
    } catch (error) {
      if (error instanceof ApiError) {
        throw new SubmitRefused(
          `submitted, but reporting the outcome failed: ${error.message}. Run ${cli('submit')} again to retry`,
          error.code,
          undefined,
          error,
        );
      }
      throw error;
    }
    await recordEvent({
      type: 'task.outcome',
      payload: { task_id: id, outcome: 'success' },
    });
  }

  return {
    task,
    result,
    awaitingPoster:
      result.state === 'submitted' && verification.kind === 'counterparty',
  };
}

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('submit <id>')
    .description('Submit the result for a claimed task')
    .option(
      '--file <path>',
      'read the submission from a file in the current directory',
    )
    .option('--text <string>', 'the submission as a string')
    .option(
      '--keep-newline',
      'send a hash answer that ends in a line break as is',
    )
    .option(
      '--allow-outside-cwd',
      'let --file read a file outside the current directory',
    )
    .action(async function (
      this: Command,
      id: string,
      options: SubmitOptions,
    ): Promise<void> {
      if ((options.file === undefined) === (options.text === undefined)) {
        this.error('give exactly one of --file <path> or --text <string>');
      }
      if (!z.uuid().safeParse(id).success) {
        this.error(`task id must be a UUID, got ${id}`);
      }
      const submission =
        options.text ??
        (await readSubmission(this, options.file ?? '', options));
      const session = await openTaskSession(this, deps);
      let done: Submitted;
      try {
        done = await submitAnswer(session, id, submission, {
          keepNewline: options.keepNewline === true,
          // The name sync declares, from the session hook or the adapter
          // (VOU-614).
          modelName: (await declaredModel())?.name ?? null,
        });
      } catch (error) {
        if (error instanceof SubmitRefused) this.error(error.message);
        failOnApiError(this, error);
      }
      // Synced and the goal refreshed while the result prints.
      const settled = afterTaskWork(deps);
      printSubmitted(this, done);
      await settled;
    });
}

// What submit prints, the result as JSON with --json.
function printSubmitted(cmd: Command, done: Submitted): void {
  const { result, task } = done;
  if (wantsJson(cmd)) {
    stdout(
      JSON.stringify({
        id: result.id,
        state: result.state,
        verification: task.verification.kind,
        awaitingPoster: done.awaitingPoster,
      }),
    );
    return;
  }
  printFields([
    ['id', result.id],
    ['state', result.state],
  ]);
  if (done.awaitingPoster) stdout(AWAITING_POSTER);
}

// Task specs come from other agents and an agent may follow what one says.
// A spec that asks for the key file, a token or the key pasted into an
// answer must never get it. The file must pass the rules in file-guard.ts,
// which refuse the SealKeeper home, hidden folders of the user's home, a
// file outside the current directory without --allow-outside-cwd and a
// file too large to send. submitAnswer then refuses any submission that
// contains the key.
async function readSubmission(
  cmd: Command,
  file: string,
  options: SubmitOptions,
): Promise<string> {
  const read = await readGuardedFile(file, {
    maxBytes: MAX_SUBMISSION_BYTES,
    refusing: 'refusing to submit',
    what: 'the answer file',
    allowOutsideCwd: options.allowOutsideCwd === true,
  });
  if ('error' in read) cmd.error(read.error);
  return read.text;
}
