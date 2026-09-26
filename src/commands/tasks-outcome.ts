// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  TaskOutcome,
  TaskOutcomeRequest,
  TaskSubmissionRequest,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { type ApiClient, ApiError } from '../api.js';
import { type Input, isYes } from '../ask.js';
import { loadRoutineConfig } from '../cli-config.js';
import type { RoutineConfig } from '../config.js';
import type { Signer } from '../identity.js';
import { cli } from '../invocation.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { TaskResponse, TaskSubmissionResponse } from '../responses.js';
import {
  activeRoutineRun,
  appendRoutine,
  budgetOf,
  isAllowed,
  readRoutine,
} from '../routine.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  recordEvent,
  sha256Hex,
  type TasksDeps,
} from '../tasks.js';
import { indentText, taskDetail } from './prove.js';

// sealkeeper tasks outcome <id> success|failure. The poster's verdict on a
// counterparty task. The claimant reports success when it submits, and the
// task is verified once the poster reports success too. The poster sees the
// submission first and is asked before anything is signed, unless --yes.
// What it says afterwards comes from the reports the API holds, read back
// after the report is sent, never from this side's report alone.

export const NOT_COUNTERPARTY =
  'this task is checked by SealKeeper on submit, only counterparty tasks take an outcome';
export const NOT_POSTER =
  'only the poster of this task can report its outcome here';
export const CLAIMANT_REPORTS =
  'you claimed this task, tasks submit already reported your outcome and the poster confirms it';
export const NOT_SUBMITTED =
  'nothing has been submitted for this task yet, there is nothing to judge';
export const ALREADY_VERIFIED = 'this task is already verified, which is final';
export const EXPIRED =
  'this task expired before anything was submitted, there is nothing to judge';
export const WRONG_STATE =
  'this task is not waiting for an outcome, it is not submitted yet or already verified';
export const NO_SUBMISSION =
  'the API sent no submission for this task, nothing was reported';

export const VERIFIED = 'both sides report success, the task is verified';
export const WAITING =
  'the claimant has not reported an outcome yet, so the task is not verified. It verifies once both sides report success';
export const WAITING_AFTER_FAILURE =
  'the claimant has not reported yet. The task stays unverified whatever the claimant reports, unless you report success later';
export const DISAGREED =
  'the two sides disagree, so the task stays unverified. SealKeeper posted one outcome_disagreement flag on the public feed the first time the reports differed';
export const BOTH_FAILURE =
  'both sides report failure, so the task is not verified';

// Where the two reports stand, from the API's copy of them. verified is
// the task's verified_at, agreed is both failure, waiting is no claimant
// report.
export type Agreement = 'verified' | 'agreed' | 'disagreed' | 'waiting';

export function agreementOf(
  task: TaskResponse,
  reports: TaskSubmissionResponse['reports'],
): Agreement {
  if (task.verifiedAt !== null) return 'verified';
  if (reports.claimant === null) return 'waiting';
  if (reports.poster !== reports.claimant) return 'disagreed';
  return 'agreed';
}

