// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Event } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_FILE, resetBackgroundSyncThrottle } from '../background-sync.js';
import { parseHookInput, STALE_MARKER_MS, toolNameOf } from '../claude-code.js';
import {
  bindFolder,
  namedHome,
  paths,
  writeConfig,
  writeNudge,
} from '../config.js';
import { createKey } from '../identity.js';
import {
  appendEvent,
  countPending,
  dayOf,
  readCursor,
  readDay,
} from '../log.js';
import { NUDGE_CACHE_MAX_MS, type NudgeGoal } from '../nudge.js';
import { createProgram } from '../program.js';
import { readStdin } from './hook.js';

const API_URL = 'https://api.test';
const SESSION = '5b0f3a52-7f4e-4d0c-9d3a-0c7f1e2a9b61';
const CWD = '/Users/someone/project';

// Values a real tool_input or tool_response might hold. None of them may
// reach the log, stderr or stdout.
const SECRET_INPUT = 'rm -rf /tmp/secret-input-7f3a';
const SECRET_OUTPUT = 'contents of secret-output-91bc';

function base(event: string) {
  return {
    session_id: SESSION,
    transcript_path: `/Users/someone/.claude/projects/p/${SESSION}.jsonl`,
    cwd: CWD,
    hook_event_name: event,
  };
}

