// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeHeader,
  Event,
  publicKeyFromAgentId,
  verify,
} from '@vouched/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { appendEvent, countPending, readCursor, readDay } from '../log.js';
import { createProgram } from '../program.js';
import { MAX_RATE_LIMIT_WAIT_SEC } from '../sync.js';

const API_URL = 'http://api.test';

type RunResult = { code: number; out: string; err: string };
type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

// Stands in for POST /v1/events. Like the real route it checks that every
// envelope carries the agent's kid and verifies against it before reading
// the payload. reply decides the answer, the default accepts everything.
type Server = {
  agentId: string;
  verify: boolean;
  batches: Event[][];
  bodyBytes: number[];
  envelopes: string[];
  reply: (events: Event[]) => Reply;
};

function accept(events: Event[]): Reply {
  return { status: 200, body: { accepted: events.length, duplicates: 0 } };
}

function apiError(
  status: number,
  code: string,
  issues?: unknown[],
  headers?: Record<string, string>,
): Reply {
  return {
    status,
    body: { error: { code, message: code, ...(issues ? { issues } : {}) } },
    headers,
  };
}

function fakeFetch(server: Server): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input) !== `${API_URL}/v1/events`) {
      throw new TypeError('fetch failed');
    }
    server.bodyBytes.push(Buffer.byteLength(String(init.body)));
    const { envelopes } = JSON.parse(String(init.body)) as {
      envelopes: string[];
    };
    const events: Event[] = [];
    for (const envelope of envelopes) {
      const { kid } = decodeHeader(envelope);
      expect(kid).toBe(server.agentId);
      server.envelopes.push(envelope);
      if (server.verify) {
        const { payload } = await verify(envelope, publicKeyFromAgentId(kid));
        events.push(Event.parse(payload));
      } else {
        const body = envelope.split('.')[1] ?? '';
        events.push(
          Event.parse(JSON.parse(Buffer.from(body, 'base64url').toString())),
        );
      }
    }
    server.batches.push(events);
    const reply = server.reply(events);
    return Response.json(reply.body, {
      status: reply.status,
      headers: reply.headers,
    });
  }) as typeof fetch;
}

const failingFetch = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

function toolCall(n: number): Event {
  return {
    event_id: randomUUID(),
    type: 'tool.call',
    occurred_at: new Date().toISOString(),
    version: '1.0.0',
    payload: { tool: 'Bash', duration_ms: n, ok: true },
  };
}