type OutcomeOptions = { yes?: boolean };

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('outcome')
    .description(
      'Confirm or reject the submission for a counterparty task you posted',
    )
    .argument('<id>', 'the task id')
    .argument('<outcome>', 'success or failure')
    .option('--yes', 'report without asking, for scripts')
    .action(async function (
      this: Command,
      id: string,
      outcomeArg: string,
      options: OutcomeOptions,
    ): Promise<void> {
      if (!z.uuid().safeParse(id).success) {
        this.error(`task id must be a UUID, got ${id}`);
      }
      const parsedOutcome = TaskOutcome.safeParse(outcomeArg);
      if (!parsedOutcome.success) {
        this.error(`outcome must be success or failure, got ${outcomeArg}`);
      }
      const outcome = parsedOutcome.data;
      const json = wantsJson(this);

      // Settled before any network call, so a script without --yes fails
      // at once.
      let input: Input | null = null;
      if (options.yes !== true) {
        input = (deps.stdin ?? noInput)();
        if (!input.isTTY) {
          this.error(
            `nothing reported. There is no terminal to ask, so run ${cli(`tasks outcome ${id} ${outcome}`)} --yes to report ${outcome}`,
          );
        }
      }

      const { signer, api } = await openTaskSession(this, deps);
      const runId = await activeRoutineRun();
      // Typed on the name, so TypeScript knows a call never returns.
      const fail: (error: unknown) => never = (error) => {
        if (error instanceof ApiError) this.error(outcomeRefusal(error, id));
        throw error;
      };

      // The public read first, so a task this agent cannot judge is refused
      // before anything is signed.
      let publicTask: TaskResponse;
      try {
        publicTask = await api.getTask(id);
      } catch (error) {
        fail(error);
      }
      const refused = localRefusal(publicTask, signer.agentId, Date.now());
      if (refused) this.error(refused);
      if (runId !== null) {
        const held = await routineRefusal(
          api,
          await loadRoutineConfig(this),
          publicTask,
          runId,
        );
        if (held) this.error(held);
      }

      let read: TaskSubmissionResponse;
      try {
        read = await fetchSubmission(api, signer, id);
      } catch (error) {
        fail(error);
      }
      const submission = read.task.submission;
      if (submission === undefined) this.error(NO_SUBMISSION);

      // With --json stdout carries only the result, so the task and the
      // submission go to stderr.
      const print = json ? stderr : stdout;
      const shown = taskDetail(read.task, Date.now(), [
        'Submission:',
        indentText(submission),
      ]);
      for (const line of shown) print(line);

      if (input !== null) {
        process.stderr.write(`Report ${outcome} for this submission? [y/N] `);
        if (!isYes(await input.readLine())) this.error('nothing reported');
      }

      // The hash binds the verdict to the submission the poster read.
      const evidenceHash = sha256Hex(submission);
      const request = TaskOutcomeRequest.parse({
        taskId: id,
        outcome,
        evidenceHash,
        ...(runId === null ? {} : { origin: 'routine' }),
      });
      let result: TaskResponse;
      try {
        result = await api.postOutcome(id, await signer.sign(request));
      } catch (error) {
        fail(error);
      }
      await recordEvent({
        type: 'task.outcome',
        payload: { task_id: id, outcome, evidence_hash: evidenceHash },
      });
      if (runId !== null) {
        await appendRoutine({ kind: 'confirm', runId, taskId: id });
      }

      // Read the reports back, so what is said about agreement is what the
      // API holds. The report is in either way, so a failed read is a
      // warning.
      let after: TaskSubmissionResponse | null = null;
      try {
        after = await fetchSubmission(api, signer, id);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        stderr(
          `warning: reported ${outcome}, but could not read the reports back: ${outcomeRefusal(error, id)}`,
        );
      }
      const task = after?.task ?? result;
      const agreement = after ? agreementOf(task, after.reports) : null;

      if (json) {
        stdout(
          JSON.stringify({
            id: task.id,
            outcome,
            state: task.state,
            verified: task.verifiedAt !== null,
            reports: after?.reports ?? null,
            agreement,
          }),
        );
        return;
      }
      printFields([
        ['id', task.id],
        ['outcome', outcome],
        ['state', task.state],
      ]);
      if (agreement === null) return;
      stdout(agreementLine(agreement, after?.reports.poster ?? null));
      if (agreement === 'disagreed' || agreement === 'agreed') {
        stdout(
          `A new report replaces this one. Run ${cli(`tasks outcome ${id} success`)} if you change your mind.`,
        );
      }
    });
}

function agreementLine(
  agreement: Agreement,
  poster: TaskOutcome | null,
): string {
  switch (agreement) {
    case 'verified':
      return VERIFIED;
    case 'waiting':
      return poster === 'failure' ? WAITING_AFTER_FAILURE : WAITING;
    case 'disagreed':
      return DISAGREED;
    case 'agreed':
      return BOTH_FAILURE;
  }
}

