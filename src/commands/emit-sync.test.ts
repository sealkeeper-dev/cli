// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeHeader,
  EVENT_MAX_AGE_DAYS,
  EVENT_MAX_FUTURE_SKEW_SEC,
  Event,
  publicKeyFromAgentId,
  readAudience,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Input } from '../ask.js';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  LOCK_FILE,
  resetBackgroundSyncThrottle,
  STAMP_FILE,
} from '../background-sync.js';
import { paths, readConfig, writeConfig } from '../config.js';
import { currentFingerprint } from '../fingerprint.js';
import { createKey } from '../identity.js';
import {
  appendEvent,
  countPending,
  LOG_RETENTION_DAYS,
  readCursor,
  readDay,
} from '../log.js';
import { createProgram } from '../program.js';
import { MAX_RATE_LIMIT_WAIT_SEC } from '../sync.js';

const API_URL = 'https://api.test';

// Every signed payload names the API it is for (VOU-111). The fake takes
// aud off before it parses, and a payload without the right aud fails the
// test that sent it.
const audErrors: unknown[] = [];
const unsigned = (payload: unknown) => {
  const check = readAudience(payload, [API_URL]);
  if (check.result !== 'match') audErrors.push(payload);
  return check.payload;
};
afterEach(() => {
  expect(audErrors.splice(0)).toEqual([]);
});

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
  // The fingerprint JWS each request carried beside its envelopes, or
  // undefined for a request without one (VB-4).
  fingerprints: (string | undefined)[];
  reply: (events: Event[], fingerprint?: string) => Reply;
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
    const { envelopes, fingerprint } = JSON.parse(String(init.body)) as {
      envelopes: string[];
      fingerprint?: string;
    };
    server.fingerprints.push(fingerprint);
    const events: Event[] = [];
    for (const envelope of envelopes) {
      const { kid } = decodeHeader(envelope);
      expect(kid).toBe(server.agentId);
      server.envelopes.push(envelope);
      if (server.verify) {
        const payload = unsigned(
          (await verify(envelope, publicKeyFromAgentId(kid))).payload,
        );
        events.push(Event.parse(payload));
      } else {
        const body = envelope.split('.')[1] ?? '';
        events.push(
          Event.parse(
            unsigned(JSON.parse(Buffer.from(body, 'base64url').toString())),
          ),
        );
      }
    }
    server.batches.push(events);
    const reply = server.reply(events, fingerprint);
    return Response.json(reply.body, {
      status: reply.status,
      headers: reply.headers,
    });
  }) as typeof fetch;
}

// A 400 that names envelope i the way POST /v1/events does.
function rejectAt(i: number, code: string, field: string): Reply {
  return apiError(400, code, [
    { path: ['envelopes', i, field], code, message: code },
  ]);
}

const failingFetch = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

// A line an older CLI logged for a tool call. This CLI never sends one.
function toolCall(n: number): Event {
  return {
    event_id: randomUUID(),
    type: 'tool.call',
    occurred_at: new Date().toISOString(),
    version: '1.0.0',
    payload: { tool: 'Bash', duration_ms: n, ok: true },
  };
}

