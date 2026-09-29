// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { EVENT_MAX_AGE_DAYS, Event } from '@sealkeeper/schema';
import { z } from 'zod';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { stderr } from './output.js';
import { isSent, UNSENT_TYPES } from './taxonomy.js';

// The local event log. Append-only JSONL, one file per UTC day under
// paths().log, named YYYY-MM-DD.jsonl. A line goes to the file of the day it
// is appended, not the event's occurred_at, or to the newest day file there
// is when that one sorts later, as after a clock that ran ahead was put back.
// So file name order is append order, and an event that arrives late, or
// after the clock stepped back, still lands at or after the cursor. Each line
// is {v: 1, ...event}. Nothing here signs or sends anything. Day files are
// deleted only by pruneLog, once they are old and wholly behind the cursor.

const LOG_LINE_VERSION = 1;
export const CURSOR_VERSION = 1;

// Day files older than this, wholly behind the cursor, are deleted by sync.
export const LOG_RETENTION_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;
const READ_CHUNK_BYTES = 64 * 1024;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// Where sync got to, as cursor.json stores it. file is the day file's name,
// not a full path, so the cursor stays valid if the home directory moves.
// This shape and Cursor below are the ones CLI 0.4.6 reads, strictly, and
// they stay that way. An older CLI or adapter library often shares this
// home (a hook pinned to an older script, a project's own sealkeeper
// dependency), and it refuses a cursor.json with any key it does not know.
const AckedPosition = z.strictObject({
  file: z.string().regex(DAY_FILE),
  eventId: z.uuid(),
});

// A place in the log. offset is the byte offset of the event's line in
// file, so a read can start there instead of parsing the file from the top.
// It is kept in cursor-offset.json next to cursor.json, not in it, and is
// checked against eventId before it is used.
export const LogPosition = AckedPosition.extend({
  offset: z.int().min(0).optional(),
});
export type LogPosition = z.infer<typeof LogPosition>;

// lastSyncAt is when sync last had a batch accepted. It is optional so a
// cursor written before it existed still parses.
const StoredCursor = z.strictObject({
  v: z.literal(CURSOR_VERSION),
  lastAcked: AckedPosition.nullable(),
  lastSyncAt: z.iso.datetime({ offset: true }).optional(),
});

// The cursor as the code uses it, with the offset of lastAcked when
// cursor-offset.json still matches it.
const Cursor = StoredCursor.extend({ lastAcked: LogPosition.nullable() });
export type Cursor = z.infer<typeof Cursor>;

// cursor-offset.json. It names the position it belongs to, so an older CLI
// that moves cursor.json without touching this file leaves it unmatched, and
// the next read scans the file instead.
const CursorOffset = z.strictObject({
  file: z.string().regex(DAY_FILE),
  eventId: z.uuid(),
  offset: z.int().min(0),
});

export class CursorError extends Error {
  override name = 'CursorError';
}

type Pending = {
  events: Event[];
  // The position of each event in events, so a caller can ack part of them.
  positions: LogPosition[];
  // Position of the last event returned, or null when nothing is pending.
  last: LogPosition | null;
};

export type PendingEntry = { event: Event; position: LogPosition };

export type ReadOptions = {
  // The clock, which decides which day files are too old to send. Tests set
  // it.
  now?: Date;
  // Where warnings go, stderr by default. The background sync, which runs
  // inside someone else's agent, passes one that prints nothing.
  warn?: (text: string) => void;
};

// The UTC day of a moment, as YYYY-MM-DD.
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// The newest day each log directory has, per process, so emit does not list
// the directory on every append. It moves forward when this process writes
// a newer day, and the directory is listed again once the entry is
// NEWEST_DAY_TTL_MS old by the clock, either way. That picks up a newer file
// another process wrote, which matters to a long running agent whose clock
// is behind that file's day, as after a clock that ran ahead was put back.
const newestDays = new Map<string, { day: string; listedAt: number }>();
const NEWEST_DAY_TTL_MS = 10 * 60 * 1000;

