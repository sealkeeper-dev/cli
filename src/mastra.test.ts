// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
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
import type { Event } from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBackgroundSyncThrottle } from './background-sync.js';
import { writeConfig } from './config.js';
import { createKey } from './identity.js';
import { countPending } from './log.js';
import { sealKeeperSession, withSealKeeper } from './mastra.js';

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
        operatorLogin: 'carelmeyer',
        name: 'scout',
        version: '3.1.0',
        registeredAt: '2026-09-23T08:00:00Z',
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await chmod(home, 0o700).catch(() => {});
    await rm(home, { recursive: true, force: true });
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

  describe('withSealKeeper', () => {
    it('wraps a record and keeps keys and other fields', async () => {
      const original = {
        id: 'add',
        description: 'Adds one',
        inputSchema: { type: 'object' },
        execute: async (n: number) => n + 1,
      };
      const tools = withSealKeeper({ add: original, noop: { id: 'noop' } });
      expect(Object.keys(tools)).toEqual(['add', 'noop']);
      expect(tools.add).not.toBe(original);
      expect(tools.add.execute).not.toBe(original.execute);
      expect(tools.add.description).toBe('Adds one');
      expect(tools.add.inputSchema).toBe(original.inputSchema);
      expect(tools.noop).toEqual({ id: 'noop' });
      expect(await tools.add.execute(1)).toBe(2);
    });

    it('wraps an array', async () => {
      const tools = withSealKeeper(
        [
          { id: 'a', execute: async () => 'a' },
          { id: 'b', execute: async () => 'b' },
        ],
        { taskType: 'code' },
      );
      expect(Array.isArray(tools)).toBe(true);
      expect(await tools[1]?.execute()).toBe('b');
      const [event] = await logged();
      expect(event).toMatchObject({
        type: 'tool.call',
        version: '3.1.0',
        payload: { tool: 'b', ok: true },
      });
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

    it('emits tool.call with ok true and a duration on success', async () => {
      const tools = withSealKeeper({
        slow: {
          id: 'slow-tool',
          execute: async () => {
            await new Promise((done) => setTimeout(done, 15));
            return 'done';
          },
        },
      });
      expect(await tools.slow.execute()).toBe('done');
      const events = await logged();
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.type).toBe('tool.call');
      expect(event?.payload).toEqual({
        tool: 'slow-tool',
        duration_ms: expect.any(Number),
        ok: true,
      });
      const payload = event?.payload as { duration_ms: number };
      expect(payload.duration_ms).toBeGreaterThanOrEqual(10);
    });

    it('emits ok false with the error class and rethrows the same error', async () => {
      const boom = new RateLimitError('slow down');
      const tools = withSealKeeper({
        search: {
          id: 'web-search',
          execute: async () => {
            throw boom;
          },
        },
      });
      await expect(tools.search.execute()).rejects.toBe(boom);
      const [event] = await logged();
      expect(event?.payload).toEqual({
        tool: 'web-search',
        duration_ms: expect.any(Number),
        ok: false,
        error_class: 'RateLimitError',
      });
    });

    it('rethrows a sync throw and a non error value', async () => {
      const tools = withSealKeeper({
        sync: {
          id: 'sync',
          execute: () => {
            throw new TypeError('bad');
          },
        },
        odd: {
          id: 'odd',
          execute: () => Promise.reject(null),
        },
      });
      await expect(tools.sync.execute()).rejects.toBeInstanceOf(TypeError);
      await expect(tools.odd.execute()).rejects.toBeNull();
      const events = await logged();
      expect(events.map((e) => e.payload)).toMatchObject([
        { tool: 'sync', ok: false, error_class: 'TypeError' },
        { tool: 'odd', ok: false, error_class: 'Unknown' },
      ]);
    });

    it('never reads the arguments or the result', async () => {
      const trap = (what: string) =>
        new Proxy(
          {},
          {
            get() {
              throw new Error(`${what} was read`);
            },
            ownKeys() {
              throw new Error(`${what} was enumerated`);
            },
          },
        );
      const input = {
        get secret(): string {
          throw new Error('argument was read');
        },
      };
      const context = trap('context');
      const result = {
        get answer(): string {
          throw new Error('result was read');
        },
      };
      let received: unknown[] = [];
      const tools = withSealKeeper({
        guarded: {
          id: 'guarded',
          execute: (...args: unknown[]) => {
            received = args;
            return result;
          },
        },
      });
      const out = await (
        tools.guarded.execute as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>
      )(input, context);
      expect(out).toBe(result);
      expect(received[0]).toBe(input);
      expect(received[1]).toBe(context);
      const [event] = await logged();
      expect(event?.payload).toEqual({
        tool: 'guarded',
        duration_ms: expect.any(Number),
        ok: true,
      });
      expect(JSON.stringify(event)).not.toContain('secret');
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
    async function autoSyncOn(): Promise<{ requests: () => number }> {
      const { agentId } = await createKey();
      await writeConfig({
        agentId,
        operatorLogin: 'carelmeyer',
        name: 'bot',
        version: '1.0.0',
        apiUrl: 'http://api.test',
        registeredAt: '2026-09-23T08:00:00Z',
        autoSync: true,
      });
      resetBackgroundSyncThrottle();
      vi.stubEnv('SEALKEEPER_API_URL', '');
      let requests = 0;
      vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit = {}) => {
        requests++;
        const { envelopes } = JSON.parse(String(init.body)) as {
          envelopes: string[];
        };
        return Response.json({ accepted: envelopes.length, duplicates: 0 });
      });
      return { requests: () => requests };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      resetBackgroundSyncThrottle();
    });

    it('sends in the background once automatic sync is on, at most once per interval', async () => {
      const api = await autoSyncOn();
      const [tool] = withSealKeeper([{ id: 'a', execute: async () => 'a' }]);
      expect(await tool?.execute()).toBe('a');
      await vi.waitFor(async () => {
        expect(await countPending()).toBe(0);
      });
      expect(api.requests()).toBe(1);
      // The next call inside five minutes only appends.
      await tool?.execute();
      await new Promise((done) => setTimeout(done, 50));
      expect(api.requests()).toBe(1);
      expect(await countPending()).toBe(1);
    });

    it('never throws into the agent when the API is down', async () => {
      await autoSyncOn();
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('fetch failed');
      });
      const [tool] = withSealKeeper([{ id: 'a', execute: async () => 'a' }]);
      expect(await tool?.execute()).toBe('a');
      await new Promise((done) => setTimeout(done, 50));
      expect(await countPending()).toBe(1);
    });
  });
});
