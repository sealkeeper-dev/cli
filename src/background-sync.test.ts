// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  backgroundSync,
  LOCK_FILE,
  LOCK_STALE_MS,
  resetBackgroundSyncThrottle,
} from './background-sync.js';
import { type Paths, paths, writeConfig } from './config.js';
import { createKey } from './identity.js';
import { appendEvent, countPending } from './log.js';

const API_URL = 'https://api.test';

function toolCall() {
  return {
    event_id: randomUUID(),
    type: 'tool.call' as const,
    occurred_at: new Date().toISOString(),
    version: '1.0.0',
    payload: { tool: 'Bash', duration_ms: 1, ok: true },
  };
}

describe('background sync', () => {
  let home: string;
  let p: Paths;
  let requests: number;
  let clock: number;
  const now = () => clock;

  const accepting = (async (_url: unknown, init: RequestInit = {}) => {
    requests++;
    const { envelopes } = JSON.parse(String(init.body)) as {
      envelopes: string[];
    };
    return Response.json({ accepted: envelopes.length, duplicates: 0 });
  }) as typeof fetch;

  let agentId: string | null;

  async function initialise(autoSync: boolean | undefined): Promise<void> {
    agentId ??= (await createKey({}, p)).agentId;
    await writeConfig(
      {
        agentId,
        operatorLogin: 'carelmeyer',
        name: 'mastra-bot',
        version: '1.0.0',
        apiUrl: API_URL,
        registeredAt: '2026-09-23T10:00:00Z',
        ...(autoSync === undefined ? {} : { autoSync }),
      },
      p,
    );
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-bg-'));
    p = paths(home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    requests = 0;
    agentId = null;
    clock = Date.now();
    resetBackgroundSyncThrottle();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  const run = () => backgroundSync({ fetch: accepting, now, paths: p });

  it('does nothing while automatic sync is not on', async () => {
    await initialise(undefined);
    await appendEvent(toolCall(), p);
    expect(await run()).toBe('off');
    resetBackgroundSyncThrottle();
    await initialise(false);
    expect(await run()).toBe('off');
    expect(requests).toBe(0);
    expect(await countPending(p)).toBe(1);
  });

  it('does nothing before init', async () => {
    await appendEvent(toolCall(), p);
    expect(await run()).toBe('off');
    expect(requests).toBe(0);
  });

  it('sends pending events when automatic sync is on', async () => {
    await initialise(true);
    await appendEvent(toolCall(), p);
    await appendEvent(toolCall(), p);
    expect(await run()).toBe('synced');
    expect(requests).toBe(1);
    expect(await countPending(p)).toBe(0);
  });

  it('runs at most once every five minutes in one process', async () => {
    await initialise(true);
    await appendEvent(toolCall(), p);
    expect(await run()).toBe('synced');
    await appendEvent(toolCall(), p);
    clock += BACKGROUND_SYNC_INTERVAL_MS - 1;
    expect(await run()).toBe('throttled');
    expect(requests).toBe(1);
    clock += 1;
    expect(await run()).toBe('synced');
    expect(requests).toBe(2);
  });

  it('runs at most once every five minutes across processes, through the stamp file', async () => {
    await initialise(true);
    await appendEvent(toolCall(), p);
    expect(await run()).toBe('synced');
    // A second process has its own in-memory throttle.
    resetBackgroundSyncThrottle();
    await appendEvent(toolCall(), p);
    clock += 60_000;
    expect(await run()).toBe('throttled');
    expect(requests).toBe(1);
    resetBackgroundSyncThrottle();
    clock += BACKGROUND_SYNC_INTERVAL_MS;
    expect(await run()).toBe('synced');
    expect(requests).toBe(2);
  });

  it('a failed sync still counts toward the throttle and does not throw', async () => {
    await initialise(true);
    await appendEvent(toolCall(), p);
    const failing = (async () => {
      requests++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await backgroundSync({ fetch: failing, now, paths: p })).toBe(
      'failed',
    );
    await expect(stat(join(home, LOCK_FILE))).rejects.toThrow();
    resetBackgroundSyncThrottle();
    expect(await backgroundSync({ fetch: failing, now, paths: p })).toBe(
      'throttled',
    );
    expect(requests).toBe(1);
    expect(await countPending(p)).toBe(1);
  });

  it('stays out while another process holds the lock', async () => {
    await initialise(true);
    await appendEvent(toolCall(), p);
    const lock = join(home, LOCK_FILE);
    await writeFile(lock, '123\n');
    await utimes(lock, clock / 1000, clock / 1000);
    expect(await run()).toBe('locked');
    expect(requests).toBe(0);
    // The lock is left to its owner.
    expect((await stat(lock)).isFile()).toBe(true);
  });

  it('takes over a lock left by a process that died', async () => {
    await initialise(true);
    await appendEvent(toolCall(), p);
    const lock = join(home, LOCK_FILE);
    await writeFile(lock, '123\n');
    const old = (clock - LOCK_STALE_MS - 1000) / 1000;
    await utimes(lock, old, old);
    expect(await run()).toBe('synced');
    expect(requests).toBe(1);
    await expect(stat(lock)).rejects.toThrow();
  });

  it('two at once send one batch between them', async () => {
    await initialise(true);
    await appendEvent(toolCall(), p);
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const slow = (async (url: unknown, init?: RequestInit) => {
      await gate;
      return accepting(url as string, init);
    }) as typeof fetch;
    const first = backgroundSync({ fetch: slow, now, paths: p });
    // Let the first one take the lock and reach the network.
    await vi.waitFor(async () => {
      await stat(join(home, LOCK_FILE));
    });
    resetBackgroundSyncThrottle();
    const second = await backgroundSync({ fetch: slow, now, paths: p });
    release();
    expect(await first).toBe('synced');
    expect(['locked', 'throttled']).toContain(second);
    expect(requests).toBe(1);
  });
});
