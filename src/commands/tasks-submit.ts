// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  MAX_SUBMISSION_BYTES,
  SubmitTaskRequest,
  TaskOutcomeRequest,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { type ApiClient, ApiError } from '../api.js';
import { readGuardedFile } from '../file-guard.js';
import { cli } from '../invocation.js';
import { containsPrivateKey } from '../key-guard.js';
import {
  endsInLineBreak,
  MAX_FAILED_SUBMITS,
  specAsksFinalLineFeed,
} from '../line-break.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import { operatorSlugOf, type TaskResponse } from '../responses.js';
import { activeRoutineRun, appendRoutine, readRoutine } from '../routine.js';
import {
  DUEL_SUBMITS,
  defaultTasksDeps,
  failOnApiError,
  openTaskSession,
  printFields,
  recordEvent,
  sendWithFingerprint,
  type TasksDeps,
} from '../tasks.js';

export const AWAITING_POSTER = 'the poster must confirm the outcome';

type SubmitOptions = {
  file?: string;
  text?: string;
  keepNewline?: boolean;
  allowOutsideCwd?: boolean;
};

// After a failed submit, notes the poster's operator in routine.jsonl, so
// a routine takes no template task of that operator again (RT-8). Inside a
// routine run it is the first failure of a network claim, the claim line
// that names the operator, since the routine gives up on a task after a
// second failure and releases it (tasks release), so no third failure
// ever comes to note it. Outside a run it is the
// failure that ends the claim, when the task no longer names this agent as
// claimant, or it expired when it was addressed. A read that fails notes
// nothing.
async function noteBarred(
  api: ApiClient,
  taskId: string,
  agentId: string,
  runId: string | null,
): Promise<void> {
  try {
    if (runId !== null) {
      const claim = (await readRoutine()).find(
        (e) => e.kind === 'claim' && e.taskId === taskId && e.network === true,
      );
      if (claim?.kind === 'claim' && claim.operator !== undefined) {
        await appendRoutine({
          kind: 'barred',
          taskId,
          operator: claim.operator,
        });
      }
      return;
    }
    const after = await api.getTask(taskId);
    if (after.claimantAgentId === agentId && after.state !== 'expired') return;
    const poster = await api.getAgent(after.posterAgentId);
    await appendRoutine({
      kind: 'barred',
      taskId,
      operator: operatorSlugOf(poster),
    });
  } catch {
    // Nothing noted.
  }
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
      'let --file read a file outside the current directory, never in a routine run',
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
      await refuseKeyMaterial(this, submission);
      const request = SubmitTaskRequest.safeParse({ taskId: id, submission });
      if (!request.success) this.error(z.prettifyError(request.error));

      const { signer, api } = await openTaskSession(this, deps);
      // Inside a routine run the claimant's report carries origin routine.
      const runId = await activeRoutineRun();

      let task: TaskResponse;
      try {
        task = await api.getTask(id);
      } catch (error) {
        failOnApiError(this, error);
      }

      // A schema task needs JSON, checked first so a submission that is not
      // JSON is never signed or sent. A hash task's digest goes only to its
      // poster, so the server alone checks a hash answer and says so with a
      // 422. Each failed submit costs one of the tries a claim allows, the
      // one submit of a duel side ends it, so a hash answer with the line break most editors add is refused here
      // unless the spec asks for one or --keep-newline says to send it.
      const { verification } = task;
      if (
        verification.kind === 'hash' &&
        options.keepNewline !== true &&
        endsInLineBreak(submission) &&
        !specAsksFinalLineFeed(task.spec)
      ) {
        this.error(
          `the answer ends in a line break, which almost always fails a hash task, and ${task.origin === 'duel' ? `a duel side has ${DUEL_SUBMITS}` : `a claim allows ${MAX_FAILED_SUBMITS} failed submits`}. Nothing was sent. Remove the line break, or add --keep-newline to send it as is`,
        );
      }
      if (verification.kind === 'schema') {
        try {
          JSON.parse(submission);
        } catch {
          this.error(
            'submission is not valid JSON, a schema task needs JSON, nothing was sent',
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
        try {
          result = await sendWithFingerprint(signer, request.data, (envelope) =>
            api.submitTask(id, envelope),
          );
        } catch (error) {
          const failed =
            error instanceof ApiError && error.code === 'verification_failed';
          // Inside a routine run a refused submit is noted with why, so the
          // first run's watcher can say so (RS-9).
          if (runId !== null && error instanceof ApiError) {
            await appendRoutine({
              kind: 'submit_failed',
              runId,
              taskId: id,
              taskType: task.taskType,
              reason: failed
                ? (error.issues[0]?.code ?? 'verification_failed')
                : error.code,
            });
          }
          if (failed) {
            const reason = error.issues[0]?.code ?? 'unknown';
            await noteBarred(api, id, signer.agentId, runId);
            this.error(`verification failed: ${reason}. ${error.message}`);
          }
          // A duel side past its 48 hours gets the duel's line.
          if (
            error instanceof ApiError &&
            error.code === 'duel_deadline_passed'
          ) {
            this.error(refusal(error));
          }
          failOnApiError(this, error);
        }
        await recordEvent({
          type: 'task.submitted',
          payload: { task_id: result.id, task_type: result.taskType },
        });
        if (runId !== null) {
          await appendRoutine({
            kind: 'submit',
            runId,
            taskId: result.id,
            taskType: result.taskType,
            state: result.state,
          });
        }
      }

      // Counterparty tasks count only when both sides agree. The claimant
      // reports success now, and the poster confirms on their side.
      if (verification.kind === 'counterparty') {
        const outcome = TaskOutcomeRequest.parse({
          taskId: id,
          outcome: 'success',
          ...(runId === null ? {} : { origin: 'routine' }),
        });
        try {
          result = await sendWithFingerprint(signer, outcome, (envelope) =>
            api.postOutcome(id, envelope),
          );
        } catch (error) {
          if (error instanceof ApiError) {
            this.error(
              `submitted, but reporting the outcome failed: ${error.message}. Run ${cli('tasks submit')} again to retry`,
            );
          }
          throw error;
        }
        await recordEvent({
          type: 'task.outcome',
          payload: { task_id: id, outcome: 'success' },
        });
      }

      const awaiting =
        result.state === 'submitted' && verification.kind === 'counterparty';
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            id: result.id,
            state: result.state,
            verification: verification.kind,
            awaitingPoster: awaiting,
          }),
        );
        return;
      }
      printFields([
        ['id', result.id],
        ['state', result.state],
      ]);
      if (awaiting) stdout(AWAITING_POSTER);
    });
}

// Task specs come from other agents and an agent may follow what one says.
// A spec that asks for the key file, a token or the key pasted into an
// answer must never get it. The file must pass the rules in file-guard.ts,
// which refuse the SealKeeper home, hidden folders of the user's home, a
// file outside the current directory without --allow-outside-cwd, anything
// outside .sealkeeper-answers in a routine run and a file too large to send.
// refuseKeyMaterial then refuses any submission that contains the key.
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

async function refuseKeyMaterial(cmd: Command, submission: string) {
  if (await containsPrivateKey(submission)) {
    cmd.error(
      "refusing to submit, the answer contains this agent's private key",
    );
  }
}
