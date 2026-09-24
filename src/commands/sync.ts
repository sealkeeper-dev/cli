// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { createApiClient, resolveApiUrl } from '../api.js';
import { type Input, isYes, streamInput } from '../ask.js';
import {
  type Config,
  ConfigError,
  readConfig,
  writeConfig,
} from '../config.js';
import { type Sleep, sleep } from '../github-device.js';
import { KeyError } from '../identity.js';
import { CursorError, type LogPosition } from '../log.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { type Preview, previewLines, readPreview } from '../preview.js';
import { SyncError, syncEvents } from '../sync.js';
import { NOT_INITIALISED } from './whoami.js';

// fetch and sleep are injectable so tests can stand in for the API and skip
// real waits. emit and sync share them. stdin is where sync reads the answer
// to its first sync question, and is only touched when it asks.
export type SyncDeps = {
  fetch: typeof fetch;
  sleep: Sleep;
  stdin?: () => Input;
};

export const defaultSyncDeps: SyncDeps = {
  fetch: (...args) => fetch(...args),
  sleep,
  stdin: () => streamInput(process.stdin),
};

export const AUTO_SYNC_ON =
  'automatic sync is on, emit now sends new events as they happen. Turn it off with sealkeeper config auto-sync off';

type SyncOptions = { dryRun?: boolean; yes?: boolean };

export function register(
  parent: Command,
  deps: SyncDeps = defaultSyncDeps,
): Command {
  return parent
    .command('sync')
    .description('Sign pending events and send them to the API')
    .option(
      '--dry-run',
      'print every pending event exactly as it would be sent, send nothing',
    )
    .option(
      '--yes',
      'send without asking first, and turn on automatic sync unless it was turned off with sealkeeper config auto-sync off',
    )
    .action(async function (this: Command, options: SyncOptions) {
      const json = wantsJson(this);

      // Works before init too, since emit logs before init.
      if (options.dryRun) {
        const preview = await loadPreview(this);
        if (json) {
          stdout(
            JSON.stringify({
              pending: preview.count,
              events: preview.groups.flatMap((g) => g.events),
            }),
          );
        } else {
          for (const line of previewLines(preview)) stdout(line);
        }
        return;
      }

      const config = await loadConfig(this);
      if (config === null) this.error(NOT_INITIALISED);

      // Unless automatic sync is on, every sync shows what it is about to
      // send and asks. --yes is the answer given in advance. autoSync unset
      // means no sync has been confirmed yet, and the first one turns it on.
      // false means the operator turned it off, and it stays off.
      let until: LogPosition | null | undefined;
      if (config.autoSync !== true) {
        const first = config.autoSync === undefined;
        const preview = await loadPreview(this);
        if (preview.count > 0 || options.yes) {
          if (!options.yes) {
            if (!(await confirmSync(this, preview, deps, json, first))) {
              stderr('nothing sent, automatic sync stays off');
              return;
            }
            // Send what was shown and nothing logged while the question
            // waited.
            until = preview.last;
          }
          if (first) {
            await writeConfig({ ...config, autoSync: true });
            stderr(AUTO_SYNC_ON);
          }
        }
      }

      const api = createApiClient({
        apiUrl: resolveApiUrl({ config: config.apiUrl }),
        fetch: deps.fetch,
      });
      let result: Awaited<ReturnType<typeof syncEvents>>;
      try {
        result = await syncEvents({ api, sleep: deps.sleep, until });
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

      if (json) {
        stdout(JSON.stringify(result));
        return;
      }
      const skipped = result.skipped > 0 ? `, skipped ${result.skipped}` : '';
      stdout(
        `accepted ${result.accepted}, duplicates ${result.duplicates}${skipped}`,
      );
    });
}

// Prints the preview and asks on stderr. True on yes. With no terminal to
// ask it ends the command with exit 1 before anything is sent. first is true
// until one sync has been confirmed, and then yes also turns on automatic
// sync.
async function confirmSync(
  cmd: Command,
  preview: Preview,
  deps: SyncDeps,
  json: boolean,
  first: boolean,
): Promise<boolean> {
  // With --json stdout carries only the result, so the preview goes to stderr.
  const print = json ? stderr : stdout;
  for (const line of previewLines(preview)) print(line);

  const input = (deps.stdin ?? noInput)();
  if (!input.isTTY) {
    cmd.error(
      first
        ? 'nothing sent. There is no terminal to ask, so review the events above and run sealkeeper sync --yes to send them and turn on automatic sync'
        : 'nothing sent. There is no terminal to ask, so review the events above and run sealkeeper sync --yes to send them. Automatic sync stays off',
    );
  }
  const n = preview.count;
  const these = n === 1 ? 'this event' : `these ${n} events`;
  process.stderr.write(
    first
      ? `send ${these} now and turn on automatic sync for future events? [y/N] `
      : `send ${these} now? [y/N] `,
  );
  return isYes(await input.readLine());
}

function noInput(): Input {
  return { isTTY: false, readLine: async () => null };
}

async function loadPreview(cmd: Command): Promise<Preview> {
  try {
    return await readPreview();
  } catch (error) {
    if (error instanceof CursorError) cmd.error(error.message);
    throw error;
  }
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
