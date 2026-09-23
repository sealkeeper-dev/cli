// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Event } from '@vouched-dev/schema';
import { z } from 'zod';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { stderr } from './output.js';

// The local event log. Append-only JSONL, one file per UTC day under
// paths().log, named YYYY-MM-DD.jsonl after the day the line was appended, not
// the event's occurred_at. So file name order is append order, and an event
// that arrives late still lands after the cursor. Each line is
// {v: 1, ...event}. Nothing here signs, sends or deletes anything.

export const LOG_LINE_VERSION = 1;
export const CURSOR_VERSION = 1;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// A place in the log. file is the day file's name, not a full path, so the
// cursor stays valid if the home directory moves.
export const LogPosition = z.strictObject({
  file: z.string().regex(DAY_FILE),
  eventId: z.uuid(),
});
export type LogPosition = z.infer<typeof LogPosition>;

// lastSyncAt is when sync last had a batch accepted. It is optional so a
// cursor written before it existed still parses.
export const Cursor = z.strictObject({
  v: z.literal(CURSOR_VERSION),
  lastAcked: LogPosition.nullable(),
  lastSyncAt: z.iso.datetime({ offset: true }).optional(),
});
export type Cursor = z.infer<typeof Cursor>;

export class CursorError extends Error {
  override name = 'CursorError';
}

export type Pending = {
  events: Event[];
  // The position of each event in events, so a caller can ack part of them.
  positions: LogPosition[];
  // Position of the last event returned, or null when nothing is pending.
  last: LogPosition | null;
};

type Entry = { file: string; event: Event };

// The UTC day of a moment, as YYYY-MM-DD.
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// Validates the event, then appends one line to the file for the day it is
// appended (now, which tests can set) with a single write. No fsync, so emit stays fast. The file is opened read and write so
// the last byte can be checked. If an earlier crash left a partial line with
// no trailing newline, the new line starts on a fresh line and is not lost.
export async function appendEvent(
  input: unknown,
  p: Paths = paths(),
  now: Date = new Date(),
): Promise<Event> {
  const event = Event.parse(input);
  await mkdir(p.log, { recursive: true, mode: 0o700 });

  const file = await open(
    p.logFile(dayOf(now)),
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
  const result = Cursor.safeParse(json);
  if (!result.success) {
    throw new CursorError(
      `Invalid cursor at ${p.cursor}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export async function writeCursor(
  input: Cursor,
  p: Paths = paths(),
): Promise<Cursor> {
  const cursor = Cursor.parse(input);
  await ensureHome(p);
  await writeFileAtomic(p.cursor, `${JSON.stringify(cursor)}\n`);
  return cursor;
}

// Events after the cursor in file order then line order, up to limit.
export async function readPending(
  limit: number,
  p: Paths = paths(),
): Promise<Pending> {
  const events: Event[] = [];
  const positions: LogPosition[] = [];
  if (limit <= 0) return { events, positions, last: null };

  for await (const entry of pendingEntries(p)) {
    events.push(entry.event);
    positions.push({ file: entry.file, eventId: entry.event.event_id });
    if (events.length >= limit) break;
  }
  return { events, positions, last: positions.at(-1) ?? null };
}

export async function countPending(p: Paths = paths()): Promise<number> {
  let count = 0;
  for await (const _ of pendingEntries(p)) count++;
  return count;
}

// The events appended on one UTC day, in line order. An empty list when the
// day has no file.
export async function readDay(
  date: string,
  p: Paths = paths(),
): Promise<Event[]> {
  const file = p.logFile(Day.parse(date));
  return (await readLogFile(file)).map((entry) => entry.event);
}

async function* pendingEntries(p: Paths): AsyncGenerator<Entry> {
  const { lastAcked } = await readCursor(p);
  for (const name of await listDayFiles(p)) {
    if (lastAcked && name < lastAcked.file) continue;
    const entries = await readLogFile(p.logFile(name.slice(0, 10)));

    let start = 0;
    if (lastAcked && name === lastAcked.file) {
      const index = entries.findIndex(
        (entry) => entry.event.event_id === lastAcked.eventId,
      );
      // The acked event is missing from its file. Sending the whole file again
      // is safe because the API treats a repeated event_id as a no-op.
      if (index === -1) {
        stderr(
          `warning: acked event ${lastAcked.eventId} not found in ${name}, resending that day`,
        );
      }
      start = index + 1;
    }
    for (let i = start; i < entries.length; i++) yield entries[i] as Entry;
  }
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

// Reads one day file. A partial trailing line from a crash mid write and any
// line that fails validation are skipped with a warning naming the file.
async function readLogFile(path: string): Promise<Entry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const file = basename(path);
  const lines = raw.split('\n');
  // The text after the last newline is empty for a well formed file.
  const tail = lines.pop();
  if (tail !== undefined && tail.length > 0) {
    stderr(`warning: skipped a partial trailing line in ${path}`);
  }

  const entries: Entry[] = [];
  let invalid = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    const event = parseLine(line);
    if (event) entries.push({ file, event });
    else invalid++;
  }
  if (invalid > 0) {
    stderr(
      `warning: skipped ${invalid} invalid line${invalid === 1 ? '' : 's'} in ${path}`,
    );
  }
  return entries;
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