// Validates the event, then appends one line with a single write to the day
// file for now (which tests can set), or to the newest day file when that
// sorts later. No fsync, so emit stays fast. The file is opened read and
// write so the last byte can be checked. If an earlier crash left a partial
// line with no trailing newline, the new line starts on a fresh line and is
// not lost.
export async function appendEvent(
  input: unknown,
  p: Paths = paths(),
  now: Date = new Date(),
): Promise<Event> {
  const event = Event.parse(input);
  await mkdir(p.log, { recursive: true, mode: 0o700 });

  const file = await open(
    p.logFile(await appendDay(p, now)),
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
    0o600,
  );
  try {
    const { size } = await file.stat();
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    const line = JSON.stringify({ v: LOG_LINE_VERSION, ...event });
    await file.write(`${prefix}${line}\n`);
  } finally {
    await file.close();
  }
  return event;
}

// The day to append to. Never one older than the newest day file, since
// every read skips the files that sort before the cursor's. A clock days
// ahead, or an NTP step back across UTC midnight, would otherwise put new
// events where no read looks until the real date passes the cursor's day.
async function appendDay(p: Paths, now: Date): Promise<string> {
  let cached = newestDays.get(p.log);
  if (
    cached === undefined ||
    Math.abs(now.getTime() - cached.listedAt) > NEWEST_DAY_TTL_MS
  ) {
    const day = (await listDayFiles(p)).at(-1)?.slice(0, 10) ?? '';
    cached = { day, listedAt: now.getTime() };
  }
  const today = dayOf(now);
  const day = today > cached.day ? today : cached.day;
  newestDays.set(p.log, { day, listedAt: cached.listedAt });
  return day;
}