describe('emit and sync', () => {
  let home: string;
  let agentId: string;
  let server: Server;
  let sleeps: number[];
  let outputs: string[];

  async function run(
    fetchFn: typeof fetch,
    ...args: string[]
  ): Promise<RunResult> {
    const program = createProgram({
      sync: {
        fetch: fetchFn,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    throwOnExit(program);
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    try {
      await program.parseAsync(args, { from: 'user' });
      return { code: 0, out, err };
    } catch (error) {
      if (error instanceof CommanderError) {
        return { code: error.exitCode, out, err };
      }
      throw error;
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
      outputs.push(out, err);
    }
  }

  const api = (...args: string[]) => run(fakeFetch(server), ...args);

  async function initialise(version = '1.2.0'): Promise<void> {
    agentId = (await createKey()).agentId;
    server.agentId = agentId;
    await writeConfig({
      agentId,
      operatorLogin: 'carelmeyer',
      name: 'scout',
      version,
      apiUrl: API_URL,
      registeredAt: '2026-09-23T10:00:00Z',
    });
  }

  async function seed(count: number): Promise<Event[]> {
    const events = Array.from({ length: count }, (_, n) => toolCall(n));
    for (const e of events) await appendEvent(e);
    return events;
  }

  async function logged(): Promise<Event[]> {
    return readDay(new Date().toISOString().slice(0, 10));
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vouched-emit-'));
    vi.stubEnv('VOUCHED_HOME', home);
    vi.stubEnv('VOUCHED_API_URL', '');
    server = {
      agentId: '',
      verify: true,
      batches: [],
      bodyBytes: [],
      envelopes: [],
      reply: accept,
    };
    sleeps = [];
    outputs = [];
  });

  // Nothing printed may carry a signature or the private key.
  afterEach(async () => {
    const printed = outputs.join('');
    for (const envelope of server.envelopes) {
      expect(printed).not.toContain(envelope.split('.')[2]);
    }
    const key = await readFile(paths().key, 'utf8').catch(() => null);
    if (key !== null) expect(printed).not.toContain(key.trim());
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  describe('emit', () => {
    it('appends a validated line and prints the id', async () => {
      await initialise();
      const { code, out, err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
        '--no-sync',
      );
      expect(code).toBe(0);
      expect(err).toBe('');
      const [event] = await logged();
      expect(out).toBe(`${event?.event_id}\n`);
      expect(event).toMatchObject({
        type: 'session.start',
        payload: { session_id: 's1' },
      });
      expect(Date.now() - Date.parse(event?.occurred_at ?? '')).toBeLessThan(
        60_000,
      );
      const raw = await readFile(
        paths().logFile(new Date().toISOString().slice(0, 10)),
        'utf8',
      );
      expect(JSON.parse(raw)).toEqual({ v: 1, ...event });
      expect(server.batches).toEqual([]);
    });

    it('prints the id as JSON with --json', async () => {
      await initialise();
      const { code, out } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
        '--no-sync',
        '--json',
      );
      expect(code).toBe(0);
      const [event] = await logged();
      expect(JSON.parse(out)).toEqual({ eventId: event?.event_id });
    });

    it('rejects a payload with an extra field and appends nothing', async () => {
      await initialise();
      const { code, out, err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1","prompt":"hello"}',
        '--no-sync',
      );
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('invalid event');
      expect(err).toContain('prompt');
      expect(await countPending()).toBe(0);
    });

    it('rejects an unknown type', async () => {
      await initialise();
      const { code, err } = await api(
        'emit',
        '--type',
        'prompt.sent',
        '--no-sync',
      );
      expect(code).toBe(1);
      expect(err).toContain('invalid event');
      expect(await countPending()).toBe(0);
    });

    it('rejects a payload that is not JSON', async () => {
      await initialise();
      const { code, err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{nope',
      );
      expect(code).toBe(1);
      expect(err).toContain('--payload is not valid JSON');
      expect(await countPending()).toBe(0);
    });

    it('uses the config version unless --version is given', async () => {
      await initialise('3.4.5');
      const args = [
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"a"}',
      ];
      await api('emit', ...args, '--no-sync');
      await api('emit', ...args, '--version', '9.9.9', '--no-sync');
      expect((await logged()).map((e) => e.version)).toEqual([
        '3.4.5',
        '9.9.9',
      ]);
    });

    it('without config still appends and hints to run init', async () => {
      const { code, out, err } = await run(
        failingFetch,
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(code).toBe(0);
      const [event] = await logged();
      expect(out).toBe(`${event?.event_id}\n`);
      expect(event?.version).toBe('0.1.0');
      expect(err).toContain('run vouched init');
      expect(err.trim().split('\n')).toHaveLength(1);
    });

    it('with a failing fetch still exits 0 with the pending count', async () => {
      await initialise();
      await seed(2);
      const { code, out, err } = await run(
        failingFetch,
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(code).toBe(0);
      expect(out).toMatch(/^[0-9a-f-]{36}\n$/);
      expect(err).toBe(
        'warning: sync did not finish, 3 events pending, run vouched sync\n',
      );
      expect(await countPending()).toBe(3);
    });

    it('does not wait on a rate limit', async () => {
      await initialise();
      server.reply = () =>
        apiError(429, 'rate_limited', undefined, { 'Retry-After': '1' });
      const { code, err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(code).toBe(0);
      expect(sleeps).toEqual([]);
      expect(err).toContain('1 event pending');
    });

    it('syncs after appending when the API is up', async () => {
      await initialise();
      await seed(2);
      const { code, err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(server.batches.map((b) => b.length)).toEqual([3]);
      expect(await countPending()).toBe(0);
    });
  });

  describe('sync', () => {
    it('sends all pending in one verified batch and advances the cursor', async () => {
      await initialise();
      const events = await seed(3);
      const { code, out, err } = await api('sync');
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out).toBe('accepted 3, duplicates 0\n');
      expect(server.batches).toEqual([events]);
      expect((await readCursor()).lastAcked?.eventId).toBe(events[2]?.event_id);
      expect(await countPending()).toBe(0);
    });

    it('prints the totals as JSON with --json', async () => {
      await initialise();
      await seed(2);
      server.reply = () => ({
        status: 200,
        body: { accepted: 1, duplicates: 1 },
      });
      const { code, out } = await api('sync', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        accepted: 1,
        duplicates: 1,
        skipped: 0,
      });
    });

    it('with nothing pending sends nothing', async () => {
      await initialise();
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out).toBe('accepted 0, duplicates 0\n');
      expect(server.batches).toEqual([]);
    });

    it('sends 1200 pending in three batches', async () => {
      await initialise();
      server.verify = false;
      const events = await seed(1200);
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out).toBe('accepted 1200, duplicates 0\n');
      expect(server.batches.map((b) => b.length)).toEqual([500, 500, 200]);
      expect(server.batches.flat().map((e) => e.event_id)).toEqual(
        events.map((e) => e.event_id),
      );
      expect(await countPending()).toBe(0);
    }, 60_000);

    it('keeps each request body within the 256 KB cap', async () => {
      await initialise();
      server.verify = false;
      const long = 'x'.repeat(64);
      for (let n = 0; n < 500; n++) {
        await appendEvent({
          ...toolCall(n),
          payload: {
            tool: long,
            duration_ms: n,
            ok: false,
            error_class: long,
          },
        });
      }
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out).toBe('accepted 500, duplicates 0\n');
      expect(server.batches).toHaveLength(2);
      for (const bytes of server.bodyBytes) {
        expect(bytes).toBeLessThanOrEqual(256 * 1024);
      }
    }, 60_000);

    it('waits for Retry-After on a 429 and then succeeds', async () => {
      await initialise();
      await seed(2);
      let calls = 0;
      server.reply = (events) =>
        calls++ === 0
          ? apiError(429, 'rate_limited', undefined, { 'Retry-After': '1' })
          : accept(events);
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(sleeps).toEqual([1000]);
      expect(out).toBe('accepted 2, duplicates 0\n');
      expect(await countPending()).toBe(0);
    });

    it('stops with the pending count when still refused after one wait', async () => {
      await initialise();
      await seed(2);
      server.reply = () =>
        apiError(429, 'rate_limited', undefined, { 'Retry-After': '1' });
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(sleeps).toEqual([1000]);
      expect(err).toContain('rate limiting');
      expect(err).toContain('2 events pending');
    });

    it('does not wait longer than the cap', async () => {
      await initialise();
      await seed(1);
      server.reply = () =>
        apiError(429, 'rate_limited', undefined, {
          'Retry-After': String(MAX_RATE_LIMIT_WAIT_SEC + 1),
        });
      const { code } = await api('sync');
      expect(code).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it('skips an event the API rejects by index and sends the rest', async () => {
      await initialise();
      const events = await seed(5);
      const bad = events[2]?.event_id;
      server.reply = (batch) => {
        const i = batch.findIndex((e) => e.event_id === bad);
        return i === -1
          ? accept(batch)
          : apiError(400, 'occurred_at_out_of_window', [
              {
                path: ['envelopes', i, 'occurred_at'],
                code: 'occurred_at_out_of_window',
                message: 'Out of window',
              },
            ]);
      };
      const { code, out, err } = await api('sync');
      expect(code).toBe(0);
      expect(err).toBe(
        `warning: the API rejected event ${bad} (occurred_at_out_of_window), skipped it\n`,
      );
      expect(out).toBe('accepted 4, duplicates 0, skipped 1\n');
      const accepted = server.batches
        .filter((b) => !b.some((e) => e.event_id === bad))
        .flat()
        .map((e) => e.event_id);
      expect(accepted).toEqual(
        events.filter((e) => e.event_id !== bad).map((e) => e.event_id),
      );
      expect(await countPending()).toBe(0);
    });

    it('skips an event with a bad signature at an index', async () => {
      await initialise();
      const events = await seed(2);
      let calls = 0;
      server.reply = (batch) =>
        calls++ === 0
          ? apiError(401, 'invalid_signature', [
              {
                path: ['envelopes', 0],
                code: 'invalid_signature',
                message: 'x',
              },
            ])
          : accept(batch);
      const { code, out, err } = await api('sync');
      expect(code).toBe(0);
      expect(err).toContain(events[0]?.event_id);
      expect(out).toBe('accepted 1, duplicates 0, skipped 1\n');
    });

    it('stops on unknown_agent and says to run init', async () => {
      await initialise();
      await seed(2);
      server.reply = () => apiError(401, 'unknown_agent');
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toContain('run vouched init');
      expect(err).toContain('2 events pending');
      expect((await readCursor()).lastAcked).toBeNull();
    });

    it('on a network error leaves the cursor and exits 1', async () => {
      await initialise();
      await seed(3);
      const { code, out, err } = await run(failingFetch, 'sync');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('could not reach the Vouched API');
      expect(err).toContain('3 events pending');
      expect((await readCursor()).lastAcked).toBeNull();
      expect(await countPending()).toBe(3);
    });

    it('without config exits 1', async () => {
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toBe('not initialised, run vouched init\n');
    });
  });
});
