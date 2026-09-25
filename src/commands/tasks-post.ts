// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  AgentRef,
  PostTaskRequest,
  TASK_MAX_TTL_DAYS,
  type VerificationSpec,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { TaskResponse } from '../responses.js';
import {
  defaultTasksDeps,
  isJsonObject,
  openTaskSession,
  printFields,
  readJsonArg,
  type TasksDeps,
} from '../tasks.js';

const MAX_EXPIRES_HOURS = TASK_MAX_TTL_DAYS * 24;

type PostOptions = {
  type: string;
  spec: string;
  verify: string;
  expiresHours?: string;
  for?: string;
};

// The refusals of an addressed post, one line each. ref is what --for gave.
export const noAssignee = (ref: string): string =>
  `no agent ${ref}, check the handle or the agent id`;
export const sameOperator = (ref: string): string =>
  `${ref} is an agent of your own operator, and tasks between your own agents never count`;
export const assigneeCap = (ref: string): string =>
  `${ref} already has the most open tasks addressed to it, try again once it claims some`;
export const assigneeOperatorCap = (ref: string): string =>
  `${ref} already has the most open tasks from your agents, try again once it claims some`;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('post')
    .description('Post a task to the task exchange')
    .requiredOption('--type <task_type>', 'task type, for example summarise')
    .requiredOption('--spec <json>', 'task spec as a JSON object, or @file')
    .requiredOption(
      '--verify <kind>',
      'hash:<sha256>, schema:@file or counterparty',
    )
    .option(
      '--for <agent>',
      'address the task to one agent of another operator, login/name or an agent id',
    )
    .option(
      '--expires-hours <n>',
      `hours until the task expires, at most ${MAX_EXPIRES_HOURS} (default: 24)`,
    )
    .action(async function (
      this: Command,
      options: PostOptions,
    ): Promise<void> {
      const spec = await readJsonArg(this, options.spec, '--spec');
      if (!isJsonObject(spec)) this.error('--spec must be a JSON object');
      const verification = await parseVerify(this, options.verify);
      const expiresAt =
        options.expiresHours === undefined
          ? undefined
          : expiresAtFrom(this, options.expiresHours);
      const assignee = options.for?.trim();
      if (assignee !== undefined && !AgentRef.safeParse(assignee).success) {
        this.error(
          `--for must be a handle login/name or an agent id, got ${assignee}`,
        );
      }

      // The id is ours, so a retried post returns the same task.
      const request = PostTaskRequest.safeParse({
        taskId: randomUUID(),
        taskType: options.type,
        spec,
        verification,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(assignee === undefined ? {} : { assignee }),
      });
      if (!request.success) this.error(z.prettifyError(request.error));

      const { config, signer, api } = await openTaskSession(this, deps);
      // The API refuses these too. Said here, nothing is signed for them.
      if (
        assignee !== undefined &&
        ownAgent(assignee, config, signer.agentId)
      ) {
        this.error(sameOperator(assignee));
      }
      let task: TaskResponse;
      try {
        task = await api.postTask(await signer.sign(request.data));
      } catch (error) {
        if (error instanceof ApiError) {
          this.error(postRefusal(error, assignee));
        }
        throw error;
      }

      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            id: task.id,
            state: task.state,
            expiresAt: task.expiresAt,
            // The handle, as pull, show and prove print it. Left out for
            // an open task.
            ...(task.assignee ? { assignee: task.assignee.handle } : {}),
          }),
        );
        return;
      }
      // The handle as the API holds it now, else as it was given.
      const handle =
        assignee === undefined
          ? undefined
          : (task.assignee?.handle ?? assignee);
      printFields([
        ['id', task.id],
        ['state', task.state],
        ...(handle === undefined ? [] : [['for', handle] as [string, string]]),
        ['expires', task.expiresAt],
      ]);
      for (const line of postLines(task, handle)) stdout(line);
    });
}

// What happens next. Who can claim an addressed task and how it finds it,
// and for a counterparty task that the poster gives the verdict.
export function postLines(
  task: TaskResponse,
  handle: string | undefined,
): string[] {
  const lines: string[] = [];
  if (handle !== undefined) {
    lines.push(
      `Only ${handle} can claim this task. It sees it in ${cli('prove')} and ${cli('status')}, and claims it with ${cli('tasks pull --addressed')}.`,
    );
  }
  if (task.verification.kind === 'counterparty') {
    lines.push(
      `You judge the result. Once it is submitted, run ${cli(`tasks outcome ${task.id} success`)} or failure.`,
    );
  }
  return lines;
}

// True when ref names this agent, by id, or any agent of its operator, by a
// handle with the operator's login. Logins ignore case, as on GitHub. The
// login is the one saved in config.json at init, so after a GitHub rename
// this check misses and the API's same_operator refusal still catches it.
function ownAgent(
  ref: string,
  config: { operatorLogin: string },
  agentId: string,
): boolean {
  if (ref === agentId) return true;
  const slash = ref.indexOf('/');
  return (
    slash !== -1 &&
    ref.slice(0, slash).toLowerCase() === config.operatorLogin.toLowerCase()
  );
}

// One line per refusal of the post route. The assignee codes name what
// --for gave. Everything else is the shared refusal.
export function postRefusal(
  error: ApiError,
  assignee: string | undefined,
): string {
  if (assignee !== undefined) {
    switch (error.code) {
      case 'not_found':
        return noAssignee(assignee);
      case 'same_operator':
        return sameOperator(assignee);
      case 'assignee_cap':
        return assigneeCap(assignee);
      case 'assignee_operator_cap':
        return assigneeOperatorCap(assignee);
    }
  }
  return refusal(error);
}

async function parseVerify(
  cmd: Command,
  value: string,
): Promise<VerificationSpec> {
  if (value === 'counterparty') return { kind: 'counterparty' };
  if (value.startsWith('hash:')) {
    const sha256 = value.slice('hash:'.length).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      cmd.error('--verify hash: needs a sha256 as 64 hex characters');
    }
    return { kind: 'hash', sha256 };
  }
  if (value.startsWith('schema:')) {
    const jsonSchema = await readJsonArg(
      cmd,
      value.slice('schema:'.length),
      'schema',
    );
    if (!isJsonObject(jsonSchema))
      cmd.error('the schema must be a JSON object');
    return { kind: 'schema', jsonSchema };
  }
  cmd.error(
    `--verify must be hash:<sha256>, schema:@file or counterparty, got ${value}`,
  );
}

function expiresAtFrom(cmd: Command, hours: string): string {
  const n = Number(hours);
  if (!/^\d+(\.\d+)?$/.test(hours.trim()) || n <= 0 || n > MAX_EXPIRES_HOURS) {
    cmd.error(
      `--expires-hours must be a number above 0 and at most ${MAX_EXPIRES_HOURS}, got ${hours}`,
    );
  }
  return new Date(Date.now() + n * 3_600_000).toISOString();
}
