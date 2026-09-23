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
import type { Event } from '@vouched/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin, {
  type OpenClawPluginApiLike,
  vouchedPlugin,
} from './openclaw.js';

type Handler = (event: unknown, ctx: unknown) => unknown;

// Stands in for the api OpenClaw passes to register. fire calls a hook the
// way the Gateway does and waits for what the handler returns.
function fakeApi(refuse: string[] = []) {
  const handlers = new Map<string, Handler>();
  const api: OpenClawPluginApiLike = {
    on(hookName: string, handler: (event: never, ctx: never) => unknown) {
      if (refuse.includes(hookName)) throw new Error(`${hookName} refused`);
      handlers.set(hookName, handler as Handler);
    },
  };
  const fire = async (name: string, event: unknown, ctx: unknown = {}) =>
    handlers.get(name)?.(event, ctx);
  return { api, handlers, fire };
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('openclaw adapter', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vouched-openclaw-'));
    vi.stubEnv('VOUCHED_HOME', home);
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        agentId: 'A'.repeat(43),
        operatorLogin: 'carelmeyer',
        name: 'claw',
        version: '2.4.0',
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

  function registered() {
    const fake = fakeApi();
    vouchedPlugin().register(fake.api);
    return fake;
  }

  describe('the plugin entry', () => {
    it('is what the OpenClaw loader expects as a default export', () => {
      expect(plugin).toMatchObject({
        id: 'vouched',
        name: 'Vouched',
        register: expect.any(Function),
      });
      expect(typeof plugin.description).toBe('string');
      expect(vouchedPlugin({ taskType: 'code_review' }).id).toBe('vouched');
    });

    it('registers observation hooks only', () => {
      const { handlers } = registered();
      expect([...handlers.keys()].sort()).toEqual([
        'after_tool_call',
        'before_tool_call',
        'llm_output',
        'model_call_ended',
        'session_end',
        'session_start',
      ]);
    });

    it('keeps the other hooks when OpenClaw refuses one', async () => {
      const fake = fakeApi(['llm_output']);
      expect(() => vouchedPlugin().register(fake.api)).not.toThrow();
      expect(fake.handlers.has('llm_output')).toBe(false);
      await fake.fire('session_start', { sessionId: 's1' });
      expect((await logged()).map((e) => e.type)).toEqual(['session.start']);
    });
  });

  describe('sessions', () => {
    it('emits session.start and session.end with the reported duration', async () => {
      const { fire } = registered();
      await fire('session_start', { sessionId: 'sess-1', sessionKey: 'k' });
      await fire('session_end', {
        sessionId: 'sess-1',
        messageCount: 4,
        durationMs: 12_345,
        reason: 'idle',
      });
      const events = await logged();
      expect(events.map((e) => [e.type, e.payload])).toEqual([
        ['session.start', { session_id: 'sess-1' }],
        ['session.end', { session_id: 'sess-1', duration_ms: 12_345 }],
      ]);
      expect(events[0]?.version).toBe('2.4.0');
    });

    it('measures the duration when OpenClaw reports none', async () => {
      const { fire } = registered();
      await fire('session_start', {}, { sessionId: 'from-ctx' });
      await wait(30);
      await fire('session_end', { sessionId: 'from-ctx', messageCount: 0 });
      const [, end] = await logged();
      const payload = end?.payload as {
        session_id: string;
        duration_ms: number;
      };
      expect(payload.session_id).toBe('from-ctx');
      expect(payload.duration_ms).toBeGreaterThanOrEqual(25);
    });

    it('counts a resumed session once and skips an end without a start', async () => {
      const { fire } = registered();
      await fire('session_start', { sessionId: 'again' });
      await fire('session_start', { sessionId: 'again', resumedFrom: 'x' });
      await fire('session_end', { sessionId: 'never-started', durationMs: 5 });
      await fire('session_end', { sessionId: 'again', durationMs: 5 });
      await fire('session_end', { sessionId: 'again', durationMs: 5 });
      expect((await logged()).map((e) => e.type)).toEqual([
        'session.start',
        'session.end',
      ]);
    });

    it('drops ids outside the taxonomy', async () => {
      const { fire } = registered();
      await fire('session_start', { sessionId: 'has space' });
      await fire('session_start', { sessionId: 'x'.repeat(65) });
      await fire('session_start', { sessionId: 42 });
      await fire('session_start', null);
      expect(await logged()).toEqual([]);
    });
  });

  describe('tool calls', () => {
    it('emits tool.call with the reported duration and ok', async () => {
      const { fire } = registered();
      await fire('after_tool_call', {
        toolName: 'exec',
        toolCallId: 'call_1',
        durationMs: 250,
      });
      await fire('after_tool_call', {
        toolName: 'browser navigate',
        durationMs: 10,
        error: 'net::ERR_NAME_NOT_RESOLVED at https://private.example',
      });
      const events = await logged();
      expect(events.map((e) => e.payload)).toEqual([
        { tool: 'exec', duration_ms: 250, ok: true },
        { tool: 'browser-navigate', duration_ms: 10, ok: false },
      ]);
      expect(JSON.stringify(events)).not.toContain('private.example');
    });

    it('times the call from before_tool_call when no duration is reported', async () => {
      const { fire } = registered();
      expect(
        await fire('before_tool_call', { toolName: 'read', toolCallId: 'c9' }),
      ).toBeUndefined();
      await wait(30);
      await fire('after_tool_call', { toolName: 'read' }, { toolCallId: 'c9' });
      await fire('after_tool_call', { toolName: 'write' });
      const [timed, untimed] = (await logged()).map(
        (e) => e.payload as { duration_ms: number },
      );
      expect(timed?.duration_ms).toBeGreaterThanOrEqual(25);
      expect(untimed?.duration_ms).toBe(0);
    });

    it('skips a call without a tool name', async () => {
      const { fire } = registered();
      await fire('after_tool_call', { toolName: '', durationMs: 1 });
      await fire('after_tool_call', { durationMs: 1 });
      expect(await logged()).toEqual([]);
    });

    it('never reads tool params, results or the context beyond ids', async () => {
      const { fire } = registered();
      const guarded = (what: string) => ({
        get params(): unknown {
          throw new Error(`${what} params were read`);
        },
        get result(): unknown {
          throw new Error(`${what} result was read`);
        },
        get derivedPaths(): unknown {
          throw new Error(`${what} paths were read`);
        },
      });
      const ctx = {
        toolName: 'edit',
        get getSessionExtension(): unknown {
          throw new Error('session extension was read');
        },
        get requester(): unknown {
          throw new Error('requester was read');
        },
      };
      await fire(
        'before_tool_call',
        withGetters({ toolName: 'edit', toolCallId: 't1' }, guarded('before')),
        ctx,
      );
      await fire(
        'after_tool_call',
        withGetters(
          { toolName: 'edit', toolCallId: 't1', durationMs: 3 },
          guarded('after'),
        ),
        ctx,
      );
      const events = await logged();
      expect(events.map((e) => e.payload)).toEqual([
        { tool: 'edit', duration_ms: 3, ok: true },
      ]);
    });
  });

  describe('usage', () => {
    it('emits usage with tokens, model and the model time of the run', async () => {
      const { fire } = registered();
      await fire('model_call_ended', {
        runId: 'run-1',
        callId: 'a',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        durationMs: 800,
        outcome: 'completed',
      });
      await fire('model_call_ended', { runId: 'run-1', durationMs: 450 });
      await fire('llm_output', {
        runId: 'run-1',
        sessionId: 'sess-1',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage: { input: 1200, output: 300, cacheRead: 50, total: 1550 },
      });
      const events = await logged();
      expect(events.map((e) => [e.type, e.payload])).toEqual([
        [
          'usage',
          {
            tokens_in: 1200,
            tokens_out: 300,
            latency_ms: 1250,
            model: 'claude-sonnet-4-5',
          },
        ],
      ]);
    });

    it('starts the model time again after each llm_output', async () => {
      const { fire } = registered();
      const output = {
        runId: 'r',
        model: 'm',
        usage: { input: 1, output: 1 },
      };
      await fire('model_call_ended', { runId: 'r', durationMs: 100 });
      await fire('llm_output', output);
      await fire('model_call_ended', {}, { runId: 'r', durationMs: 7 });
      await fire('model_call_ended', { runId: 'r', durationMs: 20 });
      await fire('llm_output', output);
      const latencies = (await logged()).map(
        (e) => (e.payload as { latency_ms: number }).latency_ms,
      );
      expect(latencies).toEqual([100, 20]);
    });

    it('records nothing without tokens, a model or a model time', async () => {
      const { fire } = registered();
      await fire('llm_output', {
        runId: 'no-time',
        model: 'm',
        usage: { input: 1, output: 1 },
      });
      await fire('model_call_ended', { runId: 'r2', durationMs: 5 });
      await fire('llm_output', {
        runId: 'r2',
        model: 'm',
        usage: { input: 1 },
      });
      await fire('model_call_ended', { runId: 'r3', durationMs: 5 });
      await fire('llm_output', {
        runId: 'r3',
        model: '',
        usage: { input: 1, output: 1 },
      });
      await fire('model_call_ended', { runId: 'r4', durationMs: 5 });
      await fire('llm_output', {
        runId: 'r4',
        model: 'm',
        usage: { input: -1, output: 1 },
      });
      expect(await logged()).toEqual([]);
    });

    it('never reads prompts or assistant text', async () => {
      const { fire } = registered();
      await fire('model_call_ended', { runId: 'safe', durationMs: 40 });
      const event = {
        runId: 'safe',
        sessionId: 's',
        provider: 'openai',
        model: 'gpt-5.4',
        usage: { input: 9, output: 4 },
        get prompt(): unknown {
          throw new Error('prompt was read');
        },
        get assistantTexts(): unknown {
          throw new Error('assistant text was read');
        },
        get lastAssistant(): unknown {
          throw new Error('last assistant was read');
        },
      };
      await fire('llm_output', event);
      expect((await logged()).map((e) => e.payload)).toEqual([
        { tokens_in: 9, tokens_out: 4, latency_ms: 40, model: 'gpt-5.4' },
      ]);
    });
  });

  describe('when things go wrong', () => {
    it('skips an event whose fields throw when read', async () => {
      const { fire } = registered();
      const hostile = {
        get sessionId(): unknown {
          throw new Error('hostile');
        },
        get toolName(): unknown {
          throw new Error('hostile');
        },
      };
      await expect(fire('session_start', hostile)).resolves.toBeUndefined();
      await expect(fire('after_tool_call', hostile)).resolves.toBeUndefined();
      expect(await logged()).toEqual([]);
    });

    it('never throws into the agent when the log cannot be written', async () => {
      // A file where the log directory should be, so every append fails.
      await writeFile(join(home, 'log'), 'not a directory');
      const { fire } = registered();
      await expect(
        fire('session_start', { sessionId: 's' }),
      ).resolves.toBeUndefined();
      await expect(
        fire('after_tool_call', { toolName: 'exec', durationMs: 1 }),
      ).resolves.toBeUndefined();
      await expect(
        fire('session_end', { sessionId: 's', durationMs: 1 }),
      ).resolves.toBeUndefined();
    });

    it('never throws when the home directory is read only', async () => {
      await chmod(home, 0o500);
      const { fire } = registered();
      await expect(
        fire('session_start', { sessionId: 's' }),
      ).resolves.toBeUndefined();
    });
  });
});

// Adds the getters of traps to base as getters. A spread would call them.
function withGetters(base: object, traps: object): object {
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(traps));
}
