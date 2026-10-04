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
import type { Event } from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from './config.js';
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

  // VOU-627. The agent's own sessions are its operator's work, so the
  // adapter writes no event. Only a routine run records a session.
  describe('sealKeeperSession', () => {
    it('keeps its shape, reads the model of a step and writes no event', async () => {
      const session = sealKeeperSession('run-42');
      expect(session.sessionId).toBe('run-42');
      await session.onStepFinish({
        text: 'model output that must not be read',
        toolCalls: [],
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
        response: { modelId: 'gpt-4o-mini', timestamp: new Date() },
      });
      await expect(session.end()).resolves.toBeUndefined();
      expect(await logged()).toEqual([]);
      // The model id still goes to the fingerprint source.
      await vi.waitFor(async () => {
        expect(await readFile(paths().fingerprintSources, 'utf8')).toContain(
          'gpt-4o-mini',
        );
      });
    });

    it('keeps a plain session id and gives the sha256 of any other', () => {
      expect(sealKeeperSession('run_42-a').sessionId).toBe('run_42-a');
      const odd = 'alice@example.com/chat 1';
      expect(sealKeeperSession(odd).sessionId).toBe(
        createHash('sha256').update(odd).digest('hex'),
      );
      expect(sealKeeperSession('a'.repeat(65)).sessionId).toBe(
        createHash('sha256').update('a'.repeat(65)).digest('hex'),
      );
      expect(sealKeeperSession().sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('skips a step that is not one, or throws when read', async () => {
      const session = sealKeeperSession('s');
      await expect(session.onStepFinish(undefined)).resolves.toBeUndefined();
      await expect(
        session.onStepFinish({
          get response(): unknown {
            throw new Error('step was hostile');
          },
        }),
      ).resolves.toBeUndefined();
      await session.end();
      expect(await logged()).toEqual([]);
    });
  });

  describe('when the home cannot be written', () => {
    it('never throws into the agent', async () => {
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
});
