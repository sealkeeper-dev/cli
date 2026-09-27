// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_MAX_AGE_DAYS, type Event } from '@sealkeeper/schema';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { paths } from './config.js';
import {
  appendEvent,
  CursorError,
  countPending,
  countPendingLines,
  LOG_RETENTION_DAYS,
  pendingEvents,
  pruneLog,
  readCursor,
  readDay,
  readPending,
  skipStaleDays,
  writeCursor,
} from './log.js';

const DAY1 = '2026-09-22';
const DAY2 = '2026-09-23';
// Every test runs on this day, so which day files are too old to send does
// not depend on when the suite runs.
const TODAY = '2026-09-24';
const DAY_MS = 24 * 3600 * 1000;

// The UTC day n days before TODAY.
function daysBefore(n: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function event(day: string, n: number): Event {
  const seconds = String(n % 60).padStart(2, '0');
  return {
    event_id: randomUUID(),
    type: 'tool.call',
    occurred_at: `${day}T10:00:${seconds}.000Z`,
    version: '1.0.0',
    payload: { tool: 'Bash', duration_ms: n, ok: true },
  };
}

// Appends as if on the given UTC day, which names the file. It defaults to
// the event's own day so most tests read naturally.
function append(e: unknown, day = (e as Event).occurred_at.slice(0, 10)) {
  return appendEvent(e, paths(), new Date(`${day}T12:00:00.000Z`));
}

function ids(events: Event[]): string[] {
  return events.map((e) => e.event_id);
}

describe('log', () => {
  let root: string;
  let previousHome: string | undefined;
  let warn: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-log-'));
    previousHome = process.env.SEALKEEPER_HOME;
    process.env.SEALKEEPER_HOME = join(root, 'home');
    warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T12:00:00Z`) });
  });

  afterEach(async () => {
    vi.useRealTimers();
    warn.mockRestore();
    if (previousHome === undefined) delete process.env.SEALKEEPER_HOME;
    else process.env.SEALKEEPER_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  function warnings(): string[] {
    return warn.mock.calls.map((call) => String(call[0]));
  }

  async function seedTwoDays(): Promise<{ day1: Event[]; day2: Event[] }> {
    const day1 = [event(DAY1, 1), event(DAY1, 2), event(DAY1, 3)];
    const day2 = [event(DAY2, 4), event(DAY2, 5)];
    for (const e of [...day1, ...day2]) await append(e);
    return { day1, day2 };
  }

  it('writes one line to the day file with mode 600 in a 700 directory', async () => {
    const p = paths();
    const e = event(DAY2, 1);
    await append(e);

    expect((await stat(p.log)).mode & 0o777).toBe(0o700);
    expect((await stat(p.logFile(DAY2))).mode & 0o777).toBe(0o600);
    const raw = await readFile(p.logFile(DAY2), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n')).toHaveLength(2);
    expect(JSON.parse(raw)).toEqual({ v: 1, ...e });
  });

  it('rejects an invalid event and writes nothing', async () => {
    await expect(
      append({ ...event(DAY2, 1), payload: { prompt: 'secret' } }),
    ).rejects.toThrow();
    expect(await countPending()).toBe(0);
  });

  it('names the file after the append day, not occurred_at', async () => {
    const e = event(DAY1, 1);
    await appendEvent(e);
    const today = new Date().toISOString().slice(0, 10);
    expect(await readdir(paths().log)).toEqual([`${today}.jsonl`]);
    expect(ids(await readDay(today))).toEqual([e.event_id]);
  });

  it('returns a late event appended after the cursor moved on', async () => {
    const onTime = event(DAY2, 1);
    await append(onTime, DAY2);
    await writeCursor({
      v: 1,
      lastAcked: { file: `${DAY2}.jsonl`, eventId: onTime.event_id },
    });
    // Happened on day one, reported on day three.
    const late = event(DAY1, 2);
    await append(late, '2026-09-24');
    expect(ids((await readPending(10)).events)).toEqual([late.event_id]);
  });

  it('puts appends on different days in different files', async () => {
    await append(event(DAY1, 1));
    await append(event(DAY2, 2));
    expect((await readdir(paths().log)).sort()).toEqual([
      `${DAY1}.jsonl`,
      `${DAY2}.jsonl`,
    ]);
  });

  it('returns everything in file then line order with no cursor', async () => {
    const { day1, day2 } = await seedTwoDays();
    const pending = await readPending(100);
    expect(ids(pending.events)).toEqual(ids([...day1, ...day2]));
    expect(pending.last).toMatchObject({
      file: `${DAY2}.jsonl`,
      eventId: day2[1]?.event_id,
    });
  });

  it('returns only later events after the cursor moves', async () => {
    const { day1, day2 } = await seedTwoDays();
    await writeCursor({
      v: 1,
      lastAcked: { file: `${DAY1}.jsonl`, eventId: day1[2]?.event_id ?? '' },
    });
    expect((await readCursor()).lastAcked?.file).toBe(`${DAY1}.jsonl`);
    expect(ids((await readPending(100)).events)).toEqual(ids(day2));
    expect(await countPending()).toBe(2);
  });

  it('honours limit and points last at the last returned event', async () => {
    const { day1, day2 } = await seedTwoDays();
    const first = await readPending(2);
    expect(ids(first.events)).toEqual(ids(day1.slice(0, 2)));
    expect(first.last).toMatchObject({
      file: `${DAY1}.jsonl`,
      eventId: day1[1]?.event_id,
    });

    if (!first.last) throw new Error('expected a position');
    await writeCursor({ v: 1, lastAcked: first.last });
    const second = await readPending(2);
    expect(ids(second.events)).toEqual(ids([day1[2], day2[0]] as Event[]));
    expect(second.last).toMatchObject({
      file: `${DAY2}.jsonl`,
      eventId: day2[0]?.event_id,
    });
  });

  it('returns nothing and a null position when all is acked', async () => {
    const { day2 } = await seedTwoDays();
    await writeCursor({
      v: 1,
      lastAcked: { file: `${DAY2}.jsonl`, eventId: day2[1]?.event_id ?? '' },
    });
    expect(await readPending(10)).toEqual({
      events: [],
      positions: [],
      last: null,
    });
    expect(await countPending()).toBe(0);
  });

  it('skips a partial trailing line with one warning', async () => {
    const good = [event(DAY2, 1), event(DAY2, 2)];
    for (const e of good) await append(e);
    const file = paths().logFile(DAY2);
    await appendFile(file, '{"v":1,"event_id":"0199');

    const pending = await readPending(10);
    expect(ids(pending.events)).toEqual(ids(good));
    const partial = warnings().filter((w) => w.includes('partial'));
    expect(partial).toHaveLength(1);
    expect(partial[0]).toContain(file);
  });

  it('starts a fresh line when appending after a partial line', async () => {
    const first = event(DAY2, 1);
    await append(first);
    await appendFile(paths().logFile(DAY2), '{"v":1,"eve');
    const next = event(DAY2, 2);
    await append(next);

    expect(ids(await readDay(DAY2))).toEqual(ids([first, next]));
    expect(warnings().filter((w) => w.includes('1 invalid line'))).toHaveLength(
      1,
    );
  });

  it('skips an invalid line with a warning', async () => {
    const a = event(DAY2, 1);
    const b = event(DAY2, 2);
    await append(a);
    const file = paths().logFile(DAY2);
    await appendFile(
      file,
      `${JSON.stringify({ v: 1, ...event(DAY2, 9), type: 'nope' })}\n`,
    );
    await append(b);

    expect(ids((await readPending(10)).events)).toEqual(ids([a, b]));
    const invalid = warnings().filter((w) => w.includes('invalid'));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain(file);
    expect(await countPending()).toBe(2);
  });

  it('counts pending events', async () => {
    expect(await countPending()).toBe(0);
    await seedTwoDays();
    expect(await countPending()).toBe(5);
  });

  it('counts pending lines from the cursor without parsing them', async () => {
    expect(await countPendingLines()).toBe(0);
    const { day1 } = await seedTwoDays();
    expect(await countPendingLines()).toBe(5);
    await writeCursor({
      v: 1,
      lastAcked: { file: `${DAY1}.jsonl`, eventId: day1[1]?.event_id ?? '' },
    });
    expect(await countPendingLines()).toBe(3);
    expect(await countPendingLines()).toBe(await countPending());
    // A file before the cursor's day is never opened, even when it is not
    // a log at all.
    await writeCursor({
      v: 1,
      lastAcked: { file: `${DAY2}.jsonl`, eventId: randomUUID() },
    });
    await writeFile(paths().logFile(DAY1), 'not json\n');
    expect(await countPendingLines()).toBe(2);
  });

  it('counts pending lines without a JSON parse', async () => {
    await seedTwoDays();
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(await countPendingLines()).toBe(5);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('does not count a partial trailing line', async () => {
    await seedTwoDays();
    await writeFile(paths().logFile(DAY2), '{"v":1', { flag: 'a' });
    expect(await countPendingLines()).toBe(5);
  });

  it('reads one day', async () => {
    const { day1 } = await seedTwoDays();
    expect(ids(await readDay(DAY1))).toEqual(ids(day1));
    expect(await readDay('2026-01-01')).toEqual([]);
    await expect(readDay('../x')).rejects.toThrow();
  });

  it('returns an empty cursor when none exists and rejects a bad one', async () => {
    expect(await readCursor()).toEqual({ v: 1, lastAcked: null });
    await writeCursor({ v: 1, lastAcked: null });
    expect((await stat(paths().cursor)).mode & 0o777).toBe(0o600);
    await writeFile(paths().cursor, '{ nope');
    await expect(readCursor()).rejects.toThrow(CursorError);
  });

  it('resends the acked day when the acked event is missing', async () => {
    const { day1, day2 } = await seedTwoDays();
    await writeCursor({
      v: 1,
      lastAcked: { file: `${DAY1}.jsonl`, eventId: randomUUID() },
    });
    expect(ids((await readPending(100)).events)).toEqual(
      ids([...day1, ...day2]),
    );
    expect(warnings().some((w) => w.includes('not found'))).toBe(true);
  });

  it('returns a thousand appends in order', async () => {
    const all = Array.from({ length: 1000 }, (_, n) => event(DAY2, n));
    for (const e of all) await append(e);
    const pending = await readPending(1000);
    expect(ids(pending.events)).toEqual(ids(all));
    expect(pending.last?.eventId).toBe(all[999]?.event_id);
    // A thousand file appends, slow on a busy machine.
  }, 30_000);

  describe('day files and the clock (VOU-220)', () => {
    it('appends to the newest day file when the clock is behind it', async () => {
      const ahead = '2026-09-27';
      // Written by an earlier process while the clock was three days ahead.
      await mkdir(paths().log, { recursive: true });
      await writeFile(
        paths().logFile(ahead),
        `${JSON.stringify({ v: 1, ...event(ahead, 1) })}\n`,
      );
      const later = event(TODAY, 2);
      await append(later, TODAY);
      expect(await readdir(paths().log)).toEqual([`${ahead}.jsonl`]);
      expect(ids(await readDay(ahead))).toContain(later.event_id);
    });

    it('appends to the newest day file after a step back across midnight', async () => {
      const before = event(DAY2, 1);
      await appendEvent(before, paths(), new Date(`${TODAY}T00:00:30.000Z`));
      const after = event(DAY2, 2);
      await appendEvent(after, paths(), new Date(`${DAY2}T23:59:50.000Z`));
      expect(await readdir(paths().log)).toEqual([`${TODAY}.jsonl`]);
      expect(ids(await readDay(TODAY))).toEqual(ids([before, after]));
    });

    it('still reads new events when the cursor is in a future day file', async () => {
      const ahead = '2026-09-27';
      const refused = event(ahead, 1);
      await append(refused, ahead);
      const first = await readPending(10);
      if (!first.last) throw new Error('expected a position');
      // sync skipped the event the API refused as future.
      await writeCursor({ v: 1, lastAcked: first.last });
      expect(await countPending()).toBe(0);

      // The clock is fixed and new events come in.
      const fresh = [event(TODAY, 2), event(TODAY, 3)];
      for (const e of fresh) await append(e, TODAY);
      expect(ids((await readPending(10)).events)).toEqual(ids(fresh));
      expect(await countPending()).toBe(2);
      expect(await countPendingLines()).toBe(2);
    });

    it('sees a newer day file another process wrote once the cache is old', async () => {
      const ahead = '2026-09-27';
      const at = (minutes: number) =>
        new Date(Date.parse(`${TODAY}T12:00:00.000Z`) + minutes * 60_000);
      const first = event(TODAY, 1);
      await appendEvent(first, paths(), at(0));
      // Another process, its clock ahead, wrote a future day file.
      await writeFile(
        paths().logFile(ahead),
        `${JSON.stringify({ v: 1, ...event(ahead, 2) })}\n`,
      );
      const soon = event(TODAY, 3);
      await appendEvent(soon, paths(), at(5));
      const later = event(TODAY, 4);
      await appendEvent(later, paths(), at(11));
      expect(ids(await readDay(TODAY))).toEqual(ids([first, soon]));
      expect(ids(await readDay(ahead))).toContain(later.event_id);
    });

    it('starts a new day file once the real date passes the newest one', async () => {
      await append(event(DAY1, 1), DAY2);
      await append(event(DAY1, 2), DAY1);
      await append(event(TODAY, 3), TODAY);
      expect((await readdir(paths().log)).sort()).toEqual([
        `${DAY2}.jsonl`,
        `${TODAY}.jsonl`,
      ]);
    });
  });

  describe('old day files (VOU-221)', () => {
    // The newest day whose file is still read, and the one before it.
    const lastLive = daysBefore(EVENT_MAX_AGE_DAYS + 1);
    const firstStale = daysBefore(EVENT_MAX_AGE_DAYS + 2);

    it('leaves day files too old to send out of every read without opening them', async () => {
      const old = event(firstStale, 1);
      await append(old);
      const kept = event(lastLive, 2);
      await append(kept);
      const fresh = event(TODAY, 3);
      await append(fresh);

      expect(ids((await readPending(10)).events)).toEqual(ids([kept, fresh]));
      expect(await countPending()).toBe(2);
      expect(await countPendingLines()).toBe(2);
      // Not a log at all, and never read, so no warning.
      await writeFile(paths().logFile(firstStale), 'not json\n');
      expect(await countPending()).toBe(2);
      expect(warnings()).toEqual([]);
    });

    it('moves the cursor past old day files and counts their lines once', async () => {
      const cursor = {
        v: 1 as const,
        lastAcked: null,
        lastSyncAt: '2026-09-01T00:00:00.000Z',
      };
      await writeCursor(cursor);
      const oldest = daysBefore(40);
      await append(event(oldest, 1));
      await append(event(oldest, 2));
      const stale = [event(firstStale, 3), event(firstStale, 4)];
      for (const e of stale) await append(e);
      const fresh = event(TODAY, 5);
      await append(fresh);

      expect(await skipStaleDays()).toBe(4);
      const after = await readCursor();
      expect(after.lastSyncAt).toBe(cursor.lastSyncAt);
      expect(after.lastAcked).toMatchObject({
        file: `${firstStale}.jsonl`,
        eventId: stale[1]?.event_id,
      });
      expect(await skipStaleDays()).toBe(0);
      expect(ids((await readPending(10)).events)).toEqual(ids([fresh]));
    });

    it('counts only the lines after the cursor in an old day file', async () => {
      const stale = [
        event(firstStale, 1),
        event(firstStale, 2),
        event(firstStale, 3),
      ];
      for (const e of stale) await append(e);
      const first = await readPending(1, paths(), {
        now: new Date(`${firstStale}T12:00:00.000Z`),
      });
      if (!first.last) throw new Error('expected a position');
      await writeCursor({ v: 1, lastAcked: first.last });
      expect(await skipStaleDays()).toBe(2);
    });

    it('leaves the cursor alone when nothing is old', async () => {
      await seedTwoDays();
      expect(await skipStaleDays()).toBe(0);
      expect((await readCursor()).lastAcked).toBeNull();
    });

    it('deletes day files older than the retention wholly behind the cursor', async () => {
      const old = daysBefore(LOG_RETENTION_DAYS + 5);
      const edge = daysBefore(LOG_RETENTION_DAYS);
      const recent = daysBefore(LOG_RETENTION_DAYS - 1);
      for (const day of [old, edge, recent]) await append(event(day, 1));
      const fresh = event(TODAY, 2);
      await append(fresh);

      // Nothing goes before a sync moved the cursor.
      expect(await pruneLog()).toEqual([]);

      await skipStaleDays();
      // The cursor is at the end of recent, which is kept with its file.
      expect(await pruneLog()).toEqual([`${old}.jsonl`]);
      expect((await readdir(paths().log)).sort()).toEqual([
        `${edge}.jsonl`,
        `${recent}.jsonl`,
        `${TODAY}.jsonl`,
      ]);
      expect(ids((await readPending(10)).events)).toEqual(ids([fresh]));
    });

    it('never deletes the cursor day file or one after it, however old', async () => {
      const old = daysBefore(LOG_RETENTION_DAYS + 5);
      const e = event(old, 1);
      await append(e);
      await writeCursor({
        v: 1,
        lastAcked: { file: `${old}.jsonl`, eventId: e.event_id },
      });
      expect(await pruneLog()).toEqual([]);
      expect(await readdir(paths().log)).toEqual([`${old}.jsonl`]);
    });
  });

  describe('the cursor offset (VOU-221)', () => {
    async function seedMany(n: number): Promise<Event[]> {
      const all = Array.from({ length: n }, (_, i) => event(TODAY, i));
      // One write, not n appends, to keep the test quick.
      await append(all[0]);
      await appendFile(
        paths().logFile(TODAY),
        all
          .slice(1)
          .map((e) => `${JSON.stringify({ v: 1, ...e })}\n`)
          .join(''),
      );
      return all;
    }

    it('stores the byte offset of each line', async () => {
      const all = await seedMany(3);
      const raw = await readFile(paths().logFile(TODAY));
      const pending = await readPending(10);
      for (const [i, position] of pending.positions.entries()) {
        const at = raw.indexOf(`{"v":1,"event_id":"${all[i]?.event_id}"`);
        expect(position.offset).toBe(at);
      }
    });

    it('resumes at the offset without parsing the lines before it', async () => {
      const all = await seedMany(300);
      const acked = (await readPending(298)).last;
      if (!acked?.offset) throw new Error('expected an offset');
      await writeCursor({ v: 1, lastAcked: acked });

      const parse = vi.spyOn(JSON, 'parse');
      try {
        const pending = await readPending(10);
        expect(ids(pending.events)).toEqual(ids(all.slice(298)));
        // cursor.json, cursor-offset.json, the acked line and the two after
        // it.
        expect(parse).toHaveBeenCalledTimes(5);
      } finally {
        parse.mockRestore();
      }
    });

    it('resumes at the offset without reading the bytes before it', async () => {
      const all = await seedMany(5);
      const acked = (await readPending(3)).last;
      if (!acked?.offset) throw new Error('expected an offset');
      await writeCursor({ v: 1, lastAcked: acked });

      // Everything before the acked line turns to junk of the same length.
      const file = paths().logFile(TODAY);
      const raw = await readFile(file);
      raw.fill(0x78, 0, acked.offset - 1);
      await writeFile(file, raw);

      expect(ids((await readPending(10)).events)).toEqual(ids(all.slice(3)));
      expect(await countPendingLines()).toBe(2);
      expect(warnings()).toEqual([]);
    });

    it('falls back to a scan when the offset does not hold the acked event', async () => {
      const all = await seedMany(5);
      const acked = (await readPending(3)).last;
      if (!acked) throw new Error('expected a position');
      for (const offset of [0, 7, (acked.offset ?? 0) + 1, 1_000_000]) {
        await writeCursor({ v: 1, lastAcked: { ...acked, offset } });
        expect(ids((await readPending(10)).events)).toEqual(ids(all.slice(3)));
        expect(await countPending()).toBe(2);
        expect(await countPendingLines()).toBe(2);
      }
      expect(warnings()).toEqual([]);
    });

    it('reads a cursor written before the offset existed', async () => {
      const all = await seedMany(5);
      await writeCursor({
        v: 1,
        lastAcked: { file: `${TODAY}.jsonl`, eventId: all[2]?.event_id ?? '' },
      });
      expect(ids((await readPending(10)).events)).toEqual(ids(all.slice(3)));
    });

    it('keeps the offset out of cursor.json, in the shape CLI 0.4.6 reads', async () => {
      const all = await seedMany(5);
      const acked = (await readPending(3)).last;
      if (acked?.offset === undefined) throw new Error('expected an offset');
      await writeCursor({ v: 1, lastAcked: acked });

      const stored = JSON.parse(await readFile(paths().cursor, 'utf8'));
      expect(stored).toEqual({
        v: 1,
        lastAcked: { file: `${TODAY}.jsonl`, eventId: all[2]?.event_id },
      });
      expect(JSON.parse(await readFile(paths().cursorOffset, 'utf8'))).toEqual({
        ...acked,
      });
      expect((await readCursor()).lastAcked).toEqual(acked);

      // A cursor with no offset removes the file.
      await writeCursor({
        v: 1,
        lastAcked: { file: acked.file, eventId: acked.eventId },
      });
      await expect(stat(paths().cursorOffset)).rejects.toThrow();
    });

    it('still refuses a cursor.json with a key it does not know', async () => {
      const all = await seedMany(1);
      await writeFile(
        paths().cursor,
        JSON.stringify({
          v: 1,
          lastAcked: {
            file: `${TODAY}.jsonl`,
            eventId: all[0]?.event_id,
            offset: 0,
          },
        }),
      );
      await expect(readCursor()).rejects.toThrow(CursorError);
    });

    it('ignores an offset that belongs to another cursor, as after an older CLI synced', async () => {
      const all = await seedMany(5);
      const acked = (await readPending(2)).last;
      if (!acked) throw new Error('expected a position');
      await writeCursor({ v: 1, lastAcked: acked });

      // An older CLI moves cursor.json on and leaves cursor-offset.json.
      const later = { file: `${TODAY}.jsonl`, eventId: all[3]?.event_id ?? '' };
      await writeFile(
        paths().cursor,
        JSON.stringify({ v: 1, lastAcked: later }),
      );
      expect((await readCursor()).lastAcked).toEqual(later);
      expect(ids((await readPending(10)).events)).toEqual(ids(all.slice(4)));
      expect(await countPendingLines()).toBe(1);
    });

    it('ignores an offset file that does not parse', async () => {
      const all = await seedMany(5);
      const acked = (await readPending(3)).last;
      if (!acked) throw new Error('expected a position');
      await writeCursor({ v: 1, lastAcked: acked });
      for (const bad of [
        'not json',
        JSON.stringify({ ...acked, offset: -1 }),
        JSON.stringify({ ...acked, offset: 1.5 }),
        JSON.stringify({ ...acked, extra: 1 }),
      ]) {
        await writeFile(paths().cursorOffset, bad);
        expect((await readCursor()).lastAcked).toEqual({
          file: acked.file,
          eventId: acked.eventId,
        });
        expect(ids((await readPending(10)).events)).toEqual(ids(all.slice(3)));
      }
      expect(warnings()).toEqual([]);
    });

    it('stops reading a file once the limit is reached', async () => {
      await seedMany(300);
      const parse = vi.spyOn(JSON, 'parse');
      try {
        await readPending(5);
        // The cursor file is missing, so only the five lines are parsed.
        expect(parse).toHaveBeenCalledTimes(5);
      } finally {
        parse.mockRestore();
      }
    });
  });

  it('sends warnings to the warn option instead of stderr', async () => {
    const a = event(DAY2, 1);
    await append(a);
    const file = paths().logFile(DAY2);
    await appendFile(file, 'not json\n');
    await appendFile(file, '{"v":1,"eve');
    await writeCursor({
      v: 1,
      lastAcked: { file: `${DAY2}.jsonl`, eventId: randomUUID() },
    });
    const seen: string[] = [];
    const options = { warn: (text: string) => seen.push(text) };
    for await (const _ of pendingEvents(paths(), options)) {
      // Read to the end.
    }
    // A count never warns.
    expect(await countPending()).toBe(1);
    expect(warnings()).toEqual([]);
    expect(seen).toHaveLength(3);
    expect(seen.join('\n')).toMatch(/not found.*partial.*1 invalid line/s);
  });
});
