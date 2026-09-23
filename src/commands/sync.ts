// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { createApiClient, resolveApiUrl } from '../api.js';
import { type Config, ConfigError, readConfig } from '../config.js';
import { type Sleep, sleep } from '../github-device.js';
import { KeyError } from '../identity.js';
import { CursorError } from '../log.js';
import { stdout, wantsJson } from '../output.js';
import { SyncError, syncEvents } from '../sync.js';
import { NOT_INITIALISED } from './whoami.js';

// fetch and sleep are injectable so tests can stand in for the API and skip
// real waits. emit and sync share them.
export type SyncDeps = {
  fetch: typeof fetch;
  sleep: Sleep;
};

export const defaultSyncDeps: SyncDeps = {
  fetch: (...args) => fetch(...args),
  sleep,
};

export function register(
  parent: Command,
  deps: SyncDeps = defaultSyncDeps,
): Command {
  return parent
    .command('sync')
    .description('Sign pending events and send them to the API')
    .action(async function (this: Command): Promise<void> {
      const config = await loadConfig(this);
      if (config === null) this.error(NOT_INITIALISED);

      const api = createApiClient({
        apiUrl: resolveApiUrl({ config: config.apiUrl }),
        fetch: deps.fetch,
      });
      let result: Awaited<ReturnType<typeof syncEvents>>;
      try {
        result = await syncEvents({ api, sleep: deps.sleep });
      } catch (error) {
        if (
          error instanceof SyncError ||
          error instanceof KeyError ||
          error instanceof CursorError
        ) {
          this.error(error.message);
        }
        throw error;
      }

      if (wantsJson(this)) {
        stdout(JSON.stringify(result));
        return;
      }
      const skipped = result.skipped > 0 ? `, skipped ${result.skipped}` : '';
      stdout(
        `accepted ${result.accepted}, duplicates ${result.duplicates}${skipped}`,
      );
    });
}

// The config, or null when not initialised. A broken config ends the command
// with the reason.
export async function loadConfig(cmd: Command): Promise<Config | null> {
  try {
    return await readConfig();
  } catch (error) {
    if (error instanceof ConfigError) cmd.error(error.message);
    throw error;
  }
}
