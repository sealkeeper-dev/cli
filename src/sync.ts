// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { type Event, MAX_EVENTS_PER_BATCH } from '@vouched-dev/schema';
import { type ApiClient, ApiError } from './api.js';
import { type Paths, paths } from './config.js';
import { loadSigner } from './identity.js';
import {
  CURSOR_VERSION,
  countPending,
  type LogPosition,
  readCursor,
  readPending,
  writeCursor,
} from './log.js';
import { stderr } from './output.js';

// Sends pending events from the local log to the API. Each round reads up to
// 500 pending events, drops the ones too old for the API to accept, signs
// the rest, posts them to /v1/events and, on 200, moves the cursor past the
// last one sent. It loops until nothing is pending. It runs when sync, emit,
// a hook or an adapter's background sync calls it.

// The API caps a batch at 500 events and the request body at 256 KB.
export const MAX_BATCH_EVENTS = MAX_EVENTS_PER_BATCH;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_RATE_LIMIT_WAIT_SEC = 30;

// How old an event's occurred_at may be for the API to accept it. The API
// reads this from EVENT_MAX_AGE_DAYS in apps/api/src/config.ts, and
// @vouched-dev/schema does not export it, so this is the one copy the CLI
// keeps. Keep the two in step.
export const EVENT_MAX_AGE_DAYS = 7;
// Events are dropped before signing only when they are this much older than
// the window, so a clock a little off never drops one the API would still
// take. One that falls between the two is sent and, if the API rejects it,
// skipped by the per event fallback below.
export const STALE_MARGIN_MS = 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export type SyncResult = {
  accepted: number;
  duplicates: number;
  // Events the API rejected one by one and the cursor moved past.
  skipped: number;
  // Events older than the API's window, dropped before signing without a
  // request.
  dropped: number;
};

// Why sync stopped before the log was empty. pending counts what is still
// unsent. result holds the totals of the batches that did go through.
export class SyncError extends Error {
  override name = 'SyncError';
  constructor(
    readonly code: string,
    message: string,
    readonly pending: number,
    readonly result: SyncResult,
  ) {
    super(`${message}, ${pendingText(pending)}`);
  }
}

export type SyncOptions = {
  api: ApiClient;
  sleep: (ms: number) => Promise<void>;
  // Longest Retry-After sync waits for, once per run. 0 means never wait.
  maxRateLimitWaitSec?: number;
  // The last event to send. sync sets it to the last event it showed in the
  // preview, so an event logged while the question waited is not sent under
  // an answer to a list it was not on. It goes with the next sync.
  until?: LogPosition | null;
  paths?: Paths;
  // The clock, for the stale event cutoff. Tests set it.
  now?: () => number;
  // Stop between rounds once this time (ms since the epoch) has passed. What
  // is left goes with the next sync. The background sync sets it.
  deadline?: number;
  // Where warnings go. stderr by default. The background sync, which runs
  // inside someone else's agent, passes one that prints nothing.
  warn?: (text: string) => void;
};

export function pendingText(count: number): string {
  return `${count} event${count === 1 ? '' : 's'} pending`;
}

export async function syncEvents(options: SyncOptions): Promise<SyncResult> {
  const warn = options.warn ?? stderr;
  const result: SyncResult = {
    accepted: 0,
    duplicates: 0,
    skipped: 0,
    dropped: 0,
  };
  try {
    return await sendRounds(options, result, warn);
  } finally {
    // Said once per run, however many rounds dropped events.
    if (result.dropped > 0) {
      const n = result.dropped;
      warn(
        `warning: dropped ${n} event${n === 1 ? '' : 's'} older than ${EVENT_MAX_AGE_DAYS} days, the API no longer accepts ${n === 1 ? 'it' : 'them'}`,
      );
    }
  }
}

