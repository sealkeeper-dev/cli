// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
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
import { skillBody } from './claude-code-skill.js';
import { paths, readConfig, writeConfig, writeNudge } from './config.js';
import { createKey } from './identity.js';
import { countPending } from './log.js';
import { NUDGE_CACHE_MAX_MS } from './nudge.js';
import plugin, {
  type OpenClawPluginApiLike,
  sealKeeperPlugin,
} from './openclaw.js';
import { VERSION } from './version.js';

type Handler = (event: unknown, ctx: unknown) => unknown;

// The cached goal the nudge reads. null, as offline, unless a test sets it.
const goal = vi.hoisted(() => ({
  current: null as unknown,
  reads: [] as unknown[],
}));
vi.mock('./goal.js', () => ({
  cachedGoal: async (options: unknown) => {
    goal.reads.push(options);
    return goal.current === null
      ? null
      : { goal: goal.current, fetchedAt: new Date().toISOString() };
  },
  goalActionText: () => ({ text: '', command: null }),
}));

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
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-openclaw-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        agentId: 'A'.repeat(43),
        operatorLogin: 'alice',
        name: 'claw',
        version: '2.4.0',
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

  function registered() {
    const fake = fakeApi();
    sealKeeperPlugin().register(fake.api);
    return fake;
  }

  describe('the plugin entry', () => {
    it('is what the OpenClaw loader expects as a default export', () => {
      expect(plugin).toMatchObject({
        id: 'sealkeeper',
        name: 'SealKeeper',
        register: expect.any(Function),
      });
      expect(typeof plugin.description).toBe('string');
      expect(sealKeeperPlugin().id).toBe('sealkeeper');
    });

    it('registers observation hooks, plus the nudge', () => {
      const { handlers } = registered();
      expect([...handlers.keys()].sort()).toEqual([
        'before_prompt_build',
        'llm_output',
        'model_call_ended',
        'session_end',
        'session_start',
      ]);
    });

    it('keeps the other hooks when OpenClaw refuses one', async () => {
      const fake = fakeApi(['llm_output']);
      expect(() => sealKeeperPlugin().register(fake.api)).not.toThrow();
      expect(fake.handlers.has('llm_output')).toBe(false);
      await fake.fire('session_start', { sessionId: 's1' });
      expect((await logged()).map((e) => e.type)).toEqual(['session.start']);
    });
  });

  describe('session nudge', () => {
    const cached = {
      level: 'bronze',
      nextLevel: 'silver',
      thresholds: [
        { name: 'verifiedTasks', current: 40, required: 100, met: false },
        { name: 'confirmedTasks', current: 0, required: 25, met: false },
      ],
      pending: { addressed: 0, outcomes: 3 },
    };

    afterEach(() => {
      goal.current = null;
      goal.reads = [];
    });

    async function nudgeOn(on: boolean): Promise<void> {
      const config = await readConfig(paths(home));
      if (config) await writeNudge(on, paths(home));
    }

    it('appends the summary to the system prompt once the nudge is on', async () => {
      await nudgeOn(true);
      goal.current = cached;
      const { fire } = registered();
      const result = await fire('before_prompt_build', { prompt: 'secret' });
      expect(result).toEqual({
        appendSystemContext: [
          'SealKeeper. Level bronze, 0 of 25 confirmed tasks to silver.',
          '3 outcomes to report.',
          '`npx sealkeeper run --json` works on this. Run it only when the user asks for it or agrees.',
          '',
          // OpenClaw has no slash commands, so the skill comes with it.
          skillBody('npx sealkeeper', false),
        ].join('\n'),
      });
      expect(goal.reads).toMatchObject([{ maxAgeMs: NUDGE_CACHE_MAX_MS }]);
      // It never writes to the log.
      expect(await logged()).toEqual([]);
    });

    it('adds nothing with the nudge off or unset, offline or without a cache', async () => {
      goal.current = cached;
      const { fire } = registered();
      expect(await fire('before_prompt_build', {})).toBeUndefined();
      await nudgeOn(false);
      expect(await fire('before_prompt_build', {})).toBeUndefined();
      expect(goal.reads).toEqual([]);
      await nudgeOn(true);
      goal.current = null;
      expect(await fire('before_prompt_build', {})).toBeUndefined();
    });

    it('keeps the other hooks when OpenClaw refuses it by policy', async () => {
      const fake = fakeApi(['before_prompt_build']);
      expect(() => sealKeeperPlugin().register(fake.api)).not.toThrow();
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

  // VOU-451. Tool calls are not recorded. The plugin no longer takes the
  // tool hooks, so OpenClaw never hands it a tool call.
  describe('tool calls', () => {
    it('takes no tool hook and logs a run with tool calls as sessions and usage', async () => {
      const { fire, handlers } = registered();
      expect(handlers.has('before_tool_call')).toBe(false);
      expect(handlers.has('after_tool_call')).toBe(false);
      await fire('session_start', { sessionId: 's1' });
      await fire('before_tool_call', { toolName: 'exec', toolCallId: 'c1' });
      await fire('after_tool_call', {
        toolName: 'exec',
        toolCallId: 'c1',
        durationMs: 250,
      });
      await fire('model_call_ended', { runId: 'run-1', durationMs: 40 });
      await fire('llm_output', {
        runId: 'run-1',
        model: 'gpt-5.4',
        usage: { input: 9, output: 4 },
      });
      await fire('session_end', { sessionId: 's1', durationMs: 900 });
      expect((await logged()).map((e) => e.type)).toEqual([
        'session.start',
        'usage',
        'session.end',
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
      };
      await expect(fire('session_start', hostile)).resolves.toBeUndefined();
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

    it('sends in the background once automatic sync is on', async () => {
      const api = await autoSyncOn();
      const { fire } = registered();
      await fire('session_start', { sessionId: 's1' });
      await vi.waitFor(async () => {
        expect(await countPending()).toBe(0);
        // The sync has ended, so the next event cannot join its last round.
        expect(await readdir(home)).not.toContain(LOCK_FILE);
      });
      expect(api.requests()).toBe(1);
      // It goes through the API client, so it says which CLI sends (VOU-453).
      expect(api.versions()).toEqual([VERSION]);
      await fire('session_end', { sessionId: 's1' });
      await new Promise((done) => setTimeout(done, 50));
      expect(api.requests()).toBe(1);
      expect(await countPending()).toBe(1);
    });
  });
});