// Returns an empty cursor when there is none yet. Throws CursorError when the
// file exists but does not parse, rather than guessing where sync got to.
export async function readCursor(p: Paths = paths()): Promise<Cursor> {
  let raw: string;
  try {
    raw = await readFile(p.cursor, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { v: CURSOR_VERSION, lastAcked: null };
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CursorError(`Invalid cursor at ${p.cursor}: not valid JSON`);
  }
  const result = StoredCursor.safeParse(json);
  if (!result.success) {
    throw new CursorError(
      `Invalid cursor at ${p.cursor}:\n${z.prettifyError(result.error)}`,
    );
  }
  const cursor: Cursor = result.data;
  const acked = cursor.lastAcked;
  if (!acked) return cursor;
  const offset = await readOffset(p);
  if (offset?.file !== acked.file || offset.eventId !== acked.eventId) {
    return cursor;
  }
  return { ...cursor, lastAcked: { ...acked, offset: offset.offset } };
}

// cursor-offset.json, or null when it is missing or does not parse. It only
// saves a scan, so a bad one is ignored rather than reported.
async function readOffset(
  p: Paths,
): Promise<z.infer<typeof CursorOffset> | null> {
  try {
    const result = CursorOffset.safeParse(
      JSON.parse(await readFile(p.cursorOffset, 'utf8')),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Writes the offset of lastAcked to cursor-offset.json, or removes that file
// when there is no offset, then cursor.json in the shape every CLI reads.
// cursor.json goes last, so a reader that sees the new cursor also finds
// its offset. A crash between the two leaves an offset that does not match
// cursor.json, and the next read scans the file.
export async function writeCursor(
  input: Cursor,
  p: Paths = paths(),
): Promise<Cursor> {
  const cursor = Cursor.parse(input);
  const acked = cursor.lastAcked;
  const stored = StoredCursor.parse({
    ...cursor,
    lastAcked: acked ? { file: acked.file, eventId: acked.eventId } : null,
  });
  await ensureHome(p);
  if (acked?.offset === undefined) {
    await rm(p.cursorOffset, { force: true });
  } else {
    const { file, eventId, offset } = acked;
    await writeFileAtomic(
      p.cursorOffset,
      `${JSON.stringify({ file, eventId, offset })}\n`,
    );
  }
  await writeFileAtomic(p.cursor, `${JSON.stringify(stored)}\n`);
  return cursor;
}

// Events after the cursor in file order then line order, up to limit. Files
// are read a chunk at a time, so a read that stops at limit reads little
// past it.
export async function readPending(
  limit: number,
  p: Paths = paths(),
  options: ReadOptions = {},
): Promise<Pending> {
  const events: Event[] = [];
  const positions: LogPosition[] = [];
  if (limit <= 0) return { events, positions, last: null };

  for await (const entry of pendingEvents(p, options)) {
    events.push(entry.event);
    positions.push(entry.position);
    if (events.length >= limit) break;
  }
  return { events, positions, last: positions.at(-1) ?? null };
}

// How many events are pending. A type this CLI never sends, see
// UNSENT_TYPES, is not pending. It never warns, since it is only a count.
// The reads that send say what is wrong with the log, and a warning from
// here could reach the output of the background sync, which never prints.
export async function countPending(
  p: Paths = paths(),
  options: { now?: Date } = {},
): Promise<number> {
  let count = 0;
  const quiet = { now: options.now, warn: () => {} };
  for await (const { event } of pendingEvents(p, quiet)) {
    if (isSent(event.type)) count++;
  }
  return count;
}

// A quick count of the lines after the cursor, for a hint like emit's
// "N events waiting". It reads only the cursor's day file and the ones after
// it, leaves out day files too old to send and never parses a line, so it
// stays cheap on a log that has grown for weeks while automatic sync was
// off. A line of a type never sent is found without a parse and not
// counted. A line that countPending would skip as invalid is counted here,
// which is fine for a hint.
export async function countPendingLines(
  p: Paths = paths(),
  now: Date = new Date(),
): Promise<number> {
  const { lastAcked } = await readCursor(p);
  const first = firstLiveFile(now);
  let count = 0;
  for (const name of await listDayFiles(p)) {
    if (name < first) continue;
    if (lastAcked && name < lastAcked.file) continue;
    const path = p.logFile(name.slice(0, 10));
    // The whole file counts when the acked line is missing, as countPending
    // resends that day.
    const start =
      lastAcked && name === lastAcked.file
        ? ((await resumeAt(path, lastAcked, holdsId(lastAcked.eventId))) ?? 0)
        : 0;
    count += await completeLines(path, start);
  }
  return count;
}

// The events appended on one UTC day, in line order. An empty list when the
// day has no file. Warnings go through options.warn, stderr when unset.
export async function readDay(
  date: string,
  p: Paths = paths(),
  options: Pick<ReadOptions, 'warn'> = {},
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const entry of fileEntries(
    p.logFile(Day.parse(date)),
    0,
    options.warn ?? stderr,
  )) {
    events.push(entry.event);
  }
  return events;
}

// The events of the day file for first and of every later day file, in
// append order. After a clock that ran ahead was put back, new events land
// in the newest day file, whose name is still in the future, so a read of
// "today" has to run through it, not stop at the day of now.
export async function readDaysFrom(
  first: string,
  p: Paths = paths(),
  options: Pick<ReadOptions, 'warn'> = {},
): Promise<Event[]> {
  const from = `${Day.parse(first)}.jsonl`;
  const events: Event[] = [];
  for (const name of await listDayFiles(p)) {
    if (name < from) continue;
    events.push(...(await readDay(name.slice(0, 10), p, options)));
  }
  return events;
}

// Every pending event with its position, in send order. Day files too old
// for the API to accept any of their events are left out by name, unread.
// sync drops them with skipStaleDays. The cursor's day file is read from
// just after the acked line.
export async function* pendingEvents(
  p: Paths = paths(),
  options: ReadOptions = {},
): AsyncGenerator<PendingEntry> {
  const warn = options.warn ?? stderr;
  const { lastAcked } = await readCursor(p);
  const first = firstLiveFile(options.now ?? new Date());
  for (const name of await listDayFiles(p)) {
    if (name < first) continue;
    if (lastAcked && name < lastAcked.file) continue;
    const path = p.logFile(name.slice(0, 10));

    let start = 0;
    if (lastAcked && name === lastAcked.file) {
      const after = await resumeAt(path, lastAcked, holdsEvent(lastAcked));
      // The acked event is missing from its file. Sending the whole file
      // again is safe because the API treats a repeated event_id as a no-op.
      if (after === null) {
        warn(
          `warning: acked event ${lastAcked.eventId} not found in ${name}, resending that day`,
        );
      }
      start = after ?? 0;
    }
    yield* fileEntries(path, start, warn);
  }
}

// Moves the cursor past every event in the log, for a new key that must
// never sign and send the events an old key logged, as after init --force.
// A cursor.json that does not parse is replaced. Returns how many events
// were still waiting to be sent, as countPending counts them.
export async function cursorToEnd(
  p: Paths = paths(),
  now: Date = new Date(),
): Promise<number> {
  try {
    await readCursor(p);
  } catch (error) {
    if (!(error instanceof CursorError)) throw error;
    await rm(p.cursor, { force: true });
    await rm(p.cursorOffset, { force: true });
  }
  let last: LogPosition | null = null;
  let skipped = 0;
  for await (const entry of pendingEvents(p, { now, warn: () => {} })) {
    last = entry.position;
    if (isSent(entry.event.type)) skipped++;
  }
  if (last !== null) {
    await writeCursor({ v: CURSOR_VERSION, lastAcked: last }, p);
  }
  return skipped;
}

// Moves the cursor past the day files too old to send. Every read already
// leaves them out by name. Moving past them lets sync count them as dropped
// once and pruneLog delete them later. Returns how many lines were moved
// past, counted without parsing them and without the lines of a type never
// sent, or 0 when the cursor did not move.
export async function skipStaleDays(
  p: Paths = paths(),
  options: ReadOptions = {},
): Promise<number> {
  const cursor = await readCursor(p);
  const acked = cursor.lastAcked;
  const first = firstLiveFile(options.now ?? new Date());
  const stale = (await listDayFiles(p)).filter(
    (name) => name < first && (!acked || name >= acked.file),
  );

  let count = 0;
  let last: LogPosition | null = null;
  for (const name of stale) {
    const path = p.logFile(name.slice(0, 10));
    const start =
      acked && name === acked.file
        ? ((await resumeAt(path, acked, holdsId(acked.eventId))) ?? 0)
        : 0;
    for await (const line of readLines(path, start)) {
      if (line.partial || line.text.length === 0) continue;
      if (!holdsUnsent(line.text)) count++;
      // The event id is read off the line without a parse. A line with no
      // usable id is counted but never becomes the cursor.
      const id = EVENT_ID.exec(line.text)?.[1];
      if (id && EventId.safeParse(id).success) {
        last = { file: name, eventId: id, offset: line.offset };
      }
    }
  }
  if (!last) return 0;
  await writeCursor({ ...cursor, lastAcked: last }, p);
  return count;
}

// Deletes the day files more than LOG_RETENTION_DAYS days old that sort
// before the cursor's file, so every line in them was sent or dropped.
// Returns the names deleted.
export async function pruneLog(
  p: Paths = paths(),
  now: Date = new Date(),
): Promise<string[]> {
  const { lastAcked } = await readCursor(p);
  if (!lastAcked) return [];
  const keepFrom = `${dayOf(new Date(now.getTime() - LOG_RETENTION_DAYS * DAY_MS))}.jsonl`;
  const removed: string[] = [];
  for (const name of await listDayFiles(p)) {
    if (name >= keepFrom || name >= lastAcked.file) break;
    await rm(p.logFile(name.slice(0, 10)), { force: true });
    removed.push(name);
  }
  return removed;
}

// The first day file name still read. Each line of an older file was
// appended more than EVENT_MAX_AGE_DAYS + 1 days before now, so every event
// in it is older than the API accepts and sync would drop it.
function firstLiveFile(now: Date): string {
  const from = new Date(now.getTime() - (EVENT_MAX_AGE_DAYS + 1) * DAY_MS);
  return `${dayOf(from)}.jsonl`;
}

const EVENT_ID = /"event_id":"([^"]+)"/;
const EventId = z.uuid();

// True for a line written for this event id, found without a parse.
function holdsId(eventId: string): (text: string) => boolean {
  const needle = `"event_id":"${eventId}"`;
  return (text) => text.includes(needle);
}

// True for a line that is a valid event with the acked event id.
function holdsEvent(acked: LogPosition): (text: string) => boolean {
  return (text) =>
    text.includes(acked.eventId) && parseLine(text)?.event_id === acked.eventId;
}

// The byte offset just after the acked line of its day file, or null when
// the file has no such line. The stored offset is used when the line there
// holds the acked event, else the file is scanned for it.
async function resumeAt(
  path: string,
  acked: LogPosition,
  holds: (text: string) => boolean,
): Promise<number | null> {
  if (acked.offset !== undefined) {
    for await (const line of readLines(path, acked.offset)) {
      if (!line.partial && holds(line.text)) return line.end;
      break;
    }
  }
  for await (const line of readLines(path, 0)) {
    if (!line.partial && holds(line.text)) return line.end;
  }
  return null;
}

// Non empty lines that end in a newline, from byte start on, left out the
// lines of a type never sent. A partial trailing line from a crash mid write
// is not an event yet.
async function completeLines(path: string, start: number): Promise<number> {
  let count = 0;
  for await (const line of readLines(path, start)) {
    if (!line.partial && line.text.length > 0 && !holdsUnsent(line.text)) {
      count++;
    }
  }
  return count;
}

// appendEvent writes the type as "type":"<type>", and no payload has a type
// field, so this finds a line of a type never sent without a parse.
const UNSENT_NEEDLES = UNSENT_TYPES.map((type) => `"type":"${type}"`);

function holdsUnsent(text: string): boolean {
  return UNSENT_NEEDLES.some((needle) => text.includes(needle));
}

// Day files in name order, which is append order. Other files are ignored.
async function listDayFiles(p: Paths): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(p.log);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => DAY_FILE.test(name)).sort();
}

