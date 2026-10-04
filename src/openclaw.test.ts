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
import type { Event } from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { skillBody } from './claude-code-skill.js';
import { paths, readConfig, writeNudge } from './config.js';
import { NUDGE_CACHE_MAX_MS } from './nudge.js';
import plugin, {
  type OpenClawPluginApiLike,
  sealKeeperPlugin,
} from './openclaw.js';

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

    // VOU-627. The plugin writes no event, so it takes only the model
    // hook and the nudge.
    it('registers the model hook, plus the nudge', () => {
      const { handlers } = registered();
      expect([...handlers.keys()].sort()).toEqual([
        'before_prompt_build',
        'llm_output',
      ]);
    });

    it('keeps the nudge when OpenClaw refuses llm_output', () => {
      const fake = fakeApi(['llm_output']);
      expect(() => sealKeeperPlugin().register(fake.api)).not.toThrow();
      expect([...fake.handlers.keys()]).toEqual(['before_prompt_build']);
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

    it('keeps the model hook when OpenClaw refuses it by policy', () => {
      const fake = fakeApi(['before_prompt_build']);
      expect(() => sealKeeperPlugin().register(fake.api)).not.toThrow();
      expect([...fake.handlers.keys()]).toEqual(['llm_output']);
    });
  });

  // VOU-627. The agent's own sessions are its operator's work, so the
  // plugin writes no session, usage or tool event, whatever OpenClaw
  // fires. Only a routine run records a session and its usage.
  describe('events', () => {
    it('writes none for a session with model calls and tool calls', async () => {
      const { fire, handlers } = registered();
      expect(handlers.has('before_tool_call')).toBe(false);
      expect(handlers.has('session_start')).toBe(false);
      await fire('session_start', { sessionId: 's1' });
      await fire('before_tool_call', { toolName: 'exec', toolCallId: 'c1' });
      await fire('model_call_ended', { runId: 'run-1', durationMs: 40 });
      await fire('llm_output', {
        runId: 'run-1',
        model: 'claude-sonnet-4-5',
        usage: { input: 9, output: 4 },
      });
      await fire('session_end', { sessionId: 's1', durationMs: 900 });
      expect(await logged()).toEqual([]);
      // The model id still goes to the fingerprint source.
      await vi.waitFor(async () => {
        expect(
          await readFile(paths(home).fingerprintSources, 'utf8'),
        ).toContain('claude-sonnet-4-5');
      });
    });

    it('never reads prompts, assistant text or usage', async () => {
      const { fire } = registered();
      const event = {
        runId: 'safe',
        model: 'gpt-5.4',
        get usage(): unknown {
          throw new Error('usage was read');
        },
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
      await expect(fire('llm_output', event)).resolves.toBeUndefined();
      expect(await logged()).toEqual([]);
    });
  });

  describe('when things go wrong', () => {
    it('skips an event whose fields throw when read', async () => {
      const { fire } = registered();
      const hostile = {
        get model(): unknown {
          throw new Error('hostile');
        },
      };
      await expect(fire('llm_output', hostile)).resolves.toBeUndefined();
      expect(await logged()).toEqual([]);
    });

    it('never throws when the home directory is read only', async () => {
      await chmod(home, 0o500);
      const { fire } = registered();
      await expect(fire('llm_output', { model: 'm' })).resolves.toBeUndefined();
    });
  });
});
