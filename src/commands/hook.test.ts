// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
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
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Event } from '@vouched-dev/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STALE_MARKER_MS, toolNameOf } from '../claude-code.js';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { dayOf, readCursor, readDay } from '../log.js';
import { createProgram } from '../program.js';
import { readStdin } from './hook.js';

const API_URL = 'http://api.test';
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
};

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('hook claude-code', () => {
  let home: string;
  let fetches: string[];

  const fakeFetch = (async (input: string | URL | Request) => {
    fetches.push(String(input));
    return Response.json({ accepted: 1, duplicates: 0 });
  }) as typeof fetch;

  async function run(stdin: string | null): Promise<RunResult> {
    const program = createProgram({
      hook: {
        fetch: fakeFetch,
        sleep: async () => {},
        readStdin: async () => stdin,
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

  async function logged(): Promise<Event[]> {
    return readDay(dayOf(new Date()), paths(home));
  }

  async function markers(): Promise<string[]> {
    return readdir(paths(home).sessions).catch(() => []);
  }

  async function initialise(autoSync = true): Promise<void> {
    const agentId = (await createKey({}, paths(home))).agentId;
    await writeConfig(
      {
        agentId,
        operatorLogin: 'carelmeyer',
        name: 'scout',
        version: '1.2.0',
        apiUrl: API_URL,
        registeredAt: '2026-09-23T10:00:00Z',
        autoSync,
      },
      paths(home),
    );
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vouched-hook-'));
    vi.stubEnv('VOUCHED_HOME', home);
    vi.stubEnv('VOUCHED_API_URL', '');
    fetches = [];
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
    expect(help).toMatch(/^ {2}adapter claude-code\b/m);
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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    await hook(payloads.sessionStart());
    vi.setSystemTime(new Date('2026-09-23T10:00:45.000Z'));
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
        sleep: async () => {},
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
    expect(err).toBe('vouched: sync did not finish, run vouched sync\n');
    expect((await logged()).map((e) => e.type)).toEqual([
      'session.start',
      'session.end',
    ]);
  });

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