// The valid events of one day file from byte start on. A partial trailing
// line from a crash mid write and any line that fails validation are skipped
// with a warning naming the file.
async function* fileEntries(
  path: string,
  start: number,
  warn: (text: string) => void,
): AsyncGenerator<PendingEntry> {
  const file = basename(path);
  let invalid = 0;
  try {
    for await (const line of readLines(path, start)) {
      if (line.partial) {
        warn(`warning: skipped a partial trailing line in ${path}`);
        continue;
      }
      if (line.text.length === 0) continue;
      const event = parseLine(line.text);
      if (!event) {
        invalid++;
        continue;
      }
      yield {
        event,
        position: { file, eventId: event.event_id, offset: line.offset },
      };
    }
  } finally {
    if (invalid > 0) {
      warn(
        `warning: skipped ${invalid} invalid line${invalid === 1 ? '' : 's'} in ${path}`,
      );
    }
  }
}

type Line = {
  // Byte offsets of the line's first byte and of the byte after its newline.
  offset: number;
  end: number;
  text: string;
  // True for text after the last newline, which only a crash mid write
  // leaves.
  partial: boolean;
};

// The lines of a file from byte start on, read a chunk at a time, so a
// caller that stops early reads no further. Nothing when the file is
// missing.
async function* readLines(path: string, start: number): AsyncGenerator<Line> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let rest = Buffer.alloc(0);
    let restAt = start;
    let position = start;
    for (;;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        READ_CHUNK_BYTES,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const buf =
        rest.length > 0
          ? Buffer.concat([rest, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const newline = buf.indexOf(0x0a, from);
        if (newline === -1) break;
        yield {
          offset: restAt + from,
          end: restAt + newline + 1,
          text: buf.toString('utf8', from, newline),
          partial: false,
        };
        from = newline + 1;
      }
      // A copy, since chunk is read into again.
      rest = Buffer.from(buf.subarray(from));
      restAt += from;
    }
    if (rest.length > 0) {
      yield {
        offset: restAt,
        end: restAt + rest.length,
        text: rest.toString('utf8'),
        partial: true,
      };
    }
  } finally {
    await handle.close();
  }
}

function parseLine(line: string): Event | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return null;
  }
  const { v, ...rest } = json as Record<string, unknown>;
  if (v !== LOG_LINE_VERSION) return null;
  const result = Event.safeParse(rest);
  return result.success ? result.data : null;
}