async function sendRounds(
  options: SyncOptions,
  result: SyncResult,
  warn: (text: string) => void,
): Promise<SyncResult> {
  const p = options.paths ?? paths();
  const now = options.now ?? Date.now;
  const maxWait = options.maxRateLimitWaitSec ?? MAX_RATE_LIMIT_WAIT_SEC;
  const signer = await loadSigner(p);
  let waited = false;

  // until is null when the preview was empty, so there is nothing to send.
  if (options.until === null) return result;
  const until = options.until;

  for (;;) {
    if (options.deadline !== undefined && now() >= options.deadline) {
      return result;
    }
    const pending = await readPending(MAX_BATCH_EVENTS, p);
    let lastRound = false;
    if (until) {
      const end = pending.positions.findIndex((at) => samePosition(at, until));
      if (end >= 0) {
        pending.events.length = end + 1;
        pending.positions.length = end + 1;
        lastRound = true;
      } else if (pending.events.length < MAX_BATCH_EVENTS) {
        // Everything pending was read and until is not in it, so it has
        // already been sent.
        return result;
      }
    }
    const last = pending.events.length - 1;
    if (last < 0) return result;

    // Events the API would refuse as out of window are not signed or sent.
    // The cursor moves past them together with the fresh events around
    // them, in the one move each round makes, or on its own when the whole
    // round is stale. They are counted as dropped once the cursor is past
    // them, so a round that stops early does not count them twice.
    const cutoff = now() - EVENT_MAX_AGE_DAYS * DAY_MS - STALE_MARGIN_MS;
    const fresh: { event: Event; at: number }[] = [];
    const stale: number[] = [];
    for (const [at, event] of pending.events.entries()) {
      if (Date.parse(event.occurred_at) < cutoff) stale.push(at);
      else fresh.push({ event, at });
    }
    // Moves the cursor past pending.events[at].
    const moveTo = async (at: number, syncedAt?: Date) => {
      await ack(pending.positions[at], p, syncedAt);
      result.dropped += stale.filter((i) => i <= at).length;
    };
    if (fresh.length === 0) {
      await moveTo(last);
      if (lastRound) return result;
      continue;
    }

    const signed: string[] = [];
    for (const { event } of fresh) signed.push(await signer.sign(event));
    let envelopes = fitBatch(signed);

    // Sends one batch. A rejection at index i > 0 sends the i events before
    // it on their own. A rejection at index 0 skips that one event. Either
    // way the next round of the outer loop picks up the rest.
    for (;;) {
      try {
        const sent = await options.api.postEvents(envelopes);
        result.accepted += sent.accepted;
        result.duplicates += sent.duplicates;
        // When the whole round went, stale events after the last fresh one
        // are acked with it.
        const all = envelopes.length === fresh.length;
        await moveTo(
          all ? last : (fresh[envelopes.length - 1]?.at ?? last),
          new Date(),
        );
        if (lastRound && all) return result;
        break;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;

        const index = rejectedIndex(error, envelopes.length);
        if (index === 0) {
          const id = fresh[0]?.event.event_id;
          warn(
            `warning: the API rejected event ${id} (${error.code}), skipped it`,
          );
          result.skipped++;
          const only = fresh.length === 1;
          await moveTo(only ? last : (fresh[0]?.at ?? last));
          if (lastRound && only) return result;
          break;
        }
        if (index !== null) {
          envelopes = envelopes.slice(0, index);
          continue;
        }

        if (error.status === 429 && !waited && maxWait > 0) {
          const wait = error.retryAfterSec ?? maxWait;
          if (wait <= maxWait) {
            waited = true;
            await options.sleep(wait * 1000);
            continue;
          }
        }
        throw new SyncError(
          error.code,
          stopMessage(error),
          await countPending(p),
          result,
        );
      }
    }
  }
}

function samePosition(a: LogPosition, b: LogPosition): boolean {
  return a.file === b.file && a.eventId === b.eventId;
}

// Moves the cursor past position. syncedAt is set when the API accepted a
// batch and becomes lastSyncAt. A skipped event keeps the previous one.
async function ack(
  position: LogPosition | undefined,
  p: Paths,
  syncedAt?: Date,
): Promise<void> {
  if (!position) throw new Error('No log position for a sent event');
  const lastSyncAt =
    syncedAt?.toISOString() ?? (await readCursor(p)).lastSyncAt;
  await writeCursor(
    {
      v: CURSOR_VERSION,
      lastAcked: position,
      ...(lastSyncAt ? { lastSyncAt } : {}),
    },
    p,
  );
}

// The longest prefix whose request body stays within MAX_BATCH_BYTES, and at
// least one envelope. Envelopes are base64url and dots, so JSON adds only the
// quotes and commas.
function fitBatch(envelopes: string[]): string[] {
  let bytes = JSON.stringify({ envelopes: [] }).length;
  for (const [i, envelope] of envelopes.entries()) {
    bytes += envelope.length + 2 + (i > 0 ? 1 : 0);
    if (bytes > MAX_BATCH_BYTES && i > 0) return envelopes.slice(0, i);
  }
  return envelopes;
}

// A 400 or 401 that names one envelope in issues[].path as
// ['envelopes', i]. The lowest such index, or null.
function rejectedIndex(error: ApiError, size: number): number | null {
  if (error.status !== 400 && error.status !== 401) return null;
  let lowest: number | null = null;
  for (const issue of error.issues) {
    const [field, i] = issue.path;
    if (field !== 'envelopes' || typeof i !== 'number') continue;
    if (!Number.isInteger(i) || i < 0 || i >= size) continue;
    if (lowest === null || i < lowest) lowest = i;
  }
  return lowest;
}

function stopMessage(error: ApiError): string {
  switch (error.code) {
    case 'network_error':
    case 'bad_response':
      return error.message;
    case 'unknown_agent':
      return 'the API does not know this agent, run vouched init';
    case 'rate_limited':
      return 'the API is rate limiting this agent, try again later';
    default:
      return `the API refused the batch with ${error.code}, ${error.message}`;
  }
}
