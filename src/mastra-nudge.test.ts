// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig, writeNudge } from './config.js';
import { sealKeeperContext } from './mastra.js';
import { NUDGE_CACHE_MAX_MS } from './nudge.js';

// The cached goal the nudge reads. null, as offline, unless a test sets it.
const goal = vi.hoisted(() => ({
  current: null as unknown,
  fail: false,
  reads: [] as unknown[],
}));
vi.mock('./goal.js', () => ({
  cachedGoal: async (options: unknown) => {
    goal.reads.push(options);
    if (goal.fail) throw new Error('disk on fire');
    return goal.current === null
      ? null
      : { goal: goal.current, fetchedAt: new Date().toISOString() };
  },
  goalActionText: () => ({ text: '', command: null }),
}));

const CACHED = {
  level: 'none',
  nextLevel: 'bronze',
  thresholds: [
    { name: 'verified_tasks', current: 13, required: 25, met: false },
  ],
  pending: { addressed: 1, outcomes: 0 },
};

describe('mastra sealKeeperContext', () => {
  let home: string;

  async function registered(nudge?: boolean): Promise<void> {
    await writeConfig(
      {
        agentId: 'A'.repeat(43),
        operatorLogin: 'alice',
        name: 'scout',
        version: '3.1.0',
        registeredAt: '2026-09-23T08:00:00Z',
      },
      paths(home),
    );
    await rm(paths(home).nudge, { force: true });
    if (nudge !== undefined) await writeNudge(nudge, paths(home));
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-mastra-nudge-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    goal.current = CACHED;
    goal.fail = false;
    goal.reads = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('gives the summary from the cache once the nudge is on', async () => {
    await registered(true);
    expect(await sealKeeperContext()).toBe(
      [
        'SealKeeper. Level none, 13 of 25 verified tasks to bronze.',
        '1 task addressed to you.',
        '`npx sealkeeper prove --json` works on this. Run it only when the user asks for it or agrees.',
      ].join('\n'),
    );
    expect(goal.reads).toMatchObject([{ maxAgeMs: NUDGE_CACHE_MAX_MS }]);
    // It reads, and writes nothing, not even a log.
    expect((await readdir(home)).sort()).toEqual(['config.json', 'nudge.json']);
  });

  it('gives an empty string with the nudge off, unset or before init', async () => {
    await registered(false);
    expect(await sealKeeperContext()).toBe('');
    await registered();
    expect(await sealKeeperContext()).toBe('');
    await rm(paths(home).config);
    expect(await sealKeeperContext()).toBe('');
    expect(goal.reads).toEqual([]);
  });

  it('gives an empty string offline, without a cache or when reading fails', async () => {
    await registered(true);
    goal.current = null;
    expect(await sealKeeperContext()).toBe('');
    goal.fail = true;
    expect(await sealKeeperContext()).toBe('');
  });
});
