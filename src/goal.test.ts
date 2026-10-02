// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from './config.js';
import { loadGoal } from './goal.js';

const API_URL = 'https://api.test';
// The UTC day of the test run, so the answers' today is current.
const TODAY = new Date().toISOString().slice(0, 10);
const AGENT_ID = `${'A'.repeat(42)}A`;

const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

const answer = (over: Record<string, unknown>) => ({
  agentId: AGENT_ID,
  version: '1.0.0',
  pending: { addressed: 0, outcomes: 0 },
  asOf: '2026-09-25T10:15:00.000Z',
  ...over,
});

// A goal at none as the API answers it.
const AT_NONE = answer({
  level: 'none',
  nextLevel: 'bronze',
  // 20 verified tasks that count 13 (VOU-139).
  thresholds: [
    {
      name: 'verified_tasks',
      current: 13,
      required: 25,
      met: false,
      raw: 20,
    },
    {
      name: 'history_days',
      current: 2,
      required: 3,
      met: false,
      raw: null,
    },
    { name: 'reliability', current: 0.85, required: 0.8, met: true, raw: null },
    {
      name: 'safety_incidents_90d',
      current: 0,
      required: 0,
      met: true,
      raw: null,
    },
  ],
  actions: [
    { code: 'claim_seed_tasks', count: 12 },
    { code: 'history_days', count: 1 },
  ],
  today: { day: TODAY, counted: 14, ceiling: 20, remaining: 6 },
});

describe('loadGoal', () => {
  let home: string;
  const config = { agentId: AGENT_ID, apiUrl: API_URL, version: '1.0.0' };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-goal-load-'));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('reads the API once and the cache for fifteen minutes', async () => {
    const p = paths(home);
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return Response.json(AT_NONE);
    }) as typeof fetch;
    const now = new Date('2026-09-25T10:00:00.000Z');
    expect(await loadGoal({ config, fetch: fetchFn, now, paths: p })).toEqual(
      AT_NONE,
    );
    const later = new Date(now.getTime() + 14 * 60_000);
    expect(
      await loadGoal({ config, fetch: fetchFn, now: later, paths: p }),
    ).toEqual(AT_NONE);
    expect(calls).toBe(1);
    const stale = new Date(now.getTime() + 16 * 60_000);
    await loadGoal({ config, fetch: fetchFn, now: stale, paths: p });
    expect(calls).toBe(2);
  });

  it('never touches the network with cachedOnly', async () => {
    const p = paths(home);
    const fetchFn = vi.fn(async () => Response.json(AT_NONE));
    const now = new Date('2026-09-25T10:00:00.000Z');
    expect(
      await loadGoal({
        cachedOnly: true,
        config,
        fetch: fetchFn as unknown as typeof fetch,
        now,
        paths: p,
      }),
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    await loadGoal({
      config,
      fetch: fetchFn as unknown as typeof fetch,
      now,
      paths: p,
    });
    expect(await loadGoal({ cachedOnly: true, config, now, paths: p })).toEqual(
      AT_NONE,
    );
    // Stale is no answer when only the cache may be read.
    const stale = new Date(now.getTime() + 16 * 60_000);
    expect(
      await loadGoal({ cachedOnly: true, config, now: stale, paths: p }),
    ).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cache offline and ignores another version', async () => {
    const p = paths(home);
    const now = new Date('2026-09-25T10:00:00.000Z');
    await loadGoal({
      config,
      fetch: (async () => Response.json(AT_NONE)) as typeof fetch,
      now,
      paths: p,
    });
    const stale = new Date(now.getTime() + 60 * 60_000);
    expect(
      await loadGoal({ config, fetch: offline, now: stale, paths: p }),
    ).toEqual(AT_NONE);
    expect(
      await loadGoal({
        config: { ...config, version: '2.0.0' },
        fetch: offline,
        now,
        paths: p,
      }),
    ).toBeNull();
  });

  it('is null without a config', async () => {
    expect(await loadGoal({ fetch: offline, paths: paths(home) })).toBeNull();
  });
});
