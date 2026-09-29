// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_VERSION_HEADER } from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api.js';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  backgroundSync,
  gatedSync,
  LOCK_FILE,
  LOCK_STALE_MS,
  resetBackgroundSyncThrottle,
  SyncBusyError,
  withSyncLock,
} from './background-sync.js';
import { type Paths, paths, writeConfig } from './config.js';
import { createKey } from './identity.js';
import { appendEvent, countPending, writeCursor } from './log.js';
import { syncEvents } from './sync.js';
import { VERSION } from './version.js';

const API_URL = 'https://api.test';

// The pid of a process that ran and has exited, as a sync cut off by Ctrl-C
// leaves in its lock file.
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('could not start a child');
  return child.pid;
}

function sessionEnd() {
  return {
    event_id: randomUUID(),
    type: 'session.end' as const,
    occurred_at: new Date().toISOString(),
    version: '1.0.0',
    payload: { session_id: 's1', duration_ms: 1 },
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
        operatorLogin: 'alice',
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
    await appendEvent(sessionEnd(), p);
    expect(await run()).toBe('off');
    resetBackgroundSyncThrottle();
    await initialise(false);
    expect(await run()).toBe('off');
    expect(requests).toBe(0);
    expect(await countPending(p)).toBe(1);
  });

  it('does nothing before init', async () => {
    await appendEvent(sessionEnd(), p);
    expect(await run()).toBe('off');
    expect(requests).toBe(0);
  });

  it('sends pending events when automatic sync is on', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    await appendEvent(sessionEnd(), p);
    expect(await run()).toBe('synced');
    expect(requests).toBe(1);
    expect(await countPending(p)).toBe(0);
  });

  // VOU-453. The one gate every automatic sync goes through makes its
  // client with createApiClient, so the batch says which CLI sends it.
  it('sends the CLI version with the batch', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    const versions: (string | null)[] = [];
    const recording = (async (url: string, init: RequestInit = {}) => {
      versions.push(new Headers(init.headers).get(CLI_VERSION_HEADER));
      return accepting(url, init);
    }) as typeof fetch;
    expect(await backgroundSync({ fetch: recording, now, paths: p })).toBe(
      'synced',
    );
    expect(versions).toEqual([VERSION]);
  });

  it('prints nothing for a damaged log or a lost cursor line', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    const file = p.logFile(new Date(clock).toISOString().slice(0, 10));
    await appendFile(file, 'not json\n');
    await appendFile(file, '{"v":1,"eve');
    await writeCursor(
      {
        v: 1,
        lastAcked: {
          file: file.slice(-16),
          eventId: randomUUID(),
          offset: 3,
        },
      },
      p,
    );
    const write = vi.spyOn(process.stderr, 'write');
    try {
      expect(await run()).toBe('synced');
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(requests).toBe(1);
  });

  it('runs at most once every five minutes in one process', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    expect(await run()).toBe('synced');
    await appendEvent(sessionEnd(), p);
    clock += BACKGROUND_SYNC_INTERVAL_MS - 1;
    expect(await run()).toBe('throttled');
    expect(requests).toBe(1);
    clock += 1;
    expect(await run()).toBe('synced');
    expect(requests).toBe(2);
  });

  it('runs at most once every five minutes across processes, through the stamp file', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    expect(await run()).toBe('synced');
    // A second process has its own in-memory throttle.
    resetBackgroundSyncThrottle();
    await appendEvent(sessionEnd(), p);
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
    await appendEvent(sessionEnd(), p);
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
    await appendEvent(sessionEnd(), p);
    const lock = join(home, LOCK_FILE);
    await writeFile(lock, `${process.pid}\n`);
    await utimes(lock, clock / 1000, clock / 1000);
    expect(await run()).toBe('locked');
    expect(requests).toBe(0);
    // The lock is left to its owner.
    expect((await stat(lock)).isFile()).toBe(true);
  });

  it('takes over a lock older than the stale age', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    const lock = join(home, LOCK_FILE);
    // A running pid, so only the age lets it go.
    await writeFile(lock, `${process.pid}\n`);
    const old = (clock - LOCK_STALE_MS - 1000) / 1000;
    await utimes(lock, old, old);
    expect(await run()).toBe('synced');
    expect(requests).toBe(1);
    await expect(stat(lock)).rejects.toThrow();
  });

  it('takes over a fresh lock whose process is gone', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    const lock = join(home, LOCK_FILE);
    await writeFile(lock, `${deadPid()}\n`);
    await utimes(lock, clock / 1000, clock / 1000);
    expect(
      await gatedSync({
        fetch: accepting,
        now,
        paths: p,
        timeoutMs: 2_000,
        deadlineMs: 3_000,
      }),
    ).toBe('synced');
    expect(requests).toBe(1);
    await expect(stat(lock)).rejects.toThrow();
  });

  it('keeps the age rule for a fresh lock with no pid in it', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
    const lock = join(home, LOCK_FILE);
    await writeFile(lock, '');
    await utimes(lock, clock / 1000, clock / 1000);
    expect(await run()).toBe('locked');
    expect(requests).toBe(0);
  });

  it('two at once send one batch between them', async () => {
    await initialise(true);
    await appendEvent(sessionEnd(), p);
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

  describe('the lock the sync command takes', () => {
    it('runs under the lock and releases it', async () => {
      const lock = join(home, LOCK_FILE);
      const held = await withSyncLock(async () => (await stat(lock)).isFile(), {
        paths: p,
      });
      expect(held).toBe(true);
      await expect(stat(lock)).rejects.toThrow();
    });

    it('releases the lock when the sync throws', async () => {
      await expect(
        withSyncLock(
          async () => {
            throw new Error('boom');
          },
          { paths: p },
        ),
      ).rejects.toThrow('boom');
      await expect(stat(join(home, LOCK_FILE))).rejects.toThrow();
    });

    it('gives up with SyncBusyError while another sync holds the lock', async () => {
      const lock = join(home, LOCK_FILE);
      await writeFile(lock, `${process.pid}\n`);
      let ran = false;
      await expect(
        withSyncLock(
          async () => {
            ran = true;
          },
          { paths: p, waitMs: 300 },
        ),
      ).rejects.toBeInstanceOf(SyncBusyError);
      expect(ran).toBe(false);
      // The lock is left to its owner.
      expect((await stat(lock)).isFile()).toBe(true);
    });

    it('takes over a lock older than the stale age', async () => {
      const lock = join(home, LOCK_FILE);
      // A running pid, so only the age lets it go.
      await writeFile(lock, `${process.pid}\n`);
      const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
      await utimes(lock, old, old);
      expect(await withSyncLock(async () => 'sent', { paths: p })).toBe('sent');
    });

    it('takes over a fresh lock at once when its process is gone, as after Ctrl-C', async () => {
      const lock = join(home, LOCK_FILE);
      await writeFile(lock, `${deadPid()}\n`);
      // No wait at all, so only an immediate takeover gets through.
      expect(
        await withSyncLock(async () => 'sent', { paths: p, waitMs: 0 }),
      ).toBe('sent');
      await expect(stat(lock)).rejects.toThrow();
    });

    it('names the lock file when it gives up', async () => {
      await writeFile(join(home, LOCK_FILE), `${process.pid}\n`);
      await expect(
        withSyncLock(async () => {}, { paths: p, waitMs: 0 }),
      ).rejects.toThrow(join(home, LOCK_FILE));
    });

    it('keeps the lock fresh between rounds of a long sync', async () => {
      await initialise(true);
      // Two rounds, since a round sends at most 500 events.
      for (let i = 0; i < 501; i++) await appendEvent(sessionEnd(), p);
      const lock = join(home, LOCK_FILE);
      const stamps: number[] = [];
      // Each request takes three quarters of the stale age by the clock, so
      // the two together take longer than it, and a gated sync tries to get
      // in during each of them.
      const slow = (async (url: unknown, init?: RequestInit) => {
        clock += (LOCK_STALE_MS * 3) / 4;
        stamps.push((await stat(lock)).mtimeMs);
        resetBackgroundSyncThrottle();
        expect(await run()).toBe('locked');
        return accepting(url as string, init);
      }) as typeof fetch;
      const result = await withSyncLock(
        (keepLock) =>
          syncEvents({
            api: createApiClient({ apiUrl: API_URL, fetch: slow }),
            sleep: async () => {},
            paths: p,
            now,
            onRound: keepLock,
          }),
        { paths: p, now },
      );
      expect(result.accepted).toBe(501);
      expect(stamps).toHaveLength(2);
      // The second round stamped the lock with the clock after the first
      // request.
      expect(stamps[1]).toBeGreaterThan(stamps[0] ?? 0);
      await expect(stat(lock)).rejects.toThrow();
    }, 30_000);

    it('stamps the lock before each request and before a rate limit wait inside one round', async () => {
      await initialise(true);
      await appendEvent(sessionEnd(), p);
      const order: string[] = [];
      let posts = 0;
      const limited = (async (url: unknown, init?: RequestInit) => {
        order.push('post');
        posts++;
        if (posts === 1) {
          return Response.json(
            { error: { code: 'rate_limited', message: 'rate_limited' } },
            { status: 429, headers: { 'Retry-After': '1' } },
          );
        }
        return accepting(url as string, init);
      }) as typeof fetch;
      const result = await syncEvents({
        api: createApiClient({ apiUrl: API_URL, fetch: limited }),
        sleep: async () => {
          order.push('sleep');
        },
        paths: p,
        now,
        onRound: async () => {
          order.push('stamp');
        },
      });
      expect(result.accepted).toBe(1);
      // The round start, then a stamp before the first post, before the wait
      // and before the retry. The last stamp starts the next round, which
      // finds nothing pending.
      expect(order).toEqual([
        'stamp',
        'stamp',
        'post',
        'stamp',
        'sleep',
        'stamp',
        'post',
        'stamp',
      ]);
    });

    it('never touches or removes a lock another process took over', async () => {
      const lock = join(home, LOCK_FILE);
      const other = deadPid();
      const old = (Date.now() - 60_000) / 1000;
      await withSyncLock(
        async (keepLock) => {
          await writeFile(lock, `${other}\n`);
          await utimes(lock, old, old);
          await keepLock();
        },
        { paths: p },
      );
      const left = await stat(lock);
      expect(Math.round(left.mtimeMs / 1000)).toBe(Math.round(old));
    });

    it('keeps a gated sync out while it holds the lock', async () => {
      await initialise(true);
      await appendEvent(sessionEnd(), p);
      const outcome = await withSyncLock(() => run(), { paths: p });
      expect(outcome).toBe('locked');
      expect(requests).toBe(0);
    });
  });
});
