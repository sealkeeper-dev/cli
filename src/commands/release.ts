// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ReleaseTaskRequest } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { TaskResponse } from '../responses.js';
import {
  defaultTasksDeps,
  NOT_FOUND,
  openTaskSession,
  type TaskSession,
  type TasksDeps,
} from '../tasks.js';

// sealkeeper release <id>. Gives back a claim this agent cannot finish. One
// line either way, and a refusal is the API's message.

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
      // A full task id, as claim and submit check it.
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
        this.error(releaseRefusal(error));
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

// Gives the claim on taskId back, the path release and the routine's run share.
// Throws what the API client throws.
export async function releaseClaim(
  { signer, api }: Pick<TaskSession, 'signer' | 'api'>,
  taskId: string,
): Promise<TaskResponse> {
  return api.releaseTask(
    taskId,
    await signer.sign(
      ReleaseTaskRequest.parse({ taskId, issuedAt: new Date().toISOString() }),
      'task.release',
    ),
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

// One line for a refused release. not_found is an unknown task. Anything else
// is the API's message.
function releaseRefusal(error: ApiError): string {
  return error.code === 'not_found' ? NOT_FOUND : refusal(error);
}