function sessionEnd(n: number): Event {
  return {
    event_id: randomUUID(),
    type: 'session.end',
    occurred_at: new Date().toISOString(),
    version: '1.0.0',
    payload: { session_id: 's1', duration_ms: n },
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

  function build(fetchFn: typeof fetch): Command {
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
    return program;
  }

  async function run(
    fetchFn: typeof fetch,
    ...args: string[]
  ): Promise<RunResult> {
    const program = build(fetchFn);
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
      operatorLogin: 'alice',
      name: 'scout',
      version,
      apiUrl: API_URL,
      registeredAt: '2026-09-23T10:00:00Z',
      ...(autoSync === 'unset' ? {} : { autoSync }),
    });
  }

  async function seed(count: number): Promise<Event[]> {
    const events = Array.from({ length: count }, (_, n) => sessionEnd(n));
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
      fingerprints: [],
      reply: accept,
    };
    sleeps = [];
    outputs = [];
    input = { isTTY: false, answers: [], asked: 0 };
    // Each run stands for its own process, so none inherits the in-memory
    // throttle of the one before.
    resetBackgroundSyncThrottle();
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

    // VOU-451. The hooks and adapters record sessions only. An adapter
    // written for an older CLI that still emits tool.call keeps working.
    it('with the type tool.call records nothing, says so in one line and exits 0', async () => {
      await initialise();
      const { code, out, err } = await api(
        'emit',
        '--type',
        'tool.call',
        '--payload',
        '{"tool":"Bash","duration_ms":1,"ok":true}',
      );
      expect(code).toBe(0);
      expect(out).toBe('');
      expect(err).toBe(
        'tool.call is no longer recorded, nothing was written\n',
      );
      expect(await logged()).toEqual([]);
      expect(server.batches).toEqual([]);
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
      expect(err).toContain('run npx sealkeeper init');
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
        'warning: sync did not finish, 3 events pending, run npx sealkeeper sync\n',
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

  describe('emit with automatic sync, through the sync gate', () => {
    const emitArgs = [
      'emit',
      '--type',
      'session.start',
      '--payload',
      '{"session_id":"s1"}',
    ];

    it('two emits within five minutes make one request, the second prints nothing, and sync still sends at once', async () => {
      await initialise();
      expect((await api(...emitArgs)).err).toBe('');
      // The second emit is its own process, with its own in-memory throttle.
      // The stamp file holds it back.
      resetBackgroundSyncThrottle();
      const second = await api(...emitArgs);
      expect(second.code).toBe(0);
      expect(second.out).toMatch(/^[0-9a-f-]{36}\n$/);
      expect(second.err).toBe('');
      expect(server.batches.map((b) => b.length)).toEqual([1]);
      expect(await countPending()).toBe(1);

      // A person can always send now.
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out).toBe('accepted 1, duplicates 0\n');
      expect(server.batches.map((b) => b.length)).toEqual([1, 1]);
    });

    it('sends again once five minutes have passed since the last gated sync', async () => {
      await initialise();
      await api(...emitArgs);
      const stamp = join(home, STAMP_FILE);
      const earlier = (Date.now() - BACKGROUND_SYNC_INTERVAL_MS - 1000) / 1000;
      await utimes(stamp, earlier, earlier);
      resetBackgroundSyncThrottle();
      await api(...emitArgs);
      expect(server.batches.map((b) => b.length)).toEqual([1, 1]);
      expect(await countPending()).toBe(0);
    });

    it('parallel emits do not post the same batch twice', async () => {
      await initialise();
      await seed(3);
      let release: () => void = () => {};
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const inner = fakeFetch(server);
      let requests = 0;
      const slow = (async (...args: Parameters<typeof fetch>) => {
        requests++;
        await gate;
        return inner(...args);
      }) as typeof fetch;

      let err = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err += String(chunk);
        return true;
      });
      try {
        const first = build(slow).parseAsync(emitArgs, { from: 'user' });
        // The first emit holds the lock and waits on the network.
        await vi.waitFor(async () => {
          await stat(join(home, LOCK_FILE));
          expect(requests).toBe(1);
        });
        // The second is another process that looked at the stamp before the
        // first wrote it, so only the lock stands in its way.
        resetBackgroundSyncThrottle();
        await rm(join(home, STAMP_FILE), { force: true });
        await build(slow).parseAsync(emitArgs, { from: 'user' });
        expect(requests).toBe(1);
        release();
        await first;
      } finally {
        vi.mocked(process.stdout.write).mockRestore();
        vi.mocked(process.stderr.write).mockRestore();
      }
      expect(err).toBe('');
      // The first emit sends the 4 events it found, then the one the second
      // emit logged while it waited. No event goes twice.
      expect(server.batches.map((b) => b.length)).toEqual([4, 1]);
      const ids = server.batches.flat().map((e) => e.event_id);
      expect(new Set(ids).size).toBe(5);
      expect(await countPending()).toBe(0);
      await expect(stat(join(home, LOCK_FILE))).rejects.toThrow();
    });

    it('stops starting rounds after its deadline and leaves the rest pending', async () => {
      await initialise();
      await seed(1001);
      // Each request takes 2.5 seconds on the clock the sync reads. The first
      // round starts at once, the second at 2.5 seconds, before the 3 second
      // deadline, and no third one starts.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const inner = fakeFetch(server);
        const slow = (async (...args: Parameters<typeof fetch>) => {
          vi.setSystemTime(Date.now() + 2_500);
          return inner(...args);
        }) as typeof fetch;
        const { code, err } = await run(slow, ...emitArgs);
        expect(code).toBe(0);
        expect(err).toBe('');
      } finally {
        vi.useRealTimers();
      }
      expect(server.batches.map((b) => b.length)).toEqual([500, 500]);
      expect(await countPending()).toBe(2);
    }, 30_000);

    it('stays out, silently, while another sync holds the lock', async () => {
      await initialise();
      const lock = join(home, LOCK_FILE);
      await writeFile(lock, `${process.pid}\n`);
      const { code, err } = await api(...emitArgs);
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(server.batches).toEqual([]);
      expect((await stat(lock)).isFile()).toBe(true);
    });
  });

  describe('sync', () => {
    it('waits for an automatic sync that holds the lock, then sends', async () => {
      await initialise();
      await seed(2);
      const lock = join(home, LOCK_FILE);
      await writeFile(lock, `${process.pid}\n`);
      const released = new Promise<void>((done) =>
        setTimeout(() => {
          void rm(lock, { force: true }).then(() => done());
        }, 300),
      );
      const { code, out } = await api('sync');
      await released;
      expect(code).toBe(0);
      expect(out).toBe('accepted 2, duplicates 0\n');
      expect(server.batches.map((b) => b.length)).toEqual([2]);
      await expect(stat(lock)).rejects.toThrow();
    });

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

    // VOU-451. The log is append only and keeps each line. No tool call
    // leaves the machine, and a skipped line never holds the cursor back.
    it('never sends the tool.call lines an older CLI logged and moves the cursor past them', async () => {
      await initialise();
      const events = [
        toolCall(0),
        sessionEnd(1),
        toolCall(2),
        toolCall(3),
        sessionEnd(4),
        toolCall(5),
      ];
      for (const e of events) await appendEvent(e);
      expect(await countPending()).toBe(2);
      const first = await api('sync');
      expect(first.code).toBe(0);
      expect(first.out).toBe('accepted 2, duplicates 0\n');
      expect(server.batches).toEqual([[events[1], events[4]]]);
      expect((await readCursor()).lastAcked?.eventId).toBe(events[5]?.event_id);
      expect(await countPending()).toBe(0);

      const second = await api('sync');
      expect(second.out).toBe('accepted 0, duplicates 0\n');
      expect(server.batches).toHaveLength(1);
      expect(await logged()).toEqual(events);
    });

    it('moves the cursor past a log of tool.call lines alone and sends nothing', async () => {
      await initialise();
      const events = [toolCall(0), toolCall(1)];
      for (const e of events) await appendEvent(e);
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out).toBe('accepted 0, duplicates 0\n');
      expect(server.batches).toEqual([]);
      expect((await readCursor()).lastAcked?.eventId).toBe(events[1]?.event_id);
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

    // VB-4. The fingerprint sync last wrote goes beside the envelopes as a
    // JWS the agent signed over { fingerprint }, with the first batch only.
    it('sends the fingerprint from fingerprint.json with the first batch, signed by the agent', async () => {
      await initialise();
      server.verify = false;
      await seed(501);
      const { code } = await api('sync');
      expect(code).toBe(0);
      expect(server.batches.map((b) => b.length)).toEqual([500, 1]);
      const [first, second] = server.fingerprints;
      expect(second).toBeUndefined();
      if (first === undefined) throw new Error('no fingerprint sent');
      expect(decodeHeader(first).kid).toBe(agentId);
      const { payload } = await verify(first, publicKeyFromAgentId(agentId));
      expect(unsigned(payload)).toEqual({
        fingerprint: await currentFingerprint(),
      });
    }, 60_000);

    it('sends the batch again without the fingerprint when the API refuses it', async () => {
      await initialise();
      await seed(2);
      // A strict body from before the field.
      server.reply = (events, fingerprint) =>
        fingerprint === undefined
          ? accept(events)
          : apiError(400, 'validation_failed', [
              {
                path: [],
                code: 'unrecognized_keys',
                message: 'Unrecognized key: "fingerprint"',
              },
            ]);
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out).toBe('accepted 2, duplicates 0\n');
      expect(server.fingerprints.map((f) => f !== undefined)).toEqual([
        true,
        false,
      ]);
      expect(await countPending()).toBe(0);
    });

    // A 401 that is not about the fingerprint is not a reason to send the
    // batch again without it.
    it('stops on unknown_agent with the fingerprint attached and sends no second request', async () => {
      await initialise();
      await seed(2);
      server.reply = () => apiError(401, 'unknown_agent');
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toContain('2 events pending');
      expect(server.fingerprints).toHaveLength(1);
      expect(server.fingerprints[0]).toBeDefined();
      expect(await countPending()).toBe(2);
    });

    it('treats invalid_signature at envelopes 0 with the fingerprint attached as that event, with no second request', async () => {
      await initialise();
      const [only] = await seed(1);
      server.reply = () =>
        apiError(401, 'invalid_signature', [
          {
            path: ['envelopes', 0],
            code: 'invalid_signature',
            message: 'invalid_signature',
          },
        ]);
      const { code, err } = await api('sync');
      expect(code).toBe(0);
      expect(err).toContain(
        `the API rejected event ${only?.event_id} (invalid_signature), skipped it`,
      );
      expect(server.fingerprints).toHaveLength(1);
      expect(server.fingerprints[0]).toBeDefined();
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
          ...sessionEnd(n),
          type: 'usage',
          payload: {
            tokens_in: 100_000_000,
            tokens_out: 100_000_000,
            latency_ms: 604_800_000,
            model: long,
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

    it('shows the API message for a limit longer than it waits, as at the daily cap', async () => {
      await initialise();
      await seed(1);
      server.reply = () => ({
        status: 429,
        body: {
          error: {
            code: 'rate_limited',
            message:
              'Daily cap of 50000 events per agent reached, it resets at the end of the UTC day',
          },
        },
        headers: { 'Retry-After': String(3 * 3600 + 60) },
      });
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(sleeps).toEqual([]);
      expect(err).toContain(
        'the API is rate limiting this agent for 3 hours 1 minute, it says Daily cap of 50000 events per agent reached, it resets at the end of the UTC day, 1 event pending',
      );
    });

    it('skips an event too old for the API at an index and sends the rest', async () => {
      await initialise();
      // Just inside the margin, so it is sent, and older than the API's
      // window, so the API refuses it as too old.
      const edge = new Date(
        Date.now() - EVENT_MAX_AGE_DAYS * 24 * 3600 * 1000 - 60_000,
      ).toISOString();
      const events = [
        ...(await seed(2)),
        { ...sessionEnd(2), occurred_at: edge },
      ];
      await appendEvent(events[2] as Event);
      events.push(...(await seed(2)));
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

    it('stops on a recent event refused as out of window, a clock ahead, and skips nothing', async () => {
      await initialise();
      const events = await seed(3);
      server.reply = () =>
        rejectAt(0, 'occurred_at_out_of_window', 'occurred_at');
      const { code, out, err } = await api('sync');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('check this machine clock');
      expect(err).toContain('nothing was skipped');
      expect(err).toContain('3 events pending');
      expect(err).not.toContain('skipped it');
      expect(server.batches).toHaveLength(1);
      expect((await readCursor()).lastAcked).toBeNull();
      expect(await countPending()).toBe(3);
      // Once the clock is right the same events go through.
      server.reply = accept;
      expect((await api('sync')).code).toBe(0);
      expect(server.batches[1]?.map((e) => e.event_id)).toEqual(
        events.map((e) => e.event_id),
      );
      expect(await countPending()).toBe(0);
    });

    it('sends the events before a recent one refused as out of window and then stops', async () => {
      await initialise();
      const events = await seed(3);
      const ahead = events[1]?.event_id;
      server.reply = (batch) => {
        const i = batch.findIndex((e) => e.event_id === ahead);
        return i === -1
          ? accept(batch)
          : rejectAt(i, 'occurred_at_out_of_window', 'occurred_at');
      };
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toContain('check this machine clock');
      expect(err).toContain('2 events pending');
      expect((await readCursor()).lastAcked?.eventId).toBe(events[0]?.event_id);
    });

    it('emit keeps the event when its sync is refused for a clock ahead', async () => {
      await initialise();
      server.reply = () =>
        rejectAt(0, 'occurred_at_out_of_window', 'occurred_at');
      const { code, err } = await api(
        'emit',
        '--type',
        'session.start',
        '--payload',
        '{"session_id":"s1"}',
      );
      expect(code).toBe(0);
      expect(err).toBe(
        'warning: sync did not finish, 1 event pending, run npx sealkeeper sync\n',
      );
      expect((await readCursor()).lastAcked).toBeNull();
      expect(await countPending()).toBe(1);
    });

    it('stops on version_limit at index 0, says when it clears and skips nothing', async () => {
      await initialise();
      await seed(2);
      server.reply = () => rejectAt(0, 'version_limit', 'version');
      const { code, out, err } = await api('sync');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toMatch(
        /the limit clears at midnight UTC, in (\d+ hours? )?\d+ minutes?, sync again then, 2 events pending/,
      );
      expect(err).not.toContain('skipped');
      expect(server.batches).toHaveLength(1);
      expect((await readCursor()).lastAcked).toBeNull();
      expect(await countPending()).toBe(2);
    });

    it('sends the events before a version_limit and keeps the rest', async () => {
      await initialise();
      const events = await seed(4);
      const over = events[2]?.event_id;
      server.reply = (batch) => {
        const i = batch.findIndex((e) => e.event_id === over);
        return i === -1
          ? accept(batch)
          : rejectAt(i, 'version_limit', 'version');
      };
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toContain('midnight UTC');
      expect(err).toContain('2 events pending');
      expect((await readCursor()).lastAcked?.eventId).toBe(events[1]?.event_id);
    });

    describe('with the API clock in the Date header', () => {
      const NOW = new Date('2026-09-27T10:00:00.000Z');
      const at = (offsetSec: number) =>
        new Date(NOW.getTime() + offsetSec * 1000).toUTCString();

      beforeEach(() => {
        // Only Date is faked, so the local clock stays at NOW and the
        // offsets below come out in whole seconds.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('stops before signing the next round when this machine clock is 400 s ahead of the API', async () => {
        await initialise();
        await seed(600);
        server.reply = (events) => ({
          ...accept(events),
          headers: { Date: at(-400) },
        });
        const { code, err } = await api('sync');
        expect(code).toBe(1);
        expect(err).toContain(
          `this machine clock is 400 seconds ahead of the API clock, more than the ${EVENT_MAX_FUTURE_SKEW_SEC} the API accepts, check this machine clock and sync again, 100 events pending`,
        );
        // The first round was accepted and stays acked. Nothing of the
        // second was signed or sent.
        expect(server.batches.map((b) => b.length)).toEqual([500]);
        expect(server.envelopes).toHaveLength(500);
        expect(await countPending()).toBe(100);
      });

      it('warns once and finishes when this machine clock is 400 s behind the API', async () => {
        await initialise();
        await seed(600);
        server.reply = (events) => ({
          ...accept(events),
          headers: { Date: at(400) },
        });
        const { code, out, err } = await api('sync');
        expect(code).toBe(0);
        expect(err).toBe(
          `warning: this machine clock is 400 seconds behind the API clock, the API still accepts its events since it takes them up to ${EVENT_MAX_AGE_DAYS} days old, check this machine clock\n`,
        );
        expect(out).toBe('accepted 600, duplicates 0\n');
        expect(server.batches.map((b) => b.length)).toEqual([500, 100]);
        expect(await countPending()).toBe(0);
      });

      it('skips an event too old by the API clock when this machine clock is 3 hours behind', async () => {
        await initialise();
        const behindSec = 3 * 3600;
        // Two hours inside the old edge by this machine clock, so it is
        // signed and sent, but an hour past it by the API clock.
        const old: Event = {
          ...sessionEnd(0),
          occurred_at: new Date(
            NOW.getTime() -
              EVENT_MAX_AGE_DAYS * 24 * 3600 * 1000 +
              2 * 3600_000,
          ).toISOString(),
        };
        await appendEvent(old);
        await seed(2);
        server.reply = (events) => {
          const i = events.findIndex((e) => e.event_id === old.event_id);
          const reply =
            i === -1
              ? accept(events)
              : rejectAt(i, 'occurred_at_out_of_window', 'occurred_at');
          return { ...reply, headers: { Date: at(behindSec) } };
        };
        const { code, out, err } = await api('sync');
        expect(code).toBe(0);
        expect(err).toContain(
          `warning: the API rejected event ${old.event_id} (occurred_at_out_of_window), skipped it\n`,
        );
        expect(out).toBe('accepted 2, duplicates 0, skipped 1\n');
        expect(await countPending()).toBe(0);
      });

      it('names the offset and skips nothing when a clock 400 s ahead is refused', async () => {
        await initialise();
        await seed(2);
        server.reply = () => ({
          ...rejectAt(0, 'occurred_at_out_of_window', 'occurred_at'),
          headers: { Date: at(-400) },
        });
        const { code, err } = await api('sync');
        expect(code).toBe(1);
        expect(err).toContain(
          'this machine clock is 400 seconds ahead of the API clock',
        );
        expect(err).toContain('2 events pending');
        expect(err).not.toContain('skipped');
        expect((await readCursor()).lastAcked).toBeNull();
        expect(await countPending()).toBe(2);
      });

      // An API whose clock agrees with this machine, refusing the first
      // event stamped more than the skew ahead of it.
      const refuseAhead = (events: Event[]): Reply => {
        const limit = NOW.getTime() + EVENT_MAX_FUTURE_SKEW_SEC * 1000;
        const i = events.findIndex((e) => Date.parse(e.occurred_at) > limit);
        const reply =
          i === -1
            ? accept(events)
            : rejectAt(i, 'occurred_at_out_of_window', 'occurred_at');
        return { ...reply, headers: { Date: at(0) } };
      };
      const stampedAhead = (sec: number): Event => ({
        ...sessionEnd(0),
        occurred_at: new Date(NOW.getTime() + sec * 1000).toISOString(),
      });

      it('skips events logged while the clock ran a day ahead once it is right, in one request', async () => {
        await initialise();
        const ahead = [
          stampedAhead(24 * 3600),
          stampedAhead(24 * 3600 + 1),
          stampedAhead(24 * 3600 + 2),
        ];
        for (const e of ahead) await appendEvent(e);
        const later = await seed(2);
        server.reply = refuseAhead;
        const { code, out, err } = await api('sync');
        expect(code).toBe(0);
        expect(err).toBe(
          'warning: skipped 3 events logged while this machine clock ran ahead, the API would not accept them for more than 60 minutes\n',
        );
        expect(out).toBe('accepted 2, duplicates 0, skipped 3\n');
        expect(server.batches).toHaveLength(2);
        expect(server.batches[1]?.map((e) => e.event_id)).toEqual(
          later.map((e) => e.event_id),
        );
        expect(await countPending()).toBe(0);
      });

      it('skips events logged a day ahead when this machine clock is now 400 s behind the API', async () => {
        await initialise();
        await appendEvent(stampedAhead(24 * 3600));
        await seed(2);
        // The API is 400 s ahead of this machine and refuses what is more
        // than the skew ahead of its own clock.
        server.reply = (events) => {
          const limit =
            NOW.getTime() + (400 + EVENT_MAX_FUTURE_SKEW_SEC) * 1000;
          const i = events.findIndex((e) => Date.parse(e.occurred_at) > limit);
          const reply =
            i === -1
              ? accept(events)
              : rejectAt(i, 'occurred_at_out_of_window', 'occurred_at');
          return { ...reply, headers: { Date: at(400) } };
        };
        const { code, out, err } = await api('sync');
        expect(code).toBe(0);
        expect(err).toContain('400 seconds behind the API clock');
        expect(err).toContain(
          'warning: skipped 1 event logged while this machine clock ran ahead, the API would not accept it for more than 60 minutes\n',
        );
        expect(err).not.toContain('check this machine clock and sync again');
        expect(out).toBe('accepted 2, duplicates 0, skipped 1\n');
        expect(await countPending()).toBe(0);
      });

      it('waits for an event logged a few minutes ahead once the clock is right, and says when', async () => {
        await initialise();
        await appendEvent(stampedAhead(600));
        await seed(1);
        server.reply = refuseAhead;
        const { code, out, err } = await api('sync');
        expect(code).toBe(1);
        expect(out).toBe('');
        expect(err).toContain(
          'the API refused an event logged while this machine clock ran ahead, it accepts it once its time comes, in 5 minutes, sync again then, nothing was skipped, 2 events pending',
        );
        expect(err).not.toContain('check this machine clock');
        expect((await readCursor()).lastAcked).toBeNull();
        expect(await countPending()).toBe(2);
      });

      it.each([
        ['no Date header', null],
        ['a Date header that does not parse', 'not a date'],
        ['a Date within the accepted skew', at(EVENT_MAX_FUTURE_SKEW_SEC - 10)],
      ])('syncs as usual with %s', async (_, date) => {
        await initialise();
        await seed(2);
        server.reply = (events) => ({
          ...accept(events),
          ...(date === null ? {} : { headers: { Date: date } }),
        });
        const { code, out, err } = await api('sync');
        expect(code).toBe(0);
        expect(err).toBe('');
        expect(out).toBe('accepted 2, duplicates 0\n');
        expect(await countPending()).toBe(0);
      });
    });

    it('drops 50 stale events before signing and sends 5 fresh ones in one request', async () => {
      await initialise();
      const old = new Date(
        Date.now() - (EVENT_MAX_AGE_DAYS + 1) * 24 * 3600 * 1000,
      ).toISOString();
      const stale = Array.from({ length: 50 }, (_, n) => ({
        ...sessionEnd(n),
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
      await appendEvent({ ...sessionEnd(9), occurred_at: old });
      const b = await seed(1);
      await appendEvent({ ...sessionEnd(9), occurred_at: old });
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
        await appendEvent({ ...sessionEnd(n), occurred_at: old });
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
      const kept = { ...sessionEnd(1), occurred_at: edge };
      await appendEvent(kept);
      const { code } = await api('sync');
      expect(code).toBe(0);
      expect(server.batches.flat().map((e) => e.event_id)).toEqual([
        kept.event_id,
      ]);
    });

    it('drops whole day files too old to send without reading them, then deletes the oldest', async () => {
      await initialise();
      const daysAgo = (n: number) =>
        new Date(Date.now() - n * 24 * 3600 * 1000);
      const dayName = (n: number) =>
        `${daysAgo(n).toISOString().slice(0, 10)}.jsonl`;
      const oldest = LOG_RETENTION_DAYS + 5;
      const stale = EVENT_MAX_AGE_DAYS + 3;
      for (const n of [oldest, oldest, stale]) {
        await appendEvent(
          { ...sessionEnd(n), occurred_at: daysAgo(n).toISOString() },
          paths(),
          daysAgo(n),
        );
      }
      const fresh = await seed(2);
      const { code, out, err } = await api('sync', '--json');
      expect(code).toBe(0);
      expect(server.batches).toEqual([fresh]);
      expect(JSON.parse(out)).toMatchObject({ accepted: 2, dropped: 3 });
      expect(err).toContain('dropped 3 events');
      // The oldest file is past retention and behind the cursor. The other
      // old one is kept until it is too.
      const files = await readdir(paths().log);
      expect(files).not.toContain(dayName(oldest));
      expect(files).toContain(dayName(stale));
      expect(await countPending()).toBe(0);

      // A second sync drops nothing again.
      const again = await api('sync', '--json');
      expect(JSON.parse(again.out)).toMatchObject({ accepted: 0, dropped: 0 });
      expect(again.err).toBe('');
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
      expect(err).toContain('run npx sealkeeper init');
      expect(err).toContain('2 events pending');
      expect((await readCursor()).lastAcked).toBeNull();
    });

    it.each([
      ['no issues', undefined],
      [
        'an envelope issue',
        [{ path: ['envelopes', 0], code: 'wrong_audience', message: 'x' }],
      ],
    ])(
      'stops on wrong_audience with %s and skips nothing',
      async (_, issues) => {
        await initialise();
        await seed(2);
        server.reply = () => apiError(401, 'wrong_audience', issues);
        const { code, err } = await api('sync');
        expect(code).toBe(1);
        expect(err).toContain('check apiUrl');
        expect(err).toContain('2 events pending');
        expect(err).not.toContain('skipped');
        expect(server.batches).toHaveLength(1);
        expect((await readCursor()).lastAcked).toBeNull();
        expect(await countPending()).toBe(2);
      },
    );

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

    it('stops on an insecure apiUrl with the pending count', async () => {
      await initialise();
      vi.stubEnv('SEALKEEPER_API_URL', 'http://api.example.com');
      await seed(2);
      const { code, out, err } = await api('sync');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain(
        'refusing the SealKeeper API at http://api.example.com',
      );
      expect(err).toContain('2 events pending');
      expect(server.batches).toEqual([]);
      expect(await countPending()).toBe(2);
    });

    it('with an insecure apiUrl and nothing pending sends nothing', async () => {
      await initialise();
      vi.stubEnv('SEALKEEPER_API_URL', 'http://api.example.com');
      const { code, out } = await api('sync');
      expect(code).toBe(0);
      expect(out).toBe('accepted 0, duplicates 0\n');
    });

    it('without config exits 1', async () => {
      const { code, err } = await api('sync');
      expect(code).toBe(1);
      expect(err).toBe('not initialised, run npx sealkeeper init\n');
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
        '2 events waiting, run npx sealkeeper sync to review and send\n',
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
        '1 event waiting, run npx sealkeeper sync to review and send\n',
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
      // The signed bytes are the shown line with aud, the API it is for,
      // added as the last key.
      expect(signed).toEqual(
        shown.map((l) => `${l.slice(0, -1)},"aud":"${API_URL}"}`),
      );
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
      expect(err).toContain('npx sealkeeper config auto-sync off');
      expect(server.batches).toEqual([events]);
      expect((await readConfig())?.autoSync).toBe(true);
    });

    it('first sync summarises many events and sends every one', async () => {
      await initialise('1.2.0', 'unset');
      const events = await seed(5);
      const old = new Date(
        Date.now() - (EVENT_MAX_AGE_DAYS + 1) * 24 * 3600 * 1000,
      ).toISOString();
      await appendEvent({ ...sessionEnd(9), occurred_at: old });
      input = { isTTY: true, answers: ['y'], asked: 0 };
      const { code, out, err } = await api('sync');
      expect(code).toBe(0);
      expect(out).toContain(`  ${today()}  5 events  session.end 5\n`);
      expect(out).toContain('the first 3 of 5, as sent');
      expect(out).toContain(JSON.stringify(events[2]));
      expect(out).not.toContain(JSON.stringify(events[3]));
      expect(out).toContain('sync --dry-run to see every event');
      expect(out).toContain('5 events pending, nothing sent yet.');
      expect(err).toContain('send these 5 events now');
      expect(server.batches).toEqual([events]);
      expect(err).toContain('dropped 1 event older than');
      expect(await countPending()).toBe(0);
    });

    it('first sync leaves tool.call lines out of the preview and moves past them', async () => {
      await initialise('1.2.0', 'unset');
      const events = [toolCall(0), sessionEnd(1), toolCall(2)];
      for (const e of events) await appendEvent(e);
      const dry = await api('sync', '--dry-run');
      expect(dry.out).toContain('1 event pending, nothing sent yet.');
      expect(dry.out).not.toContain('tool.call');
      input = { isTTY: true, answers: ['y'], asked: 0 };
      const { code, out, err } = await api('sync');
      expect(code).toBe(0);
      expect(out).toContain(`  ${today()}  1 event  session.end 1\n`);
      expect(out).not.toContain('tool.call');
      expect(err).toContain('send this event now');
      expect(server.batches).toEqual([[events[1]]]);
      expect((await readCursor()).lastAcked?.eventId).toBe(events[2]?.event_id);
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
      expect(err).toContain('npx sealkeeper sync --yes');
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
          await appendEvent(sessionEnd(9));
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
        '1 event waiting, run npx sealkeeper sync to review and send\n',
      );
      expect(server.batches).toEqual([]);
    });
  });
});
