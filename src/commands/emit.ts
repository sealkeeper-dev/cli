// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Event } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { createApiClient, resolveApiUrl } from '../api.js';
import { loadConfig } from '../cli-config.js';
import { DEFAULT_AGENT_VERSION } from '../config.js';
import { type EmitInput, emit } from '../emit.js';
import { cli } from '../invocation.js';
import { countPending, countPendingLines } from '../log.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { pendingText, SyncError, syncEvents } from '../sync.js';
import { defaultSyncDeps, type SyncDeps } from './sync.js';

// emit never waits long on the network. The hook that called it is waiting.
const EMIT_SYNC_TIMEOUT_MS = 2_000;

type EmitOptions = {
  type: string;
  payload?: string;
  version?: string;
  sync: boolean;
};

export function register(
  parent: Command,
  deps: SyncDeps = defaultSyncDeps,
): Command {
  return parent
    .command('emit')
    .description('Append one event to the local log. Adapters call this')
    .requiredOption('--type <type>', 'event type, for example tool.call')
    .option('--payload <json>', 'event payload as a JSON object (default: {})')
    .option('--version <version>', 'agent version (default: from config)')
    .option('--no-sync', 'only append to the log, do not send')
    .action(async function (this: Command, options: EmitOptions) {
      let payload: unknown;
      try {
        payload = JSON.parse(options.payload ?? '{}');
      } catch {
        this.error('--payload is not valid JSON');
      }

      const config = await loadConfig(this);
      let event: Event;
      try {
        // The shape is checked by Event.parse inside emit, not by the cast.
        event = await emit({
          type: options.type,
          payload,
          version: options.version ?? config?.version ?? DEFAULT_AGENT_VERSION,
        } as EmitInput);
      } catch (error) {
        if (error instanceof z.ZodError) {
          this.error(`invalid event\n${z.prettifyError(error)}`);
        }
        throw error;
      }

      stdout(
        wantsJson(this)
          ? JSON.stringify({ eventId: event.event_id })
          : event.event_id,
      );

      if (config === null) {
        stderr(
          `not initialised, the event is kept in the local log, run ${cli('init')} to send it`,
        );
        return;
      }
      if (!options.sync) return;

      // Until the first sync is previewed and confirmed nothing leaves on its
      // own. One line says what is waiting and how to review it. The count
      // only counts lines from the cursor on, it does not parse the log,
      // which keeps growing while nothing is sent.
      if (config.autoSync !== true) {
        const pending = await countPendingLines().catch(() => null);
        const count =
          pending === null
            ? 'events'
            : `${pending} event${pending === 1 ? '' : 's'}`;
        stderr(`${count} waiting, run ${cli('sync')} to review and send`);
        return;
      }

      // Best effort. Whatever goes wrong, the event is already in the log and
      // the next sync sends it, so the command still succeeds.
      try {
        await syncEvents({
          api: createApiClient({
            apiUrl: resolveApiUrl({ config: config.apiUrl }),
            fetch: deps.fetch,
            timeoutMs: EMIT_SYNC_TIMEOUT_MS,
          }),
          sleep: deps.sleep,
          maxRateLimitWaitSec: 0,
        });
      } catch (error) {
        const pending =
          error instanceof SyncError
            ? error.pending
            : await countPending().catch(() => null);
        const count = pending === null ? 'events' : pendingText(pending);
        stderr(`warning: sync did not finish, ${count}, run ${cli('sync')}`);
      }
    });
}
