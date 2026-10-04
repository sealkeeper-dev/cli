// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_VERSION_HEADER, type Event } from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_FILE, resetBackgroundSyncThrottle } from './background-sync.js';
import { writeConfig } from './config.js';
import { createKey } from './identity.js';
import { countPending } from './log.js';
import { sealKeeperSession, withSealKeeper } from './mastra.js';
import { VERSION } from './version.js';

class RateLimitError extends Error {}

describe('mastra adapter', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-mastra-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        agentId: 'A'.repeat(43),
        operatorLogin: 'alice',
        name: 'scout',
        version: '3.1.0',
        registeredAt: '2026-09-23T08:00:00Z',
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await chmod(home, 0o700).catch(() => {});
    // The fingerprint observer may still be writing, so rm retries.
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  async function logged(): Promise<Event[]> {
    let files: string[];
    try {
      files = await readdir(join(home, 'log'));
    } catch {
      return [];
    }
    const lines: Event[] = [];
    for (const file of files.sort()) {
      const raw = await readFile(join(home, 'log', file), 'utf8');
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        const { v: _v, ...event } = JSON.parse(line) as Event & { v: number };
        lines.push(event as Event);
      }
    }
    return lines;
  }

  // VOU-451. Tool calls are not recorded. withSealKeeper keeps its
  // signature and only reads the tool set for the fingerprint, see
  // fingerprint.test.ts.
  describe('withSealKeeper', () => {
    it('returns the record it was given, every tool as it was', async () => {
      const original = {
        id: 'add',
        description: 'Adds one',
        inputSchema: { type: 'object' },
        execute: async (n: number) => n + 1,
      };
      const record = { add: original, noop: { id: 'noop' } };
      const tools = withSealKeeper(record);
      expect(tools).toBe(record);
      expect(tools.add).toBe(original);
      expect(tools.add.execute).toBe(original.execute);
      expect(await tools.add.execute(1)).toBe(2);
      expect(await logged()).toEqual([]);
    });

    it('returns the array it was given', async () => {
      const list = [
        { id: 'a', execute: async () => 'a' },
        { id: 'b', execute: async () => 'b' },
      ];
      const tools = withSealKeeper(list);
      expect(tools).toBe(list);
      expect(await tools[1]?.execute()).toBe('b');
      expect(await logged()).toEqual([]);
    });

    it('keeps the prototype of a class based tool', async () => {
      class Tool {
        id = 'classy';
        async execute() {
          return this.label();
        }
        label() {
          return 'from the prototype';
        }
      }
      const [tool] = withSealKeeper([new Tool()]);
      expect(tool).toBeInstanceOf(Tool);
      expect(await tool?.execute()).toBe('from the prototype');
    });

    it('records no tool.call for a call that succeeds or throws', async () => {
      const boom = new RateLimitError('slow down');
      const tools = withSealKeeper({
        ok: { id: 'ok', execute: async () => 'done' },
        search: {
          id: 'web-search',
          execute: async () => {
            throw boom;
          },
        },
        sync: {
          id: 'sync',
          execute: () => {
            throw new TypeError('bad');
          },
        },
      });
      expect(await tools.ok.execute()).toBe('done');
      await expect(tools.search.execute()).rejects.toBe(boom);
      expect(() => tools.sync.execute()).toThrow(TypeError);
      expect(await logged()).toEqual([]);
    });
  });

  describe('sealKeeperSession', () => {
    it('emits session.start, usage from a step and session.end', async () => {
      const session = sealKeeperSession('run-42');
      expect(session.sessionId).toBe('run-42');
      await new Promise((done) => setTimeout(done, 30));
      await session.onStepFinish({
        text: 'model output that must not be read',
        toolCalls: [],
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
        response: { modelId: 'gpt-4o-mini', timestamp: new Date() },
      });
      await new Promise((done) => setTimeout(done, 5));
      await session.end();

      const events = await logged();
      expect(events.map((e) => e.type)).toEqual([
        'session.start',
        'usage',
        'session.end',
      ]);
      expect(events[0]?.payload).toEqual({ session_id: 'run-42' });
      const usage = events[1]?.payload as {
        tokens_in: number;
        tokens_out: number;
        latency_ms: number;
        model: string;
      };
      expect(usage).toMatchObject({
        tokens_in: 120,
        tokens_out: 30,
        model: 'gpt-4o-mini',
      });
      expect(usage.latency_ms).toBeGreaterThanOrEqual(25);
      expect(Object.keys(usage).sort()).toEqual([
        'latency_ms',
        'model',
        'tokens_in',
        'tokens_out',
      ]);
      const end = events[2]?.payload as {
        session_id: string;
        duration_ms: number;
      };
      expect(end.session_id).toBe('run-42');
      expect(end.duration_ms).toBeGreaterThan(0);
    });

    it('keeps a plain session id and logs the sha256 of any other', async () => {
      const plain = sealKeeperSession('run_42-a');
      await plain.end();
      const odd = 'alice@example.com/chat 1';
      const hashed = sealKeeperSession(odd);
      const sha = createHash('sha256').update(odd).digest('hex');
      expect(hashed.sessionId).toBe(sha);
      await hashed.end();
      const tooLong = sealKeeperSession('a'.repeat(65));
      await tooLong.end();
      const ids = (await logged())
        .filter((e) => e.type === 'session.start')
        .map((e) => (e.payload as { session_id: string }).session_id);
      expect(ids).toEqual([
        'run_42-a',
        sha,
        createHash('sha256').update('a'.repeat(65)).digest('hex'),
      ]);
      expect(JSON.stringify(await logged())).not.toContain('alice');
    });

    it('logs model ids that break the name rule as names', async () => {
      const session = sealKeeperSession('names');
      await session.onStepFinish({
        usage: { promptTokens: 1, completionTokens: 2 },
        response: { modelId: 'openai gpt 4o' },
      });
      await session.end();
      const events = await logged();
      expect(events.find((e) => e.type === 'usage')?.payload).toMatchObject({
        model: 'openai-gpt-4o',
      });
    });

    it('defaults the session id to a uuid', async () => {
      const session = sealKeeperSession();
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      await session.end();
      expect((await logged()).map((e) => e.type)).toEqual([
        'session.start',
        'session.end',
      ]);
    });

    it('skips a step without tokens or a model id', async () => {
      const session = sealKeeperSession('s');
      await session.onStepFinish(undefined);
      await session.onStepFinish({
        usage: { promptTokens: 1 },
        response: { modelId: 'm' },
      });
      await session.onStepFinish({
        usage: { promptTokens: 1, completionTokens: 2 },
        response: { modelId: '', timestamp: new Date() },
      });
      await session.onStepFinish({
        get usage(): unknown {
          throw new Error('step was hostile');
        },
      });
      await session.end();
      expect((await logged()).map((e) => e.type)).toEqual([
        'session.start',
        'session.end',
      ]);
    });
  });

  describe('usage from a step', () => {
    type Usage = {
      tokens_in: number;
      tokens_out: number;
      latency_ms: number;
      model: string;
    };
    const usages = async (): Promise<Usage[]> =>
      (await logged())
        .filter((e) => e.type === 'usage')
        .map((e) => e.payload as Usage);

    it('reads inputTokens and outputTokens from newer versions', async () => {
      const session = sealKeeperSession('newer');
      await session.onStepFinish({
        usage: { inputTokens: 7, outputTokens: 3 },
        response: { modelId: 'claude-sonnet-4-5' },
      });
      await session.end();
      expect(await usages()).toMatchObject([
        { tokens_in: 7, tokens_out: 3, model: 'claude-sonnet-4-5' },
      ]);
    });

    it('falls back to step.model.modelId when the response has none', async () => {
      const session = sealKeeperSession('fallback');
      await session.onStepFinish({
        usage: { promptTokens: 4, completionTokens: 2 },
        response: { modelId: '', timestamp: new Date() },
        model: { modelId: 'claude-opus-4-1', provider: 'anthropic' },
      });
      await session.end();
      expect(await usages()).toMatchObject([
        { tokens_in: 4, tokens_out: 2, model: 'claude-opus-4-1' },
      ]);
    });

    // VOU-623. On Gemini, @mastra/core 1.74.0, a step's response.modelId
    // is empty and the id is in response.modelMetadata.
    it('reads response.modelMetadata.modelId when modelId is empty, as Gemini reports it', async () => {
      const session = sealKeeperSession('gemini');
      await session.onStepFinish({
        usage: { inputTokens: 12, outputTokens: 4 },
        response: {
          id: 'r1',
          modelId: '',
          timestamp: new Date(),
          modelMetadata: {
            modelId: 'gemini-3-flash-preview',
            modelVersion: 'v4',
            modelProvider: 'google.generative-ai',
          },
        },
      });
      await session.end();
      expect(await usages()).toMatchObject([
        { tokens_in: 12, tokens_out: 4, model: 'gemini-3-flash-preview' },
      ]);
    });

    it('measures latency locally since the previous step', async () => {
      const session = sealKeeperSession('timing');
      await new Promise((done) => setTimeout(done, 40));
      // Mastra falls back to a timestamp made at step finish.
      await session.onStepFinish({
        usage: { promptTokens: 1, completionTokens: 1 },
        response: { modelId: 'm', timestamp: new Date() },
      });
      await new Promise((done) => setTimeout(done, 60));
      await session.onStepFinish({
        usage: { promptTokens: 1, completionTokens: 1 },
        response: { modelId: 'm', timestamp: new Date() },
      });
      await session.end();
      const [first, second] = await usages();
      expect(first?.latency_ms).toBeGreaterThanOrEqual(35);
      expect(second?.latency_ms).toBeGreaterThanOrEqual(55);
    });

    it('keeps the event when the provider clock runs ahead', async () => {
      const session = sealKeeperSession('skew');
      await session.onStepFinish({
        usage: { promptTokens: 1, completionTokens: 1 },
        response: { modelId: 'm', timestamp: new Date(Date.now() + 5_000) },
      });
      await session.end();
      const [usage] = await usages();
      expect(usage?.latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('when the log cannot be written', () => {
    it('never throws into the agent', async () => {
      // A file where the log directory should be, so every append fails.
      await writeFile(join(home, 'log'), 'not a directory');
      const boom = new RangeError('tool failed');
      const tools = withSealKeeper({
        ok: { id: 'ok', execute: async () => 'fine' },
        bad: {
          id: 'bad',
          execute: async () => {
            throw boom;
          },
        },
      });
      await expect(tools.ok.execute()).resolves.toBe('fine');
      await expect(tools.bad.execute()).rejects.toBe(boom);

      const session = sealKeeperSession('offline');
      await expect(
        session.onStepFinish({
          usage: { promptTokens: 1, completionTokens: 1 },
          response: { modelId: 'm', timestamp: new Date() },
        }),
      ).resolves.toBeUndefined();
      await expect(session.end()).resolves.toBeUndefined();
    });

    it('never throws when the home directory is read only', async () => {
      await chmod(home, 0o500);
      const tools = withSealKeeper([{ id: 'ok', execute: async () => 1 }]);
      await expect(tools[0]?.execute()).resolves.toBe(1);
      const session = sealKeeperSession();
      await expect(session.end()).resolves.toBeUndefined();
    });
  });
  describe('background sync', () => {
    // Turns automatic sync on for a real key and counts what reaches the
    // API. The in-process throttle is reset so earlier tests do not hold it.
    async function autoSyncOn(): Promise<{
      requests: () => number;
      versions: () => (string | null)[];
    }> {
      const { agentId } = await createKey();
      await writeConfig({
        agentId,
        operatorLogin: 'alice',
        name: 'bot',
        version: '1.0.0',
        apiUrl: 'https://api.test',
        registeredAt: '2026-09-23T08:00:00Z',
        autoSync: true,
      });
      resetBackgroundSyncThrottle();
      vi.stubEnv('SEALKEEPER_API_URL', '');
      let requests = 0;
      const versions: (string | null)[] = [];
      vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit = {}) => {
        requests++;
        versions.push(new Headers(init.headers).get(CLI_VERSION_HEADER));
        const { envelopes } = JSON.parse(String(init.body)) as {
          envelopes: string[];
        };
        return Response.json({ accepted: envelopes.length, duplicates: 0 });
      });
      return { requests: () => requests, versions: () => versions };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      resetBackgroundSyncThrottle();
    });

    it('sends in the background once automatic sync is on, at most once per interval', async () => {
      const api = await autoSyncOn();
      sealKeeperSession('first');
      await vi.waitFor(async () => {
        expect(await logged()).toHaveLength(1);
        expect(await countPending()).toBe(0);
        // The sync has ended, so the next event cannot join its last round.
        expect(await readdir(home)).not.toContain(LOCK_FILE);
      });
      expect(api.requests()).toBe(1);
      // It goes through the API client, so it says which CLI sends (VOU-453).
      expect(api.versions()).toEqual([VERSION]);
      // The next events inside five minutes only append.
      await sealKeeperSession('next').end();
      await new Promise((done) => setTimeout(done, 50));
      expect(api.requests()).toBe(1);
      expect(await countPending()).toBe(2);
    });

    it('never throws into the agent when the API is down', async () => {
      await autoSyncOn();
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('fetch failed');
      });
      await expect(sealKeeperSession('a').end()).resolves.toBeUndefined();
      await new Promise((done) => setTimeout(done, 50));
      expect(await countPending()).toBe(2);
    });
  });
});
