// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  EVENT_MAX_AGE_DAYS,
  EVENT_MAX_FUTURE_SKEW_SEC,
  type Event,
  MAX_EVENTS_PER_BATCH,
} from '@sealkeeper/schema';
import { type ApiClient, ApiError } from './api.js';
import { type Paths, paths } from './config.js';
import {
  declaredFingerprint,
  refusesFingerprint,
} from './declared-fingerprint.js';
import { loadSigner, type Signer } from './identity.js';
import { cli } from './invocation.js';
import {
  CURSOR_VERSION,
  countPending,
  type LogPosition,
  pruneLog,
  readCursor,
  readPending,
  skipStaleDays,
  writeCursor,
} from './log.js';
import { stderr } from './output.js';

// Sends pending events from the local log to the API. Each round reads up to
// 500 pending events, drops the ones too old for the API to accept, signs
// the rest, posts them to /v1/events and, on 200, moves the cursor past the
// last one sent. It loops until nothing is pending. Once a run has finished
// it deletes the day files the log no longer needs, see pruneLog. It runs
// when sync, emit, a hook or an adapter's background sync calls it.

// The API caps a batch at 500 events and the request body at 256 KB.
const MAX_BATCH_EVENTS = MAX_EVENTS_PER_BATCH;
const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_RATE_LIMIT_WAIT_SEC = 30;

// How old an event's occurred_at may be for the API to accept it, and how
// far ahead of the API clock, come from @sealkeeper/schema, the defaults
// the API runs on.
// Events are dropped before signing only when they are this much older than
// the window, so a clock a little off never drops one the API would still
// take. One that falls between the two is sent and, if the API rejects it,
// skipped by the per event fallback below. A rejected event that is not
// within this margin of the old edge was refused as ahead of the API clock,
// which judgeRefusal below handles.
const STALE_MARGIN_MS = 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
// An event logged while this machine clock ran ahead, refused once the clock
// agrees with the API again, waits until its time comes when that is at most
// this far off. One further off is skipped, so it cannot hold back the events
// logged after it for hours or days.
const FUTURE_WAIT_MS = 3600 * 1000;

// An event whose occurred_at is before this moment (ms since the epoch) is
// dropped, not sent. The sync preview leaves it out too.
export function staleCutoff(now: number): number {
  return now - EVENT_MAX_AGE_DAYS * DAY_MS - STALE_MARGIN_MS;
}