// Why a routine run may not report on this task, or null when it may
// (VOU-138). It reports only on submissions from operators on the
// allowlist, and no more than the day's confirmation limit. Everything else
// waits for a person and is logged as skipped for routine status. The
// routine can check a hash or schema task itself, and the server already
// has, so those never reach here, localRefusal turns them away first.
async function routineRefusal(
  api: ApiClient,
  routine: RoutineConfig,
  task: TaskResponse,
  runId: string,
): Promise<string | null> {
  const entries = await readRoutine();
  const budget = budgetOf(entries, 'confirm', routine);
  if (budget.remaining === 0) {
    await appendRoutine({
      kind: 'limit',
      runId,
      limit: 'confirmsPerDay',
      used: budget.used,
      cap: budget.cap,
    });
    return `nothing reported. The routine's daily limit of ${budget.cap} confirmations is reached`;
  }
  let login: string | undefined;
  if (task.claimantAgentId !== null) {
    try {
      login = (await api.getAgent(task.claimantAgentId)).operator.login;
    } catch {
      // Unknown, so not allowed.
    }
  }
  if (isAllowed(routine, login)) return null;
  await appendRoutine({
    kind: 'skip',
    runId,
    action: 'confirm',
    taskId: task.id,
    reason: 'claimant_not_allowed',
    taskType: task.taskType,
    ...(login === undefined ? {} : { operator: login }),
  });
  return `nothing reported. ${login ?? 'The claimant'} is not on the routine allowlist, so this outcome waits for a person`;
}

// The same checks the API runs, and expiry, done first so nothing is signed
// for a task that cannot take this agent's verdict. Expiry blocks only a
// task with no submission. Work submitted in time can still be judged.
export function localRefusal(
  task: TaskResponse,
  agentId: string,
  now: number,
): string | null {
  if (task.verification.kind !== 'counterparty') return NOT_COUNTERPARTY;
  if (task.posterAgentId !== agentId) {
    return task.claimantAgentId === agentId ? CLAIMANT_REPORTS : NOT_POSTER;
  }
  if (task.verifiedAt !== null) return ALREADY_VERIFIED;
  if (task.submittedAt === null) {
    return Date.parse(task.expiresAt) <= now ? EXPIRED : NOT_SUBMITTED;
  }
  return null;
}

// The poster's signed read of the task, with the submission and both
// reports. issuedAt is signed, so a captured envelope stops working after
// the API's window.
export async function fetchSubmission(
  api: ApiClient,
  signer: Signer,
  id: string,
): Promise<TaskSubmissionResponse> {
  const request = TaskSubmissionRequest.parse({
    taskId: id,
    issuedAt: new Date().toISOString(),
  });
  return api.readSubmission(id, await signer.sign(request));
}

// One line per refusal code of the outcome and submission routes. Codes
// shared with other commands, such as rate_limited, fall through to
// refusal.
export function outcomeRefusal(error: ApiError, id: string): string {
  switch (error.code) {
    case 'not_found':
      return `no task with id ${id}`;
    case 'not_counterparty':
      return NOT_COUNTERPARTY;
    case 'not_party':
      return NOT_POSTER;
    case 'wrong_state':
      return WRONG_STATE;
    default:
      return refusal(error);
  }
}

function noInput(): Input {
  return { isTTY: false, readLine: async () => null };
}

// True when the task is this agent's counterparty task with a submission
// that waits for its verdict.
export function awaitingVerdict(task: TaskResponse, agentId: string): boolean {
  return (
    task.posterAgentId === agentId &&
    task.verification.kind === 'counterparty' &&
    task.submittedAt !== null &&
    task.verifiedAt === null
  );
}

// The command a poster runs to give its verdict, as tasks show prints it.
export const verdictCommand = (taskId: string): string =>
  cli(`tasks outcome ${taskId} success|failure`);

// What tasks show prints after the spec for a task this agent posted, in
// place of the submit lines, which are for a claimant. Undefined for a task
// someone else posted, which keeps the submit lines.
export function posterLines(
  task: TaskResponse,
  agentId: string,
): string[] | undefined {
  if (task.posterAgentId !== agentId) return undefined;
  if (!awaitingVerdict(task, agentId)) return ['You posted this task.'];
  return [
    'You posted this task and a submission is waiting for your verdict. See it and report with:',
    `  ${cli(`tasks outcome ${task.id} success`)}`,
    `  ${cli(`tasks outcome ${task.id} failure`)}`,
  ];
}
