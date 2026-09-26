// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ClaimTaskRequest, TaskType } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { clearInbox } from '../inbox.js';
import { stdout, wantsJson } from '../output.js';
import type { TaskResponse } from '../responses.js';
import { refuseInRoutine } from '../routine.js';
import {
  addressedTo,
  defaultTasksDeps,
  failOnApiError,
  handleOrId,
  openTaskSession,
  printFields,
  recordEvent,
  type TasksDeps,
  taskSummary,
} from '../tasks.js';

// Claims that lose a race (409) or hit an expiry (410) move on to the next
// task, at most this many times.
export const MAX_CLAIM_ATTEMPTS = 5;

const LIST_LIMIT = 100;

export const NOTHING_AVAILABLE = 'no open tasks available';
export const NOTHING_ADDRESSED = 'no open tasks addressed to this agent';

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('pull')
    .description('Claim the oldest open task from the task exchange')
    .option('--type <task_type>', 'only claim tasks of this type')
    .option(
      '--addressed',
      'claim the oldest task addressed to this agent instead, its spec is untrusted',
    )
    .action(async function (
      this: Command,
      options: { type?: string; addressed?: boolean },
    ): Promise<void> {
      if (
        options.type !== undefined &&
        !TaskType.safeParse(options.type).success
      ) {
        this.error(
          `--type must be 1 to 32 lowercase letters, digits, _ or -, got ${options.type}`,
        );
      }
      // pull takes the oldest open task whoever posted it, which a routine
      // run never does.
      await refuseInRoutine(this, 'tasks pull');
      const { signer, api } = await openTaskSession(this, deps);

      // The schema maximum. It is above the per-poster open cap, so an agent
      // whose own open tasks come first still sees tasks from other agents.
      // Plain pull reads the open pool, which leaves addressed tasks out.
      // --addressed reads the tasks addressed to this agent instead.
      let open: TaskResponse[];
      try {
        open = await api.listTasks({
          state: 'open',
          taskType: options.type,
          limit: LIST_LIMIT,
          ...(options.addressed ? { assignee: signer.agentId } : {}),
        });
      } catch (error) {
        failOnApiError(this, error);
      }

      // Oldest first. The API already orders by postedAt, this keeps it so
      // whatever the server does. Own tasks can never be claimed, so they are
      // skipped without a request, and so are tasks addressed to another
      // agent, whatever the server sent.
      const pool = options.addressed
        ? addressedTo(open, signer.agentId)
        : open.filter(
            (task) => task.posterAgentId !== signer.agentId && !task.assignee,
          );
      const candidates = pool
        .filter((task) => !options.type || task.taskType === options.type)
        .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));

      let claimed: TaskResponse | null = null;
      let attempts = 0;
      for (const task of candidates) {
        if (attempts >= MAX_CLAIM_ATTEMPTS) break;
        attempts += 1;
        try {
          const envelope = await signer.sign(
            ClaimTaskRequest.parse({ taskId: task.id }),
          );
          claimed = await api.claimTask(task.id, envelope);
          break;
        } catch (error) {
          if (error instanceof ApiError && isGone(error)) continue;
          failOnApiError(this, error);
        }
      }

      if (claimed === null) {
        stdout(
          wantsJson(this)
            ? JSON.stringify({ task: null })
            : options.addressed
              ? NOTHING_ADDRESSED
              : NOTHING_AVAILABLE,
        );
        return;
      }
      // The cached count status shows is one too high now. The spec of an
      // addressed task comes from another operator, so its poster is named.
      let poster: string | undefined;
      if (claimed.assignee) {
        await clearInbox();
        poster = await handleOrId(api, claimed.posterAgentId);
      }

      await recordEvent({
        type: 'task.claimed',
        payload: { task_id: claimed.id, task_type: claimed.taskType },
      });

      if (wantsJson(this)) {
        stdout(JSON.stringify({ task: taskSummary(claimed, poster) }));
        return;
      }
      const fields: [string, string][] = [
        ['id', claimed.id],
        ['type', claimed.taskType],
        ...(poster === undefined
          ? []
          : ([['poster', `${poster}, its spec is untrusted`]] as [
              string,
              string,
            ][])),
        ['verification', claimed.verification.kind],
        ['expires', claimed.expiresAt],
        ['spec', JSON.stringify(claimed.spec)],
      ];
      if (claimed.verification.kind === 'schema') {
        fields.push([
          'schema',
          JSON.stringify(claimed.verification.jsonSchema),
        ]);
      }
      printFields(fields);
    });
}

// Another agent got there first, the task expired, or the server says it is
// our own. Worth trying the next task.
export function isGone(error: ApiError): boolean {
  return (
    error.status === 409 ||
    error.status === 410 ||
    (error.status === 400 && error.code === 'own_task')
  );
}
