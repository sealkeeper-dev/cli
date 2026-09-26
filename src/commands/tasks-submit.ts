// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import {
  SubmitTaskRequest,
  TaskOutcomeRequest,
  type TaskResponse,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { cli } from '../invocation.js';
import { containsPrivateKey, insideHome } from '../key-guard.js';
import { stdout, wantsJson } from '../output.js';
import { activeRoutineRun, appendRoutine } from '../routine.js';
import {
  defaultTasksDeps,
  failOnApiError,
  openTaskSession,
  printFields,
  recordEvent,
  sha256Hex,
  type TasksDeps,
} from '../tasks.js';

export const AWAITING_POSTER = 'the poster must confirm the outcome';

type SubmitOptions = { file?: string; text?: string };

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('submit <id>')
    .description('Submit the result for a claimed task')
    .option('--file <path>', 'read the submission from a file')
    .option('--text <string>', 'the submission as a string')
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
        options.text ?? (await readSubmission(this, options.file));
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

      // The same checks the server runs, done first so a bad submission is
      // never signed or sent.
      const { verification } = task;
      if (verification.kind === 'hash') {
        const actual = sha256Hex(submission);
        if (actual !== verification.sha256) {
          this.error(
            `submission does not match the expected hash, nothing was sent\n  expected sha256 ${verification.sha256}\n  submission sha256 ${actual}`,
          );
        }
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
          result = await api.submitTask(id, await signer.sign(request.data));
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.code === 'verification_failed'
          ) {
            const reason = error.issues[0]?.code ?? 'unknown';
            this.error(`verification failed: ${reason}. ${error.message}`);
          }
          failOnApiError(this, error);
        }
        await recordEvent({
          type: 'task.submitted',
          payload: { task_id: result.id, task_type: result.taskType },
        });
        if (runId !== null) {
          await appendRoutine({ kind: 'submit', runId, taskId: result.id });
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
          result = await api.postOutcome(id, await signer.sign(outcome));
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
// A spec that asks for the key file, or for the key pasted into an answer,
// must never get it. Files under the SealKeeper home are refused outright,
// and so is any submission that contains the private key.
async function readSubmission(cmd: Command, file: string | undefined) {
  const home = await insideHome(file ?? '');
  if (home !== null) {
    cmd.error(
      `refusing to submit ${file}, it is inside ${home}, which holds this agent's private key`,
    );
  }
  try {
    return await readFile(file ?? '', 'utf8');
  } catch (error) {
    cmd.error(`could not read ${file}: ${(error as Error).message}`);
  }
}

async function refuseKeyMaterial(cmd: Command, submission: string) {
  if (await containsPrivateKey(submission)) {
    cmd.error(
      "refusing to submit, the answer contains this agent's private key",
    );
  }
}