const payloads = {
  sessionStart: () => ({ ...base('SessionStart'), source: 'startup' }),
  sessionEnd: () => ({ ...base('SessionEnd'), reason: 'exit' }),
  stop: () => ({ ...base('Stop'), stop_hook_active: false }),
  pre: (id: string, tool = 'Bash') => ({
    ...base('PreToolUse'),
    tool_name: tool,
    tool_input: { command: SECRET_INPUT, description: 'clean up' },
    tool_use_id: id,
  }),
  post: (id: string, tool = 'Bash') => ({
    ...base('PostToolUse'),
    tool_name: tool,
    tool_input: { command: SECRET_INPUT, description: 'clean up' },
    tool_response: { stdout: SECRET_OUTPUT, stderr: '', interrupted: false },
    tool_use_id: id,
  }),
  // A tool call that started and failed, as the hooks reference shows it.
  failure: (id: string, tool = 'Bash', interrupt = false) => ({
    ...base('PostToolUseFailure'),
    tool_name: tool,
    tool_input: { command: SECRET_INPUT, description: 'clean up' },
    tool_use_id: id,
    error: `Exit code 1\n${SECRET_OUTPUT}`,
    is_interrupt: interrupt,
    duration_ms: 4187,
  }),
};

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('hook claude-code', () => {
  let home: string;
  let fetches: string[];
  // The cached goal the session nudge reads, and every read of it.
  let goal: NudgeGoal | null | Error;
  let goalReads: { maxAgeMs: number }[];
  // What GET /goal answers, 404 while null.
  let goalAnswer: Record<string, unknown> | null;

  const fakeFetch = (async (input: string | URL | Request) => {
    fetches.push(String(input));
    if (String(input).endsWith('/goal')) {
      return goalAnswer === null
        ? Response.json(
            { error: { code: 'not_found', message: 'Not found' } },
            { status: 404 },
          )
        : Response.json(goalAnswer);
    }
    return Response.json({ accepted: 1, duplicates: 0 });
  }) as typeof fetch;

  async function run(stdin: string | null): Promise<RunResult> {
    const program = createProgram({
      hook: {
        fetch: fakeFetch,
        readStdin: async () => stdin,
        cachedGoal: async (options) => {
          goalReads.push(options);
          if (goal instanceof Error) throw goal;
          return goal === null
            ? null
            : { goal, fetchedAt: new Date().toISOString() };
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
      await program.parseAsync(['hook', 'claude-code'], { from: 'user' });
      return { code: 0, out, err };
    } catch (error) {
      if (error instanceof CommanderError) {
        return { code: error.exitCode, out, err };
      }
      throw error;
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  // Every hook run must exit 0 with an empty stdout.
  async function hook(payload: unknown): Promise<RunResult> {
    const result = await run(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    return result;
  }

  // Every day file in date order. A test can pin the clock to one day and
  // then write at the real time, which may be another day.
  async function logged(): Promise<Event[]> {
    const dir = dirname(paths(home).logFile(dayOf(new Date())));
    const days = (await readdir(dir).catch(() => []))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, 10))
      .sort();
    const all: Event[] = [];
    for (const day of days) all.push(...(await readDay(day, paths(home))));
    return all;
  }

  async function markers(): Promise<string[]> {
    return readdir(paths(home).sessions).catch(() => []);
  }

  async function initialise(autoSync = true, nudge?: boolean): Promise<string> {
    const agentId = (await createKey({}, paths(home))).agentId;
    await writeConfig(
      {
        agentId,
        operatorLogin: 'alice',
        name: 'scout',
        version: '1.2.0',
        apiUrl: API_URL,
        registeredAt: '2026-09-23T10:00:00Z',
        autoSync,
      },
      paths(home),
    );
    await rm(paths(home).nudge, { force: true });
    if (nudge !== undefined) await writeNudge(nudge, paths(home));
    return agentId;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-hook-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    fetches = [];
    goal = null;
    goalReads = [];
    goalAnswer = null;
    // Each hook run stands for its own process, so none inherits the
    // in-memory sync throttle of the one before.
    resetBackgroundSyncThrottle();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('is hidden from help', async () => {
    const program = createProgram();
    const help = program.helpInformation();
    expect(help).not.toMatch(/^ {2}hook\b/m);
    expect(help).toMatch(/^ {2}adapter claude-code install\b/m);
    expect(help).toMatch(/^ {2}adapter claude-code uninstall\b/m);
  });

  it('SessionStart emits session.start and records the start time', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    const events = await logged();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.start',
      version: '1.2.0',
      payload: { session_id: SESSION },
    });
    const file = join(paths(home).sessions, SESSION);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(fetches).toEqual([]);
  });

  it('a second SessionStart for the same session emits nothing', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    await hook({ ...payloads.sessionStart(), source: 'compact' });
    expect(await logged()).toHaveLength(1);
  });

  it('SessionEnd emits session.end with the duration, ends the marker and syncs', async () => {
    await initialise();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    await hook(payloads.sessionStart());
    vi.setSystemTime(new Date('2026-09-23T10:05:30.250Z'));
    await hook(payloads.sessionEnd());

    const [, end] = await logged();
    expect(end).toMatchObject({
      type: 'session.end',
      payload: { session_id: SESSION, duration_ms: 330_250 },
    });
    expect(await markers()).toEqual([`ended.${SESSION}`]);
    const ended = join(paths(home).sessions, `ended.${SESSION}`);
    expect((await stat(ended)).mode & 0o777).toBe(0o600);
    expect(fetches).toEqual([`${API_URL}/v1/events`]);
    expect((await readCursor(paths(home))).lastAcked?.eventId).toBe(
      end?.event_id,
    );
  });

  it('SessionEnd with auto-sync off appends and sends nothing', async () => {
    await initialise(false);
    await hook(payloads.sessionStart());
    const { code, err } = await hook(payloads.sessionEnd());
    expect(code).toBe(0);
    expect(err).toBe('');
    expect((await logged()).map((e) => e.type)).toEqual([
      'session.start',
      'session.end',
    ]);
    expect(fetches).toEqual([]);
    expect((await readCursor(paths(home))).lastAcked).toBeNull();
  });

  it('Stop emits nothing, and SessionEnd after two Stops covers the whole session', async () => {
    await initialise();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    await hook(payloads.sessionStart());
    vi.setSystemTime(new Date('2026-09-23T10:00:02.000Z'));
    await hook(payloads.stop());
    vi.setSystemTime(new Date('2026-09-23T10:01:00.000Z'));
    await hook(payloads.stop());
    expect((await logged()).map((e) => e.type)).toEqual(['session.start']);
    expect(fetches).toEqual([]);

    vi.setSystemTime(new Date('2026-09-23T10:03:00.000Z'));
    await hook(payloads.sessionEnd());
    await hook(payloads.stop());

    const events = await logged();
    expect(events.map((e) => e.type)).toEqual(['session.start', 'session.end']);
    expect(events[1]?.payload).toEqual({
      session_id: SESSION,
      duration_ms: 180_000,
    });
  });

  it('a compact or resume between Stops still gives one session.start and one session.end', async () => {
    await initialise();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    await hook(payloads.sessionStart());
    await hook(payloads.stop());
    await hook({ ...payloads.sessionStart(), source: 'compact' });
    await hook(payloads.stop());
    vi.setSystemTime(new Date('2026-09-23T10:10:00.000Z'));
    await hook(payloads.sessionEnd());
    await hook({ ...payloads.sessionStart(), source: 'resume' });

    const events = await logged();
    expect(events.map((e) => e.type)).toEqual(['session.start', 'session.end']);
    expect(events[1]?.payload).toEqual({
      session_id: SESSION,
      duration_ms: 600_000,
    });
  });

  it('a session with Stop but no SessionEnd is closed at its last Stop once stale', async () => {
    await initialise();
    // Early today, so every event lands in the day file logged() reads once
    // the clock is real again.
    const today = new Date().toISOString().slice(0, 10);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${today}T00:00:00.000Z`));
    await hook(payloads.sessionStart());
    vi.setSystemTime(new Date(`${today}T00:00:45.000Z`));
    await hook(payloads.stop());
    vi.useRealTimers();

    const file = join(paths(home).sessions, SESSION);
    const past = new Date(Date.now() - STALE_MARKER_MS - 60_000);
    await utimes(file, past, past);
    await hook({ ...payloads.sessionStart(), session_id: 'other-session' });

    const events = await logged();
    expect(events.map((e) => e.type)).toEqual([
      'session.start',
      'session.end',
      'session.start',
    ]);
    expect(events[1]?.payload).toEqual({
      session_id: SESSION,
      duration_ms: 45_000,
    });
    expect(await markers()).toEqual(['other-session']);
  });

  it('a stale session without any Stop is removed without an event', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    const file = join(paths(home).sessions, SESSION);
    const past = new Date(Date.now() - STALE_MARKER_MS - 60_000);
    await utimes(file, past, past);
    await hook({ ...payloads.sessionStart(), session_id: 'other-session' });

    expect((await logged()).map((e) => e.type)).toEqual([
      'session.start',
      'session.start',
    ]);
    expect(await markers()).toEqual(['other-session']);
  });

  it('SessionEnd without a recorded start emits nothing', async () => {
    await initialise();
    await hook(payloads.sessionEnd());
    expect(await logged()).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('a failed sync at session end still exits 0 with one warning', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    const program = createProgram({
      hook: {
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
        readStdin: async () => JSON.stringify(payloads.sessionEnd()),
      },
    });
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
      await program.parseAsync(['hook', 'claude-code'], { from: 'user' });
    } finally {
      vi.restoreAllMocks();
    }
    expect(out).toBe('');
    expect(err).toBe(
      'sealkeeper: sync did not finish, run npx sealkeeper sync\n',
    );
    expect((await logged()).map((e) => e.type)).toEqual([
      'session.start',
      'session.end',
    ]);
  });

  // Runs the SessionEnd hook with its own fetch and returns stderr.
  async function sessionEndWith(fetchFn: typeof fetch): Promise<string> {
    const program = createProgram({
      hook: {
        fetch: fetchFn,
        readStdin: async () => JSON.stringify(payloads.sessionEnd()),
      },
    });
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    try {
      await program.parseAsync(['hook', 'claude-code'], { from: 'user' });
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
    return err;
  }

  async function seedToolCalls(count: number): Promise<void> {
    for (let n = 0; n < count; n++) {
      await appendEvent(
        {
          event_id: randomUUID(),
          type: 'tool.call',
          occurred_at: new Date().toISOString(),
          version: '1.2.0',
          payload: { tool: 'Bash', duration_ms: n, ok: true },
        },
        paths(home),
      );
    }
  }

  it('a second SessionEnd within five minutes of a sync sends nothing and prints nothing', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    await hook(payloads.sessionEnd());
    expect(fetches).toEqual([`${API_URL}/v1/events`]);
    const other = { session_id: 'second-session' };
    await hook({ ...payloads.sessionStart(), ...other });
    const { err } = await hook({ ...payloads.sessionEnd(), ...other });
    expect(err).toBe('');
    expect(fetches).toEqual([`${API_URL}/v1/events`]);
    expect(await countPending(paths(home))).toBe(2);
  });

  it('SessionEnd stays out, silently, while another sync holds the lock', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    await writeFile(join(home, LOCK_FILE), `${process.pid}\n`);
    const { err } = await hook(payloads.sessionEnd());
    expect(err).toBe('');
    expect(fetches).toEqual([]);
  });

  it('SessionEnd stops starting rounds after its deadline', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    await seedToolCalls(1000);
    // Each request takes 2.5 seconds on the clock the sync reads. Rounds
    // start at 0 and 2.5 seconds, and the 3 second deadline stops the third.
    vi.useFakeTimers({ toFake: ['Date'] });
    let requests = 0;
    const slow = (async (_input: unknown, init: RequestInit = {}) => {
      requests++;
      vi.setSystemTime(Date.now() + 2_500);
      const { envelopes } = JSON.parse(String(init.body)) as {
        envelopes: string[];
      };
      return Response.json({ accepted: envelopes.length, duplicates: 0 });
    }) as typeof fetch;
    const err = await sessionEndWith(slow);
    vi.useRealTimers();
    expect(err).toBe('');
    expect(requests).toBe(2);
    expect(await countPending(paths(home))).toBe(2);
  }, 30_000);

  it('SessionEnd returns within its deadline when the API never answers', async () => {
    await initialise();
    await hook(payloads.sessionStart());
    // Stands in for an API that accepts the connection and never answers.
    // Like real fetch it gives up when the request signal aborts.
    const hanging = ((_input: unknown, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new TypeError('fetch failed')),
        );
      })) as typeof fetch;
    const started = Date.now();
    const err = await sessionEndWith(hanging);
    const took = Date.now() - started;
    // One request timeout of 2 seconds, well inside the 3 second deadline
    // plus one request timeout.
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(5_000);
    expect(err).toBe(
      'sealkeeper: sync did not finish, run npx sealkeeper sync\n',
    );
    expect(await countPending(paths(home))).toBe(2);
  }, 15_000);

  it('PreToolUse then PostToolUse emits tool.call with the duration between them', async () => {
    await initialise();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    const pre = await hook(payloads.pre('toolu_01ABCdef'));
    expect(await logged()).toEqual([]);
    expect(await markers()).toEqual(['tool.toolu_01ABCdef']);

    vi.setSystemTime(new Date('2026-09-23T10:00:01.234Z'));
    const post = await hook(payloads.post('toolu_01ABCdef'));
    const events = await logged();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool.call',
      payload: { tool: 'Bash', duration_ms: 1_234, ok: true },
    });
    expect(await markers()).toEqual([]);
    expect(fetches).toEqual([]);

    for (const text of [pre.err, post.err]) {
      expect(text).not.toContain('secret');
    }
  });

  it('PreToolUse then PostToolUseFailure emits tool.call with ok false and no error text', async () => {
    await initialise();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    await hook(payloads.pre('toolu_04fail'));
    vi.setSystemTime(new Date('2026-09-23T10:00:02.000Z'));
    const failed = await hook(payloads.failure('toolu_04fail'));
    const events = await logged();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      tool: 'Bash',
      duration_ms: 2_000,
      ok: false,
    });
    // The marker is taken, so a failed call leaves none behind.
    expect(await markers()).toEqual([]);
    const day = await readFile(paths(home).logFile(dayOf(new Date())), 'utf8');
    for (const text of [day, failed.err, failed.out]) {
      expect(text).not.toContain('secret');
      expect(text).not.toContain('Exit code');
    }
  });

  it('a PostToolUseFailure the user interrupted records nothing and clears the marker', async () => {
    await initialise();
    await hook(payloads.pre('toolu_05esc'));
    expect(await markers()).toEqual(['tool.toolu_05esc']);
    const interrupted = await hook(
      payloads.failure('toolu_05esc', 'Bash', true),
    );
    expect(interrupted.code).toBe(0);
    expect(await logged()).toEqual([]);
    expect(await markers()).toEqual([]);
  });

  it('PostToolUse without a PreToolUse marker has duration 0', async () => {
    await initialise();
    await hook(payloads.post('toolu_02', 'mcp__github__create_issue'));
    const [event] = await logged();
    expect(event?.payload).toEqual({
      tool: 'mcp__github__create_issue',
      duration_ms: 0,
      ok: true,
    });
  });

  it('nothing from tool_input or tool_response reaches the log or stderr', async () => {
    await initialise();
    const results = [
      await hook(payloads.pre('toolu_03')),
      await hook(payloads.post('toolu_03')),
    ];
    const day = await readFile(paths(home).logFile(dayOf(new Date())), 'utf8');
    for (const text of [day, ...results.map((r) => r.err)]) {
      expect(text).not.toContain('secret-input');
      expect(text).not.toContain('secret-output');
      expect(text).not.toContain('clean up');
      expect(text).not.toContain(CWD);
    }
    const [event] = await logged();
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual([
      'duration_ms',
      'ok',
      'tool',
    ]);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['empty', ''],
    ['an array', '[1, 2]'],
    ['no event name', JSON.stringify({ session_id: SESSION })],
    ['an unknown event', JSON.stringify(base('Notification'))],
    [
      'a bad session id',
      JSON.stringify({ ...base('SessionStart'), session_id: '../x' }),
    ],
  ])('%s on stdin exits 0 and writes nothing', async (_label, stdin) => {
    await initialise();
    const { err } = await hook(stdin);
    expect(err).toBe('');
    expect(await logged()).toEqual([]);
    expect(await markers()).toEqual([]);
  });

  it('no stdin at all exits 0 and writes nothing', async () => {
    await initialise();
    const result = await run(null);
    expect(result).toEqual({ code: 0, out: '', err: '' });
    expect(await logged()).toEqual([]);
  });

  it('without a config exits 0 and does nothing', async () => {
    for (const payload of [
      payloads.sessionStart(),
      payloads.pre('toolu_04'),
      payloads.post('toolu_04'),
      payloads.stop(),
      payloads.sessionEnd(),
    ]) {
      const { err } = await hook(payload);
      expect(err).toBe('');
    }
    expect(await readdir(home)).toEqual([]);
  });

  it('with a broken config exits 0 and does nothing', async () => {
    await writeFile(paths(home).config, '{ nope');
    const { err } = await hook(payloads.post('toolu_05'));
    expect(err).toBe('');
    expect(await readdir(home)).toEqual(['config.json']);
  });

  it('removes markers older than a day', async () => {
    await initialise();
    const dir = paths(home).sessions;
    await mkdir(dir, { recursive: true });
    const old = join(dir, 'tool.toolu_old');
    const oldEnded = join(dir, 'ended.old-session');
    const fresh = join(dir, 'tool.toolu_fresh');
    await writeFile(old, new Date().toISOString());
    await writeFile(oldEnded, new Date().toISOString());
    await writeFile(fresh, new Date().toISOString());
    const past = new Date(Date.now() - STALE_MARKER_MS - 60_000);
    await utimes(old, past, past);
    await utimes(oldEnded, past, past);

    await hook(payloads.sessionStart());
    expect((await markers()).sort()).toEqual([SESSION, 'tool.toolu_fresh']);
  });

  describe('session nudge', () => {
    const cached: NudgeGoal = {
      level: 'none',
      nextLevel: 'bronze',
      thresholds: [
        { name: 'verified_tasks', current: 13, required: 25, met: false },
        { name: 'history_days', current: 2, required: 3, met: false },
      ],
      pending: { addressed: 2, outcomes: 1 },
    };
    const SUMMARY = [
      'SealKeeper. Level none, 13 of 25 verified tasks to bronze.',
      '2 tasks addressed to you, 1 outcome to report.',
      '/sealkeeper-prove works on this. Run it only when the user asks for it or agrees.',
    ].join('\n');

    it('SessionStart prints the summary from the cache once the nudge is on', async () => {
      await initialise(true, true);
      goal = cached;
      const { code, out, err } = await run(
        JSON.stringify(payloads.sessionStart()),
      );
      expect(code).toBe(0);
      expect(out).toBe(`${SUMMARY}\n`);
      expect(err).toBe('');
      expect(goalReads).toEqual([{ maxAgeMs: NUDGE_CACHE_MAX_MS }]);
      // The event is logged as without the nudge.
      expect(await logged()).toHaveLength(1);
      expect(fetches).toEqual([]);
    });

    it('prints again on a resume, and still logs one session', async () => {
      await initialise(true, true);
      goal = cached;
      await run(JSON.stringify(payloads.sessionStart()));
      const again = await run(
        JSON.stringify({ ...payloads.sessionStart(), source: 'resume' }),
      );
      expect(again.out).toBe(`${SUMMARY}\n`);
      expect(await logged()).toHaveLength(1);
    });

    it('prints nothing with the nudge off or never answered', async () => {
      goal = cached;
      await initialise(true, false);
      await hook(payloads.sessionStart());
      await rm(paths(home).config);
      await rm(paths(home).key);
      await initialise(true);
      await hook({ ...payloads.sessionStart(), session_id: 'other-session' });
      expect(goalReads).toEqual([]);
    });

    it('prints nothing offline or without a fresh cache', async () => {
      await initialise(true, true);
      goal = null;
      await hook(payloads.sessionStart());
      expect(goalReads).toEqual([{ maxAgeMs: NUDGE_CACHE_MAX_MS }]);
      expect(await logged()).toHaveLength(1);
    });

    it('prints nothing when reading the goal fails, and the event is logged', async () => {
      await initialise(true, true);
      goal = new Error('disk on fire');
      const { err } = await hook(payloads.sessionStart());
      expect(err).toBe('');
      expect(await logged()).toHaveLength(1);
    });

    it('prints nothing on the other hooks or without a config', async () => {
      goal = cached;
      await hook(payloads.sessionStart());
      await initialise(true, true);
      await hook(payloads.pre('toolu_09'));
      await hook(payloads.post('toolu_09'));
      await hook(payloads.stop());
      await hook(payloads.sessionEnd());
      expect(goalReads).toEqual([]);
    });

    it('SessionEnd refreshes the cached goal once the nudge is on', async () => {
      const agentId = await initialise(false, true);
      goalAnswer = {
        agentId,
        version: '1.2.0',
        level: 'none',
        nextLevel: 'bronze',
        thresholds: [],
        actions: [],
        pending: { addressed: 1, outcomes: 0 },
        asOf: null,
      };
      await hook(payloads.sessionStart());
      expect(fetches).toEqual([]);
      await hook(payloads.sessionEnd());
      expect(fetches).toEqual([`${API_URL}/v1/agents/${agentId}/goal`]);
      const cache = JSON.parse(await readFile(paths(home).goal, 'utf8'));
      expect(cache.goal.pending).toEqual({ addressed: 1, outcomes: 0 });
    });

    it('SessionEnd sends nothing for the goal with the nudge off', async () => {
      await initialise(false, false);
      await hook(payloads.sessionStart());
      await hook(payloads.sessionEnd());
      expect(fetches).toEqual([]);
    });

    it('SessionEnd stays quiet when the goal cannot be read', async () => {
      await initialise(false, true);
      await hook(payloads.sessionStart());
      const { err } = await hook(payloads.sessionEnd());
      expect(err).toBe('');
      expect(await logged()).toHaveLength(2);
    });
  });

  describe('agent per folder', () => {
    it('logs to the home of the folder the payload names as cwd', async () => {
      // No SEALKEEPER_HOME, so the folder map picks the home.
      const root = join(home, 'root');
      vi.stubEnv('SEALKEEPER_HOME', '');
      vi.stubEnv('SEALKEEPER_ROOT', root);
      const project = join(home, 'billing-project');
      await mkdir(join(project, 'src'), { recursive: true });
      const billing = paths(namedHome('billing', root));
      const agentId = (await createKey({}, billing)).agentId;
      await writeConfig(
        {
          agentId,
          operatorLogin: 'alice',
          name: 'billing',
          version: '2.0.0',
          apiUrl: API_URL,
          registeredAt: '2026-09-23T10:00:00Z',
        },
        billing,
      );
      await bindFolder(project, billing.home, root);

      // The hook runs from anywhere, the payload says where Claude Code is.
      await hook({
        ...payloads.sessionStart(),
        cwd: join(project, 'src'),
      });
      const events = await readDay(dayOf(new Date()), billing);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'session.start',
        version: '2.0.0',
      });
      expect(await readdir(billing.sessions)).toEqual([SESSION]);
      // The default agent in the root got nothing.
      expect(await readdir(root)).toEqual(['agents', 'agents.json']);
    });
  });
});

describe('parseHookInput', () => {
  const payload = (cwd: unknown) =>
    JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd });

  it('takes cwd only when it is an absolute path', () => {
    expect(parseHookInput(payload('/Users/alice/app'))?.cwd).toBe(
      '/Users/alice/app',
    );
    expect(parseHookInput(payload('app'))?.cwd).toBeNull();
    expect(parseHookInput(payload(''))?.cwd).toBeNull();
    expect(parseHookInput(payload(42))?.cwd).toBeNull();
    expect(parseHookInput(payload(undefined))?.cwd).toBeNull();
  });
});

describe('toolNameOf', () => {
  it('keeps built in names and maps what the taxonomy does not allow', () => {
    expect(toolNameOf('Read')).toBe('Read');
    expect(toolNameOf('mcp__srv__do_it')).toBe('mcp__srv__do_it');
    expect(toolNameOf('my tool')).toBe('my-tool');
    expect(toolNameOf('x'.repeat(100))).toHaveLength(64);
    expect(toolNameOf('')).toBeNull();
    expect(toolNameOf(42)).toBeNull();
  });
});

describe('readStdin', () => {
  it('reads the whole stream', async () => {
    const stream = new PassThrough();
    const text = readStdin(stream as unknown as NodeJS.ReadStream);
    stream.write('{"a":');
    stream.end('1}');
    expect(await text).toBe('{"a":1}');
  });

  it('gives up after the timeout', async () => {
    const stream = new PassThrough();
    expect(await readStdin(stream as unknown as NodeJS.ReadStream, 20)).toBe(
      null,
    );
  });
});
