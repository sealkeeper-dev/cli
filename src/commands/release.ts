// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ReleaseTaskRequest } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { type ApiClient, ApiError } from '../api.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { TaskResponse } from '../responses.js';
import {
  defaultTasksDeps,
  openTaskSession,
  type TaskSession,
  type TasksDeps,
} from '../tasks.js';
import { NOT_FOUND } from './tasks-claim.js';

// sealkeeper release <id>. Gives a claim this agent cannot finish
// back (VOU-572). An open task goes back to the pool, an addressed one
// expires, the release costs no penalty, and it counts in reliability as a
// claim that never verified. This agent cannot claim the task again. One
// line either way, and a refusal is the API's message, which for the cap
// on releases a day says when the next one is allowed.

export const OLD_API =
  'this SealKeeper API cannot release a claim yet, the claim is left as it is';

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('release')
    .description(
      'Give back a claimed task this agent cannot finish, at no penalty',
    )
    .argument('<id>', 'the task id')
    .action(async function (this: Command, id: string): Promise<void> {
      // A full task id, as tasks claim and submit check it.
      const taskId = id.trim().toLowerCase();
      if (!z.uuid().safeParse(taskId).success) {
        this.error(`task id must be a UUID, got ${id}`);
      }
      const { signer, api } = await openTaskSession(this, deps);

      let task: TaskResponse;
      try {
        task = await releaseClaim({ signer, api }, taskId);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        this.error(await releaseRefusal(api, taskId, error));
      }

      if (wantsJson(this)) {
        stdout(
          JSON.stringify({ id: task.id, state: task.state, released: true }),
        );
        return;
      }
      stdout(releasedLine(task, signer.agentId));
    });
}

// Gives the claim on taskId back, the path release and the routine's run
// share (VOU-599). Throws what the API client throws.
export async function releaseClaim(
  { signer, api }: Pick<TaskSession, 'signer' | 'api'>,
  taskId: string,
): Promise<TaskResponse> {
  return api.releaseTask(
    taskId,
    await signer.sign(ReleaseTaskRequest.parse({ taskId })),
  );
}

// The one line after a release. The API answers a retry with the task as
// it is now, which another agent may have claimed since.
export function releasedLine(task: TaskResponse, agentId: string): string {
  if (task.state === 'expired' && task.claimantAgentId === agentId) {
    return `Released ${task.id}. It was addressed to this agent, so it has expired. This agent cannot claim it again.`;
  }
  return `Released ${task.id}. It is back for other agents to claim, and this agent cannot claim it again.`;
}

// One line for a refused release. A 404 is either an unknown task or an
// API from before releases, which has no such route, so the task is read
// to tell them apart. A task that reads means the route is missing, and
// the claim stands. Anything else is the API's message.
async function releaseRefusal(
  api: ApiClient,
  taskId: string,
  error: ApiError,
): Promise<string> {
  if (error.status !== 404) return refusal(error);
  try {
    await api.getTask(taskId);
    return OLD_API;
  } catch {
    return NOT_FOUND;
  }
}
