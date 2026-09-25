// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  PostTaskRequest,
  TASK_MAX_TTL_DAYS,
  type TaskResponse,
  type VerificationSpec,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { stdout, wantsJson } from '../output.js';
import {
  defaultTasksDeps,
  failOnApiError,
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
};

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

      // The id is ours, so a retried post returns the same task.
      const request = PostTaskRequest.safeParse({
        taskId: randomUUID(),
        taskType: options.type,
        spec,
        verification,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      if (!request.success) this.error(z.prettifyError(request.error));

      const { signer, api } = await openTaskSession(this, deps);
      let task: TaskResponse;
      try {
        task = await api.postTask(await signer.sign(request.data));
      } catch (error) {
        failOnApiError(this, error);
      }

      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            id: task.id,
            state: task.state,
            expiresAt: task.expiresAt,
          }),
        );
        return;
      }
      printFields([
        ['id', task.id],
        ['state', task.state],
        ['expires', task.expiresAt],
      ]);
    });
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
