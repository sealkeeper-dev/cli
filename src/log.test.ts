// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '@vouched/schema';
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
  readCursor,
  readDay,
  readPending,
  writeCursor,
} from './log.js';

const DAY1 = '2026-09-22';
const DAY2 = '2026-09-23';

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

function ids(events: Event[]): string[] {
  return events.map((e) => e.event_id);
}

describe('log', () => {
  let root: string;
  let previousHome: string | undefined;
  let warn: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vouched-log-'));
    previousHome = process.env.VOUCHED_HOME;
    process.env.VOUCHED_HOME = join(root, 'home');
    warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    warn.mockRestore();
    if (previousHome === undefined) delete process.env.VOUCHED_HOME;
    else process.env.VOUCHED_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  function warnings(): string[] {
    return warn.mock.calls.map((call) => String(call[0]));
  }

  async function seedTwoDays(): Promise<{ day1: Event[]; day2: Event[] }> {
    const day1 = [event(DAY1, 1), event(DAY1, 2), event(DAY1, 3)];
    const day2 = [event(DAY2, 4), event(DAY2, 5)];
    // Appended out of day order to show that file order wins.
    for (const e of [day2[0], day1[0], day1[1], day2[1], day1[2]]) {
      await appendEvent(e);
    }
    return { day1, day2 };
  }

  it('writes one line to the day file with mode 600 in a 700 directory', async () => {
    const p = paths();
    const e = event(DAY2, 1);
    await appendEvent(e);

    expect((await stat(p.log)).mode & 0o777).toBe(0o700);
    expect((await stat(p.logFile(DAY2))).mode & 0o777).toBe(0o600);
    const raw = await readFile(p.logFile(DAY2), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n')).toHaveLength(2);
    expect(JSON.parse(raw)).toEqual({ v: 1, ...e });
  });

  it('rejects an invalid event and writes nothing', async () => {
    await expect(
      appendEvent({ ...event(DAY2, 1), payload: { prompt: 'secret' } }),
    ).rejects.toThrow();
    expect(await countPending()).toBe(0);
  });

  it('puts events on different days in different files', async () => {
    await appendEvent(event(DAY1, 1));
    await appendEvent(event(DAY2, 2));
    expect((await readdir(paths().log)).sort()).toEqual([
      `${DAY1}.jsonl`,
      `${DAY2}.jsonl`,
    ]);
  });

  it('returns everything in file then line order with no cursor', async () => {
    const { day1, day2 } = await seedTwoDays();
    const pending = await readPending(100);
    expect(ids(pending.events)).toEqual(ids([...day1, ...day2]));
    expect(pending.last).toEqual({
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
    expect(first.last).toEqual({
      file: `${DAY1}.jsonl`,
      eventId: day1[1]?.event_id,
    });

    if (!first.last) throw new Error('expected a position');
    await writeCursor({ v: 1, lastAcked: first.last });
    const second = await readPending(2);
    expect(ids(second.events)).toEqual(ids([day1[2], day2[0]] as Event[]));
    expect(second.last).toEqual({
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
    expect(await readPending(10)).toEqual({ events: [], last: null });
    expect(await countPending()).toBe(0);
  });

  it('skips a partial trailing line with one warning', async () => {
    const good = [event(DAY2, 1), event(DAY2, 2)];
    for (const e of good) await appendEvent(e);
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
    await appendEvent(first);
    await appendFile(paths().logFile(DAY2), '{"v":1,"eve');
    const next = event(DAY2, 2);
    await appendEvent(next);

    expect(ids(await readDay(DAY2))).toEqual(ids([first, next]));
    expect(warnings().filter((w) => w.includes('1 invalid line'))).toHaveLength(
      1,
    );
  });

  it('skips an invalid line with a warning', async () => {
    const a = event(DAY2, 1);
    const b = event(DAY2, 2);
    await appendEvent(a);
    const file = paths().logFile(DAY2);
    await appendFile(
      file,
      `${JSON.stringify({ v: 1, ...event(DAY2, 9), type: 'nope' })}\n`,
    );
    await appendEvent(b);

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
    for (const e of all) await appendEvent(e);
    const pending = await readPending(1000);
    expect(ids(pending.events)).toEqual(ids(all));
    expect(pending.last?.eventId).toBe(all[999]?.event_id);
  });
});
