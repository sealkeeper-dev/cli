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
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Input } from '../ask.js';
import { paths, readConfig, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { appendEvent, countPending, readCursor, readDay } from '../log.js';
import { createProgram } from '../program.js';
import { EVENT_MAX_AGE_DAYS, MAX_RATE_LIMIT_WAIT_SEC } from '../sync.js';

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
  // What sync reads when it asks. null answers stand for a closed stdin.
  // during runs while the question waits, before the answer comes back.
  let input: {
    isTTY: boolean;
    answers: (string | null)[];
    asked: number;
    during?: () => Promise<void>;
  };

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
        stdin: (): Input => ({
          isTTY: input.isTTY,
          readLine: async () => {
            input.asked++;
            await input.during?.();
            return input.answers.shift() ?? null;
          },
        }),
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

  // 'unset' is a config from init, before any sync was confirmed. false is
  // one turned off with sealkeeper config auto-sync off.
  async function initialise(
    version = '1.2.0',
    autoSync: boolean | 'unset' = true,
  ): Promise<void> {
    agentId = (await createKey()).agentId;
    server.agentId = agentId;
    await writeConfig({
      agentId,
      operatorLogin: 'carelmeyer',
      name: 'scout',
      version,
      apiUrl: API_URL,
      registeredAt: '2026-09-23T10:00:00Z',
      ...(autoSync === 'unset' ? {} : { autoSync }),
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
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-emit-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
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
    input = { isTTY: false, answers: [], asked: 0 };
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
      expect(err).toContain('run sealkeeper init');
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
        'warning: sync did not finish, 3 events pending, run sealkeeper sync\n',
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

    it('records lastSyncAt on the cursor after an accepted batch', async () => {
      await initialise();
      await seed(2);
      const before = Date.now();
      expect(await readCursor()).toEqual({ v: 1, lastAcked: null });
      const { code } = await api('sync');
      expect(code).toBe(0);
      const cursor = await readCursor();
      expect(Object.keys(cursor).sort()).toEqual([
        'lastAcked',
        'lastSyncAt',
        'v',
      ]);
      expect(Date.parse(cursor.lastSyncAt ?? '')).toBeGreaterThanOrEqual(
        before,
      );
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
        dropped: 0,
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

    it('drops 50 stale events before signing and sends 5 fresh ones in one request', async () => {
      await initialise();
      const old = new Date(
        Date.now() - (EVENT_MAX_AGE_DAYS + 1) * 24 * 3600 * 1000,
      ).toISOString();
      const stale = Array.from({ length: 50 }, (_, n) => ({
        ...toolCall(n),
        occurred_at: old,
      }));
      for (const e of stale) await appendEvent(e);
      const fresh = await seed(5);
      const { code, out, err } = await api('sync', '--json');
      expect(code).toBe(0);
      expect(server.batches).toHaveLength(1);
      expect(server.batches[0]?.map((e) => e.event_id)).toEqual(
        fresh.map((e) => e.event_id),
      );
      expect(JSON.parse(out)).toEqual({
        accepted: 5,
        duplicates: 0,
        skipped: 0,
        dropped: 50,
      });
      expect(err).toBe(
        `warning: dropped 50 events older than ${EVENT_MAX_AGE_DAYS} days, the API no longer accepts them\n`,
      );
      expect(await countPending()).toBe(0);
    });

    it('drops stale events mixed in with fresh ones and moves the cursor past all of them', async () => {
      await initialise();
      const old = new Date(
        Date.now() - (EVENT_MAX_AGE_DAYS + 2) * 24 * 3600 * 1000,
      ).toISOString();
      const a = await seed(2);
      await appendEvent({ ...toolCall(9), occurred_at: old });
      const b = await seed(1);
      await appendEvent({ ...toolCall(9), occurred_at: old });
      const { code, err } = await api('sync');
      expect(code).toBe(0);
      expect(server.batches).toHaveLength(1);
      expect(server.batches[0]?.map((e) => e.event_id)).toEqual(
        [...a, ...b].map((e) => e.event_id),
      );
      expect(err).toContain('dropped 2 events');
      expect(await countPending()).toBe(0);
    });

    it('with only stale events pending sends nothing and empties the log', async () => {
      await initialise();
      const old = new Date(
        Date.now() - (EVENT_MAX_AGE_DAYS + 1) * 24 * 3600 * 1000,
      ).toISOString();
      for (let n = 0; n < 3; n++) {
        await appendEvent({ ...toolCall(n), occurred_at: old });
      }
      const { code, err } = await api('sync');
      expect(code).toBe(0);
      expect(server.batches).toHaveLength(0);
      expect(err).toContain('dropped 3 events');
      expect(await countPending()).toBe(0);
    });

    it('keeps an event just inside the safety margin and lets the API decide', async () => {
      await initialise();
      const edge = new Date(
        Date.now() - EVENT_MAX_AGE_DAYS * 24 * 3600 * 1000 - 60_000,
      ).toISOString();
      const kept = { ...toolCall(1), occurred_at: edge };
      await appendEvent(kept);
      const { code } = await api('sync');
      expect(code).toBe(0);
      expect(server.batches.flat().map((e) => e.event_id)).toEqual([
        kept.event_id,
      ]);
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
      expect(err).toContain('run sealkeeper init');
      expect(err).toContain('2 events pending');
      expect((await readCursor()).lastAcked).toBeNull();
    });

    it('on a network error leaves the cursor and exits 1', async () => {
      await initialise();
      await seed(3);
      const { code, out, err } = await run(failingFetch, 'sync');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('could not reach the SealKeeper API');
      expect(err).toContain('3 events pending');
      expect((await readCursor()).lastAcked).toBeNull();
      expect(await countPending()).toBe(3);
    });

    it('without config exits 1', async () => {
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toBe('not initialised, run sealkeeper init\n');
    });
  });

  describe('before the first confirmed sync', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const WIRE =
      'Each event is sent as exactly this JSON wrapped in a signature from your agent key, and nothing else.';

    it('emit does not call fetch and prints one waiting line', async () => {
      await initialise('1.2.0', 'unset');
      await seed(1);
      let calls = 0;
      const counting = (async (...args: Parameters<typeof fetch>) => {
        calls++;
        return fakeFetch(server)(...args);
      }) as typeof fetch;
      const { code, out, err } = await run(
        counting,
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(code).toBe(0);
      expect(out).toMatch(/^[0-9a-f-]{36}\n$/);
      expect(err).toBe(
        '2 events waiting, run sealkeeper sync to review and send\n',
      );
      expect(calls).toBe(0);
      expect(await countPending()).toBe(2);
    });

    it('emit says 1 event for one', async () => {
      await initialise('1.2.0', 'unset');
      const { err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(err).toBe(
        '1 event waiting, run sealkeeper sync to review and send\n',
      );
    });

    it('sync --dry-run prints every pending event decoded, sends nothing and leaves the cursor', async () => {
      await initialise('1.2.0', true);
      const events = await seed(2);
      const { code, out, err } = await api('sync', '--dry-run');
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out.split('\n')).toEqual([
        paths().logFile(today()),
        JSON.stringify(events[0]),
        JSON.stringify(events[1]),
        '',
        '2 events pending, nothing sent yet.',
        WIRE,
        '',
      ]);
      expect(server.batches).toEqual([]);
      expect((await readCursor()).lastAcked).toBeNull();
      expect(await countPending()).toBe(2);
    });

    it('sync --dry-run prints exactly the payload that sync then signs', async () => {
      await initialise('1.2.0', true);
      await seed(2);
      const { out } = await api('sync', '--dry-run');
      const shown = out.split('\n').filter((l) => l.startsWith('{'));
      await api('sync');
      const signed = server.envelopes.map((e) =>
        Buffer.from(e.split('.')[1] ?? '', 'base64url').toString(),
      );
      expect(signed).toEqual(shown);
    });

    it('sync --dry-run --json prints the events as one object', async () => {
      await initialise('1.2.0', 'unset');
      const events = await seed(2);
      const { code, out } = await api('sync', '--dry-run', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ pending: 2, events });
      expect(server.batches).toEqual([]);
    });

    it('sync --dry-run works before init', async () => {
      await seed(1);
      const { code, out } = await api('sync', '--dry-run');
      expect(code).toBe(0);
      expect(out).toContain('1 event pending, nothing sent yet.');
    });

    it('sync --dry-run with nothing pending says so', async () => {
      await initialise('1.2.0', 'unset');
      const { code, out } = await api('sync', '--dry-run');
      expect(code).toBe(0);
      expect(out).toBe('nothing pending, nothing to send\n');
    });

    it('first sync answered y previews, sends and turns on auto-sync', async () => {
      await initialise('1.2.0', 'unset');
      const events = await seed(2);
      input = { isTTY: true, answers: ['y'], asked: 0 };
      const { code, out, err } = await api('sync');
      expect(code).toBe(0);
      expect(input.asked).toBe(1);
      expect(out).toContain(JSON.stringify(events[0]));
      expect(out).toContain(WIRE);
      expect(out.endsWith('accepted 2, duplicates 0\n')).toBe(true);
      expect(err).toContain(
        'send these 2 events now and turn on automatic sync for future events? [y/N] ',
      );
      expect(err).toContain('sealkeeper config auto-sync off');
      expect(server.batches).toEqual([events]);
      expect((await readConfig())?.autoSync).toBe(true);
    });

    it('first sync answered n sends nothing and leaves auto-sync off', async () => {
      await initialise('1.2.0', 'unset');
      await seed(2);
      input = { isTTY: true, answers: ['n'], asked: 0 };
      const { code, err } = await api('sync');
      expect(code).toBe(0);
      expect(err).toContain('nothing sent, automatic sync stays off');
      expect(server.batches).toEqual([]);
      expect((await readCursor()).lastAcked).toBeNull();
      expect((await readConfig())?.autoSync).toBeUndefined();
    });

    it('first sync with an empty answer is a no', async () => {
      await initialise('1.2.0', 'unset');
      await seed(1);
      input = { isTTY: true, answers: [''], asked: 0 };
      await api('sync');
      expect(server.batches).toEqual([]);
      expect((await readConfig())?.autoSync).toBeUndefined();
    });

    it('first sync without a terminal previews and exits 1, sending nothing', async () => {
      await initialise('1.2.0', 'unset');
      const events = await seed(2);
      const { code, out, err } = await api('sync');
      expect(code).toBe(1);
      expect(input.asked).toBe(0);
      expect(out).toContain(JSON.stringify(events[1]));
      expect(err).toContain('sealkeeper sync --yes');
      expect(server.batches).toEqual([]);
      expect((await readCursor()).lastAcked).toBeNull();
      expect((await readConfig())?.autoSync).toBeUndefined();
    });

    it('first sync with --yes sends without asking and turns on auto-sync', async () => {
      await initialise('1.2.0', 'unset');
      const events = await seed(2);
      const { code, out, err } = await api('sync', '--yes');
      expect(code).toBe(0);
      expect(input.asked).toBe(0);
      expect(out).toBe('accepted 2, duplicates 0\n');
      expect(err).toContain('automatic sync is on');
      expect(server.batches).toEqual([events]);
      expect((await readConfig())?.autoSync).toBe(true);
    });

    it('with --json the preview goes to stderr and stdout is only the result', async () => {
      await initialise('1.2.0', 'unset');
      await seed(1);
      input = { isTTY: true, answers: ['yes'], asked: 0 };
      const { code, out, err } = await api('sync', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        accepted: 1,
        duplicates: 0,
        skipped: 0,
        dropped: 0,
      });
      expect(err).toContain(WIRE);
    });

    it('after the first confirmed sync emit syncs on its own', async () => {
      await initialise('1.2.0', 'unset');
      await seed(1);
      input = { isTTY: true, answers: ['y'], asked: 0 };
      await api('sync');
      const { code, err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(server.batches.map((b) => b.length)).toEqual([1, 1]);
      expect(await countPending()).toBe(0);
    });

    it('sends only what the preview showed, not an event logged while it asked', async () => {
      await initialise('1.2.0', 'unset');
      const events = await seed(2);
      input = {
        isTTY: true,
        answers: ['y'],
        asked: 0,
        during: async () => {
          await appendEvent(toolCall(9));
        },
      };
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out.endsWith('accepted 2, duplicates 0\n')).toBe(true);
      expect(server.batches).toEqual([events]);
      expect(await countPending()).toBe(1);
    });
  });

  describe('after auto-sync off', () => {
    it('sync answered y sends and leaves auto-sync off', async () => {
      await initialise('1.2.0', 'unset');
      expect((await api('config', 'auto-sync', 'off')).code).toBe(0);
      const events = await seed(2);
      input = { isTTY: true, answers: ['y'], asked: 0 };
      const { code, out, err } = await api('sync');
      expect(code).toBe(0);
      expect(input.asked).toBe(1);
      expect(out).toContain(JSON.stringify(events[0]));
      expect(err).toContain('send these 2 events now? [y/N] ');
      expect(err).not.toContain('turn on automatic sync');
      expect(err).not.toContain('automatic sync is on');
      expect(server.batches).toEqual([events]);
      expect((await readConfig())?.autoSync).toBe(false);
    });

    it('the next sync asks again', async () => {
      await initialise('1.2.0', false);
      await seed(1);
      input = { isTTY: true, answers: ['y'], asked: 0 };
      await api('sync');
      await seed(1);
      input = { isTTY: true, answers: ['n'], asked: 0 };
      const { err } = await api('sync');
      expect(input.asked).toBe(1);
      expect(err).toContain('nothing sent, automatic sync stays off');
      expect(server.batches.map((b) => b.length)).toEqual([1]);
    });

    it('without a terminal previews and exits 1, sending nothing', async () => {
      await initialise('1.2.0', false);
      await seed(1);
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toContain('Automatic sync stays off');
      expect(server.batches).toEqual([]);
    });

    it('--yes sends without asking and leaves auto-sync off', async () => {
      await initialise('1.2.0', false);
      const events = await seed(2);
      const { code, out, err } = await api('sync', '--yes');
      expect(code).toBe(0);
      expect(input.asked).toBe(0);
      expect(out).toBe('accepted 2, duplicates 0\n');
      expect(err).toBe('');
      expect(server.batches).toEqual([events]);
      expect((await readConfig())?.autoSync).toBe(false);
    });

    it('emit does not sync', async () => {
      await initialise('1.2.0', false);
      const { err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(err).toBe(
        '1 event waiting, run sealkeeper sync to review and send\n',
      );
      expect(server.batches).toEqual([]);
    });
  });
});
