// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_MAX_AGE_DAYS, type Event } from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Paths, paths } from './config.js';
import { resetInvocation } from './invocation.js';
import { appendEvent } from './log.js';
import { writeModelSet } from './model-name.js';
import {
  besideText,
  PREVIEW_SAMPLE,
  previewLines,
  readPreview,
  summaryLines,
} from './preview.js';
import { WIRE_FORM } from './taxonomy.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;

function sessionEnd(at: Date): Event {
  return {
    event_id: randomUUID(),
    type: 'session.end',
    occurred_at: at.toISOString(),
    version: '1.0.0',
    payload: { session_id: 's1', duration_ms: 1 },
  };
}

function sessionStart(at: Date): Event {
  return {
    event_id: randomUUID(),
    type: 'session.start',
    occurred_at: at.toISOString(),
    version: '1.0.0',
    payload: { session_id: 's1' },
  };
}

describe('sync preview', () => {
  let home: string;
  let p: Paths;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-preview-'));
    p = paths(home);
    vi.stubEnv('SEALKEEPER_INVOCATION', 'npx sealkeeper');
    resetInvocation();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetInvocation();
    await rm(home, { recursive: true, force: true });
  });

  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const append = (e: Event, at: Date = NOW) => appendEvent(e, p, at);

  it('leaves out events older than the window and does not count them', async () => {
    const stale = sessionEnd(ago((EVENT_MAX_AGE_DAYS + 1) * DAY_MS));
    // Appended late, so it sits in today's file between fresh ones.
    const a = sessionEnd(NOW);
    await append(a);
    await append(stale);
    const b = sessionStart(NOW);
    await append(b);
    // Just inside the window and its margin, so the API decides.
    const edge = sessionEnd(ago(EVENT_MAX_AGE_DAYS * DAY_MS + 60_000));
    await append(edge);

    const preview = await readPreview(p, { now: NOW, full: true });
    expect(preview.count).toBe(3);
    expect(preview.stale).toBe(1);
    expect(preview.groups.flatMap((g) => g.events)).toEqual([a, b, edge]);
    expect(preview.sample).toEqual([a, b, edge]);
    expect(preview.last?.eventId).toBe(edge.event_id);
  });

  it('points last at a stale event after the fresh ones, so the send drops it', async () => {
    const fresh = sessionEnd(NOW);
    await append(fresh);
    const stale = sessionEnd(ago(30 * DAY_MS));
    await append(stale);
    const preview = await readPreview(p, { now: NOW });
    expect(preview.count).toBe(1);
    expect(preview.last?.eventId).toBe(stale.event_id);
  });

  it('counts nothing when every pending event is stale, and says how many it drops', async () => {
    await append(sessionEnd(ago(20 * DAY_MS)));
    const preview = await readPreview(p, { now: NOW });
    expect(preview.count).toBe(0);
    expect(preview.stale).toBe(1);
    expect(summaryLines(preview, p)).toEqual([
      'nothing pending, nothing to send',
      `1 event older than ${EVENT_MAX_AGE_DAYS} days is left out, sync drops it without sending.`,
    ]);
  });

  it('counts stale events apart in the summary and in --dry-run', async () => {
    const fresh = sessionEnd(NOW);
    await append(fresh);
    await append(sessionEnd(ago(20 * DAY_MS)));
    await append(sessionEnd(ago(30 * DAY_MS)));
    const summary = summaryLines(await readPreview(p, { now: NOW }), p);
    expect(summary.at(-3)).toBe(
      `1 event pending, nothing sent yet. 2 events older than ${EVENT_MAX_AGE_DAYS} days are left out, sync drops them without sending.`,
    );
    const full = previewLines(
      await readPreview(p, { now: NOW, full: true }),
      p,
    );
    expect(full).toEqual([
      p.logFile('2026-09-24'),
      JSON.stringify(fresh),
      '',
      `1 event pending, nothing sent yet. 2 events older than ${EVENT_MAX_AGE_DAYS} days are left out, sync drops them without sending.`,
      WIRE_FORM,
      besideText(null),
    ]);
  });

  it('summarises by day and type with a small sample, and keeps no full list', async () => {
    const yesterday = ago(DAY_MS);
    const day1 = [sessionStart(yesterday), sessionEnd(yesterday)];
    for (const e of day1) await append(e, yesterday);
    const day2 = [sessionEnd(NOW), sessionEnd(NOW), sessionStart(NOW)];
    for (const e of day2) await append(e);

    const preview = await readPreview(p, { now: NOW });
    expect(preview.count).toBe(5);
    expect(preview.groups).toEqual([]);
    expect(preview.sample).toHaveLength(PREVIEW_SAMPLE);
    expect(preview.days).toEqual([
      {
        file: '2026-09-23.jsonl',
        count: 2,
        types: [
          ['session.start', 1],
          ['session.end', 1],
        ],
      },
      {
        file: '2026-09-24.jsonl',
        count: 3,
        types: [
          ['session.end', 2],
          ['session.start', 1],
        ],
      },
    ]);

    expect(summaryLines(preview, p)).toEqual([
      `pending events by day, in ${p.log}`,
      '  2026-09-23  2 events  session.start 1, session.end 1',
      '  2026-09-24  3 events  session.end 2, session.start 1',
      '',
      'the first 3 of 5, as sent',
      ...[...day1, ...day2].slice(0, 3).map((e) => JSON.stringify(e)),
      '',
      'run npx sealkeeper sync --dry-run to see every event',
      '',
      '5 events pending, nothing sent yet. Events older than 7 days are not sent.',
      WIRE_FORM,
      besideText(null),
    ]);
  });

  it('shows every event in the summary when there are only a few', async () => {
    const e = sessionEnd(NOW);
    await append(e);
    const lines = summaryLines(await readPreview(p, { now: NOW }), p);
    expect(lines).toEqual([
      `pending events by day, in ${p.log}`,
      '  2026-09-24  1 event  session.end 1',
      '',
      'as sent',
      JSON.stringify(e),
      '',
      '1 event pending, nothing sent yet. Events older than 7 days are not sent.',
      WIRE_FORM,
      besideText(null),
    ]);
  });

  it('names the model name that goes beside the events, as text', async () => {
    await append(sessionEnd(NOW));
    await writeModelSet('gpt-4.1', p);
    const preview = await readPreview(p, { now: NOW });
    expect(preview.model).toBe('gpt-4.1');
    const line =
      "Beside them go the agent's fingerprint, SHA-256 hashes only, and the model name gpt-4.1, as text.";
    expect(summaryLines(preview, p).at(-1)).toBe(line);
    expect(
      previewLines(await readPreview(p, { now: NOW, full: true }), p).at(-1),
    ).toBe(line);
  });

  it('prints every event for --dry-run', async () => {
    const all = Array.from({ length: 5 }, () => sessionEnd(NOW));
    for (const e of all) await append(e);
    const preview = await readPreview(p, { now: NOW, full: true });
    expect(previewLines(preview, p)).toEqual([
      p.logFile('2026-09-24'),
      ...all.map((e) => JSON.stringify(e)),
      '',
      '5 events pending, nothing sent yet.',
      WIRE_FORM,
      besideText(null),
    ]);
  });
});