type SyncResult = {
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

type SyncOptions = {
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
  // Called before each round, before each request of a round and before a
  // rate limit wait. The sync lock passes one that stamps the lock file, so
  // a long sync keeps it.
  onRound?: () => Promise<void>;
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
    await sendRounds(options, result, warn);
    // At most once per run, and only after a run that did not fail. The
    // events are sent either way, so a file that cannot be deleted is only
    // a warning.
    const p = options.paths ?? paths();
    try {
      await pruneLog(p, new Date((options.now ?? Date.now)()));
    } catch (error) {
      warn(
        `warning: could not delete old day files from ${p.log}, ${(error as Error).message}`,
      );
    }
    return result;
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
  let waited = false;

  // The first response of the run says what time the API has. When this
  // machine is further ahead than the API accepts, every event it logs now
  // carries a time the API refuses as future, so the sync stops there and
  // moves the cursor past nothing it has not sent. A machine behind the API
  // logs times the API still takes, since it accepts them up to
  // EVENT_MAX_AGE_DAYS old, so that warns once and the sync goes on. A
  // response without a Date header says nothing and the sync goes on.
  // Checked once, after the first round is signed, since that request is
  // the first response.
  let clockChecked = false;
  const checkClock = async () => {
    if (clockChecked) return;
    clockChecked = true;
    const server = options.api.serverDate();
    if (server === null) return;
    const aheadMs = now() - server;
    const skewMs = EVENT_MAX_FUTURE_SKEW_SEC * 1000;
    if (aheadMs < -skewMs) {
      warn(behindWarning(-aheadMs));
      return;
    }
    if (aheadMs <= skewMs) return;
    throw new SyncError(
      'clock_skew',
      aheadMessage(aheadMs),
      await countPending(p),
      result,
    );
  };

  // until is null when the preview was empty, so there is nothing to send.
  if (options.until === null) return result;
  const until = options.until;
  const reading = () => ({ now: new Date(now()), warn });

  // Whole day files too old to send are dropped without reading a line.
  result.dropped += await skipStaleDays(p, reading());

  // Loaded once, when the first fresh event needs signing, so a run with
  // nothing to send never reads the key. A refused apiUrl stops the sync the
  // way a refused batch does, with the pending count.
  let signer: Signer | undefined;
  const loadOnce = async (): Promise<Signer> => {
    if (signer) return signer;
    try {
      signer = await loadSigner(options.api.apiUrl, p);
      return signer;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      throw new SyncError(
        error.code,
        stopMessage(error, now()),
        await countPending(p, reading()),
        result,
      );
    }
  };

  // The fingerprint this run declares (VB-4), fingerprint.json as sync or
  // prove last wrote it, never computed here. Signed on its own when the
  // first batch goes and sent beside the envelopes until a batch is
  // accepted with it. When the API refuses it, as an API from before the
  // field does, the batch goes again without it and the rest of the run
  // sends none.
  let fingerprintDue = true;
  let fingerprintJws: string | undefined;
  const fingerprintToSend = async (s: Signer): Promise<string | undefined> => {
    if (!fingerprintDue) return undefined;
    if (fingerprintJws === undefined) {
      const { fingerprint } = await declaredFingerprint(p);
      if (fingerprint === undefined) {
        fingerprintDue = false;
        return undefined;
      }
      fingerprintJws = await s.sign({ fingerprint });
    }
    return fingerprintJws;
  };

  for (;;) {
    if (options.deadline !== undefined && now() >= options.deadline) {
      return result;
    }
    await options.onRound?.();
    const pending = await readPending(MAX_BATCH_EVENTS, p, reading());
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
    const cutoff = staleCutoff(now());
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
    const roundSigner = await loadOnce();
    for (const { event } of fresh) signed.push(await roundSigner.sign(event));
    let fingerprint = await fingerprintToSend(roundSigner);
    let envelopes = fitBatch(signed, fingerprint);

    // Sends one batch. A rejection at index i > 0 sends the i events before
    // it on their own. A rejection at index 0 skips that event, or stops the
    // sync and leaves the cursor where it was when waiting or fixing this
    // machine clock gets it in (judgeRefusal). Otherwise the next round of
    // the outer loop picks up the rest.
    for (;;) {
      // Stamped before every attempt too, since one round can post several
      // times, with split retries and a rate limit wait between them.
      await options.onRound?.();
      try {
        const sent = await options.api.postEvents(envelopes, fingerprint);
        fingerprintDue = false;
        result.accepted += sent.accepted;
        result.duplicates += sent.duplicates;
        // When the whole round went, stale events after the last fresh one
        // are acked with it.
        const all = envelopes.length === fresh.length;
        await moveTo(
          all ? last : (fresh[envelopes.length - 1]?.at ?? last),
          new Date(),
        );
        await checkClock();
        if (lastRound && all) return result;
        break;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (fingerprint !== undefined && refusesFingerprint(error)) {
          fingerprintDue = false;
          fingerprint = undefined;
          continue;
        }
        // Status 0 means no response came back, so there is no Date to read.
        if (error.status !== 0) await checkClock();

        const index = rejectedIndex(error, envelopes.length);
        if (index === 0) {
          const refusal = judgeRefusal(
            error,
            fresh,
            options.api.serverDate(),
            now(),
          );
          if ('stop' in refusal) {
            throw new SyncError(
              error.code,
              refusal.stop,
              await countPending(p),
              result,
            );
          }
          warn(refusal.warning);
          result.skipped += refusal.skip;
          const all = refusal.skip >= fresh.length;
          await moveTo(all ? last : (fresh[refusal.skip - 1]?.at ?? last));
          if (lastRound && all) return result;
          break;
        }
        if (index !== null && index > 0) {
          envelopes = envelopes.slice(0, index);
          continue;
        }

        if (error.status === 429 && !waited && maxWait > 0) {
          const wait = error.retryAfterSec ?? maxWait;
          if (wait <= maxWait) {
            waited = true;
            await options.onRound?.();
            await options.sleep(wait * 1000);
            continue;
          }
        }
        throw new SyncError(
          error.code,
          stopMessage(error, now(), maxWait),
          await countPending(p),
          result,
        );
      }
    }
  }
}

// What to do with the event the API rejected at index 0. skip moves the
// cursor past that many leading events for good and warns once. stop ends
// the sync and moves the cursor past nothing.
type Refusal = { skip: number; warning: string } | { stop: string };

// A version_limit is never skipped, it clears at the next UTC day. An
// occurred_at refusal is skipped when the event is near the old edge of the
// window, where it is too old for the API. The edge is read from serverNow,
// the Date of the refusal, when there is one, since the API judged the event
// by its own clock and this one may be behind it. A younger one was refused
// as ahead of the API clock. When serverNow is missing or this machine clock
// is further ahead of it than the API accepts, the clock is the likely cause
// and fixing it is what gets the event in. When this clock agrees with the
// API or is behind it, it is not ahead now and the event was logged while it
// ran ahead. The sync then waits
// for the event's time to come if that is within FUTURE_WAIT_MS, and
// otherwise skips it together with the events right after it that are as
// far ahead, in one request.
function judgeRefusal(
  error: ApiError,
  fresh: readonly { event: Event }[],
  serverNow: number | null,
  now: number,
): Refusal {
  const event = fresh[0]?.event;
  if (error.code === 'version_limit') return { stop: stopMessage(error, now) };
  const skipOne = {
    skip: 1,
    warning: `warning: the API rejected event ${event?.event_id} (${error.code}), skipped it`,
  };
  if (error.code !== 'occurred_at_out_of_window' || !event) return skipOne;
  const oldEdge = (serverNow ?? now) - EVENT_MAX_AGE_DAYS * DAY_MS;
  if (Date.parse(event.occurred_at) < oldEdge + STALE_MARGIN_MS) {
    return skipOne;
  }

  const skewMs = EVENT_MAX_FUTURE_SKEW_SEC * 1000;
  if (serverNow === null || now - serverNow > skewMs) {
    return { stop: stopMessage(error, now) };
  }
  // How long until the API accepts e.
  const waitMs = (e: Event) => Date.parse(e.occurred_at) - skewMs - serverNow;
  const first = waitMs(event);
  if (!(first > FUTURE_WAIT_MS)) {
    return {
      stop: `the API refused an event logged while this machine clock ran ahead, it accepts it once its time comes, in ${durationText(first)}, sync again then, nothing was skipped`,
    };
  }
  let n = 1;
  for (; n < fresh.length; n++) {
    const next = fresh[n]?.event;
    if (!next || !(waitMs(next) > FUTURE_WAIT_MS)) break;
  }
  return {
    skip: n,
    warning: `warning: skipped ${n} event${n === 1 ? '' : 's'} logged while this machine clock ran ahead, the API would not accept ${n === 1 ? 'it' : 'them'} for more than ${FUTURE_WAIT_MS / 60_000} minutes`,
  };
}

// aheadMs is this machine's time less the API's Date, positive here.
function aheadMessage(aheadMs: number): string {
  const secs = Math.round(aheadMs / 1000);
  return `this machine clock is ${secs} seconds ahead of the API clock, more than the ${EVENT_MAX_FUTURE_SKEW_SEC} the API accepts, check this machine clock and sync again`;
}

// behindMs is the API's Date less this machine's time, positive here.
function behindWarning(behindMs: number): string {
  const secs = Math.round(behindMs / 1000);
  return `warning: this machine clock is ${secs} seconds behind the API clock, the API still accepts its events since it takes them up to ${EVENT_MAX_AGE_DAYS} days old, check this machine clock`;
}

// A wait in hours and minutes, rounded up to the minute and at least one.
function durationText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.join(' ');
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
// least one envelope, with the fingerprint JWS beside them when there is
// one. Envelopes are base64url and dots, so JSON adds only the quotes and
// commas.
function fitBatch(envelopes: string[], fingerprint?: string): string[] {
  let bytes = JSON.stringify({ envelopes: [], fingerprint }).length;
  for (const [i, envelope] of envelopes.entries()) {
    bytes += envelope.length + 2 + (i > 0 ? 1 : 0);
    if (bytes > MAX_BATCH_BYTES && i > 0) return envelopes.slice(0, i);
  }
  return envelopes;
}

// A 400 or 401 that names one envelope in issues[].path as
// ['envelopes', i]. The lowest such index, or null.
// wrong_audience never names one, and is null here too, so a misconfigured
// apiUrl stops the sync rather than skipping every event (VOU-111).
function rejectedIndex(error: ApiError, size: number): number | null {
  if (error.status !== 400 && error.status !== 401) return null;
  if (error.code === 'wrong_audience') return null;
  let lowest: number | null = null;
  for (const issue of error.issues) {
    const [field, i] = issue.path;
    if (field !== 'envelopes' || typeof i !== 'number') continue;
    if (!Number.isInteger(i) || i < 0 || i >= size) continue;
    if (lowest === null || i < lowest) lowest = i;
  }
  return lowest;
}

// maxWaitSec is the longest Retry-After this sync would wait for. A
// rate_limited refusal past it is not a burst the next try gets through,
// such as the daily event cap, so the API's own message says why and when
// it clears.
function stopMessage(error: ApiError, now: number, maxWaitSec = 0): string {
  switch (error.code) {
    case 'occurred_at_out_of_window':
      return 'the API refused an event as ahead of its clock, check this machine clock and sync again, nothing was skipped';
    case 'version_limit':
      return `this agent started as many new versions today as the API accepts, the limit clears at midnight UTC, in ${durationText(DAY_MS - (now % DAY_MS))}, sync again then`;
    case 'network_error':
    case 'bad_response':
      return error.message;
    case 'unknown_agent':
      return `the API does not know this agent, run ${cli('init')}`;
    case 'rate_limited': {
      const wait = error.retryAfterSec;
      if (wait === null || wait <= maxWaitSec) {
        return 'the API is rate limiting this agent, try again later';
      }
      const said = error.message.trim().replace(/\.$/, '');
      return `the API is rate limiting this agent for ${durationText(wait * 1000)}, it says ${said}`;
    }
    case 'wrong_audience':
      return `the API refused events signed for another address, check apiUrl, ${error.message}`;
    default:
      return `the API refused the batch with ${error.code}, ${error.message}`;
  }
}
