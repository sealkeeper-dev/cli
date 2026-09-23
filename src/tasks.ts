// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TaskResponse } from '@vouched/schema';
import type { Command } from 'commander';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from './api.js';
import { loadConfig } from './commands/sync.js';
import { NOT_INITIALISED } from './commands/whoami.js';
import type { Config } from './config.js';
import { type EmitInput, emit } from './emit.js';
import { KeyError, loadSigner, type Signer } from './identity.js';
import { stderr, stdout } from './output.js';

// What tasks pull, submit and post share. fetch is injectable so tests can
// stand in for the API.
export type TasksDeps = {
  fetch: typeof fetch;
};

export const defaultTasksDeps: TasksDeps = {
  fetch: (...args) => fetch(...args),
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
  const config = await loadConfig(cmd);
  if (config === null) cmd.error(NOT_INITIALISED);
  let signer: Signer;
  try {
    signer = await loadSigner();
  } catch (error) {
    if (error instanceof KeyError) cmd.error(error.message);
    throw error;
  }
  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
  });
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

// A JSON argument given inline or as @path to a file.
export async function readJsonArg(
  cmd: Command,
  value: string,
  label: string,
): Promise<unknown> {
  let text = value;
  if (value.startsWith('@')) {
    const file = value.slice(1);
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      cmd.error(
        `could not read ${label} file ${file}: ${(error as Error).message}`,
      );
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    cmd.error(`${label} is not valid JSON`);
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Lowercase hex sha256 of the UTF-8 bytes of the text, the same digest the
// API checks a hash task against.
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Aligned key and value lines for human output.
export function printFields(fields: [string, string][]): void {
  const width = Math.max(...fields.map(([key]) => key.length));
  for (const [key, value] of fields) stdout(`${key.padEnd(width)}  ${value}`);
}

export function taskSummary(task: TaskResponse) {
  return {
    id: task.id,
    taskType: task.taskType,
    state: task.state,
    verification: task.verification,
    expiresAt: task.expiresAt,
    spec: task.spec,
  };
}
