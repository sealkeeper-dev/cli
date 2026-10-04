// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Event, EventType } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { gatedSync, WAITING_CALLER_LIMITS } from '../background-sync.js';
import { loadConfig } from '../cli-config.js';
import { DEFAULT_AGENT_VERSION } from '../config.js';
import { type EmitInput, emit } from '../emit.js';
import { cli } from '../invocation.js';
import { countPending, countPendingLines } from '../log.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { pendingText, SyncError } from '../sync.js';
import { UNSENT_TYPES } from '../taxonomy.js';
import { defaultSyncDeps, type SyncDeps } from './sync.js';

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
    .command('emit', { hidden: true })
    .description('Append one event to the local log. Adapters call this')
    .requiredOption('--type <type>', 'event type, for example session.start')
    .option('--payload <json>', 'event payload as a JSON object (default: {})')
    .option('--version <version>', 'agent version (default: from config)')
    .option('--no-sync', 'only append to the log, do not send')
    .action(async function (this: Command, options: EmitOptions) {
      // A type this CLI never sends is not recorded. It is not an error, so
      // an adapter written for an older CLI keeps working.
      if (UNSENT_TYPES.includes(options.type as EventType)) {
        stderr(`${options.type} is no longer recorded, nothing was written`);
        return;
      }

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
      // the next sync sends it, so the command still succeeds. It goes
      // through the gate the background sync uses, so an agent that emits
      // often sends at most once every 5 minutes across all its processes,
      // never sends one batch twice from parallel emits and never holds up
      // the hook that called it for more than a few seconds. emit runs it
      // here rather than starting it in the background, since the process
      // exits as soon as the command returns and would cut a background sync
      // off mid request. A throttled or locked emit prints nothing. sync
      // sends now, whatever the throttle.
      try {
        await gatedSync({ fetch: deps.fetch, ...WAITING_CALLER_LIMITS });
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
