// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { CLI_VERSION_HEADER, type Event } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCK_FILE,
  resetBackgroundSyncThrottle,
  STAMP_FILE,
} from '../background-sync.js';
import { parseHookInput } from '../claude-code.js';
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
import { toolNameOf } from '../names.js';
import { NUDGE_CACHE_MAX_MS, type NudgeGoal } from '../nudge.js';
import { createProgram } from '../program.js';
import { VERSION } from '../version.js';
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
  // The CLI version header of each request, in the same order (VOU-453).
  let versions: (string | null)[];
  // The cached goal the session nudge reads, and every read of it.
  let goal: NudgeGoal | null | Error;
  let goalReads: { maxAgeMs: number }[];
  // What GET /goal answers, 404 while null.
  let goalAnswer: Record<string, unknown> | null;

  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetches.push(String(input));
    versions.push(new Headers(init?.headers).get(CLI_VERSION_HEADER));
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
    versions = [];
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
    // init installs the hooks, there is no adapter command (VOU-603).
    expect(help).toMatch(/^ {2}init\b/m);
    expect(help).not.toMatch(/^ {2}adapter\b/m);
  });

  // VOU-627. An interactive session is the operator's own work, so the
  // hooks write no event. Only a routine run records a session.
  it('SessionStart and SessionEnd write no event and no marker', async () => {
    await initialise(false);
    await hook(payloads.sessionStart());
    await hook({ ...payloads.sessionStart(), source: 'compact' });
    await hook(payloads.sessionEnd());
    expect(await logged()).toEqual([]);
    expect(await markers()).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('SessionEnd syncs what the log holds, whatever session it ends', async () => {
    await initialise();
    await seedSessions(1);
    // No SessionStart was seen for this session, and it still syncs.
    await hook(payloads.sessionEnd());
    expect(fetches).toEqual([`${API_URL}/v1/events`]);
    expect(await countPending(paths(home))).toBe(0);
  });

  it('SessionEnd with auto-sync off sends nothing', async () => {
    await initialise(false);
    await seedSessions(1);
    const { err } = await hook(payloads.sessionEnd());
    expect(err).toBe('');
    expect(fetches).toEqual([]);
    expect((await readCursor(paths(home))).lastAcked).toBeNull();
  });

  // A CLI before 0.5.0 kept a marker per session, and installed Stop.
  it('Stop records nothing, and SessionEnd removes the markers an older CLI left', async () => {
    await initialise(false);
    const dir = paths(home).sessions;
    await mkdir(dir, { recursive: true });
    for (const name of [SESSION, `ended.${SESSION}`, 'tool.toolu_old']) {
      await writeFile(join(dir, name), new Date().toISOString());
    }
    const { err } = await hook(payloads.stop());
    expect(err).toBe('');
    expect(await markers()).toHaveLength(3);
    await hook(payloads.sessionEnd());
    await expect(stat(dir)).rejects.toThrow();
    expect(await logged()).toEqual([]);
  });

  it('a failed sync at session end still exits 0 with one warning', async () => {
    await initialise();
    await seedSessions(1);
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
    expect(await countPending(paths(home))).toBe(1);
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

  async function seedSessions(count: number): Promise<void> {
    for (let n = 0; n < count; n++) {
      await appendEvent(
        {
          event_id: randomUUID(),
          type: 'session.start',
          occurred_at: new Date().toISOString(),
          version: '1.2.0',
          payload: { session_id: `seeded-${n}` },
        },
        paths(home),
      );
    }
  }

  it('a second SessionEnd within five minutes of a sync sends nothing and prints nothing', async () => {
    await initialise();
    await seedSessions(1);
    await hook(payloads.sessionEnd());
    expect(fetches).toEqual([`${API_URL}/v1/events`]);
    await seedSessions(2);
    const other = { session_id: 'second-session' };
    const { err } = await hook({ ...payloads.sessionEnd(), ...other });
    expect(err).toBe('');
    expect(fetches).toEqual([`${API_URL}/v1/events`]);
    expect(await countPending(paths(home))).toBe(2);
  });

  it('SessionEnd stays out, silently, while another sync holds the lock', async () => {
    await initialise();
    await seedSessions(1);
    await writeFile(join(home, LOCK_FILE), `${process.pid}\n`);
    const { err } = await hook(payloads.sessionEnd());
    expect(err).toBe('');
    expect(fetches).toEqual([]);
  });

  it('SessionEnd stops starting rounds after its deadline', async () => {
    await initialise();
    await seedSessions(1002);
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
    await seedSessions(2);
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

  // VOU-451, VOU-627. A machine keeps the tool hooks and Stop of an older
  // install until the install runs again, and each of them records
  // nothing, prints nothing and exits 0.
  it.each([
    ['PreToolUse', payloads.pre('toolu_01ABCdef')],
    ['PostToolUse', payloads.post('toolu_01ABCdef')],
    ['PostToolUseFailure', payloads.failure('toolu_01ABCdef')],
    [
      'an interrupted PostToolUseFailure',
      payloads.failure('toolu_02', 'Bash', true),
    ],
    ['Stop', payloads.stop()],
  ])('%s records nothing', async (_label, payload) => {
    await initialise();
    const { err } = await hook(payload);
    expect(err).toBe('');
    expect(await logged()).toEqual([]);
    expect(await markers()).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('a session with tool events in it logs nothing and leaks nothing', async () => {
    await initialise(false);
    const results = [
      await hook(payloads.sessionStart()),
      await hook(payloads.pre('toolu_03')),
      await hook(payloads.post('toolu_03')),
      await hook(payloads.pre('toolu_04')),
      await hook(payloads.failure('toolu_04')),
      await hook(payloads.stop()),
      await hook(payloads.sessionEnd()),
    ];
    expect(await logged()).toEqual([]);
    expect(await markers()).toEqual([]);
    const files = await readdir(home);
    const texts = await Promise.all(
      files
        .filter((f) => !f.startsWith('key'))
        .map((f) => readFile(join(home, f), 'utf8').catch(() => '')),
    );
    for (const text of [...texts, ...results.map((r) => r.err)]) {
      expect(text).not.toContain('secret');
      expect(text).not.toContain('toolu_');
    }
  });

  it.each([
    ['not JSON', '{ nope'],
    ['empty', ''],
    ['an array', '[1, 2]'],
    ['no event name', JSON.stringify({ session_id: SESSION })],
    ['an unknown event', JSON.stringify(base('Notification'))],
  ])('%s on stdin exits 0 and writes nothing', async (_label, stdin) => {
    await initialise();
    const { err } = await hook(stdin);
    expect(err).toBe('');
    expect(await logged()).toEqual([]);
    expect(await markers()).toEqual([]);
    expect(fetches).toEqual([]);
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
      '/sealkeeper-run works on this. Run it only when the user asks for it or agrees.',
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
      expect(await logged()).toEqual([]);
      expect(fetches).toEqual([]);
    });

    it('prints again on a resume', async () => {
      await initialise(true, true);
      goal = cached;
      await run(JSON.stringify(payloads.sessionStart()));
      const again = await run(
        JSON.stringify({ ...payloads.sessionStart(), source: 'resume' }),
      );
      expect(again.out).toBe(`${SUMMARY}\n`);
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
    });

    it('prints nothing when reading the goal fails', async () => {
      await initialise(true, true);
      goal = new Error('disk on fire');
      const { err } = await hook(payloads.sessionStart());
      expect(err).toBe('');
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

    // VOU-627. The goal is read at SealKeeper moments only, never at the
    // end of a session, so an unrelated session leaves no trace in the
    // API's request log.
    it.each([true, false])(
      'SessionEnd never reads the goal, nudge %s',
      async (nudge) => {
        const agentId = await initialise(false, nudge);
        goalAnswer = { agentId, version: '1.2.0' };
        await hook(payloads.sessionStart());
        await hook(payloads.sessionEnd());
        expect(fetches).toEqual([]);
        expect(await readFile(paths(home).goal, 'utf8').catch(() => null)).toBe(
          null,
        );
      },
    );

    // VOU-627. A sync sends only pending events, so the end of a session
    // with no SealKeeper work makes no request at all, with automatic sync
    // on and the nudge on or off.
    it.each([true, false])(
      'SessionEnd with an empty queue makes no request, nudge %s',
      async (nudge) => {
        const agentId = await initialise(true, nudge);
        goalAnswer = { agentId, version: '1.2.0' };
        await hook(payloads.sessionStart());
        const { err } = await hook(payloads.sessionEnd());
        expect(err).toBe('');
        expect(fetches).toEqual([]);
        // The gate ran, so the empty queue is what kept it quiet, not the
        // throttle or automatic sync being off.
        expect(await stat(join(home, STAMP_FILE))).toBeTruthy();
      },
    );

    // VOU-453. The sync of a SessionEnd goes through the API client.
    it('SessionEnd sends the CLI version with the sync, and reads no goal', async () => {
      await initialise(true, true);
      await seedSessions(1);
      await hook(payloads.sessionEnd());
      expect(fetches).toEqual([`${API_URL}/v1/events`]);
      expect(versions).toEqual([VERSION]);
    });
  });

  describe('agent per folder', () => {
    it('syncs the home of the folder the payload names as cwd', async () => {
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
          autoSync: true,
        },
        billing,
      );
      await bindFolder(project, billing.home, root);
      await appendEvent(
        {
          event_id: randomUUID(),
          type: 'session.start',
          occurred_at: new Date().toISOString(),
          version: '2.0.0',
          payload: { session_id: 'routine-run' },
        },
        billing,
      );

      // The hook runs from anywhere, the payload says where Claude Code is.
      await hook({
        ...payloads.sessionEnd(),
        cwd: join(project, 'src'),
      });
      expect(fetches).toEqual([`${API_URL}/v1/events`]);
      expect(await countPending(billing)).toBe(0);
      // The default agent in the root got nothing.
      expect(await readdir(root)).toEqual(['agents', 'agents.json']);
    });
  });
});

describe('parseHookInput', () => {
  const payload = (cwd: unknown) =>
    JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd });

  // VOU-627. The session id is no longer read, nothing needs it.
  it('reads only the event name, cwd and the model', () => {
    expect(parseHookInput(payload('/Users/alice/app'))).toEqual({
      event: 'Stop',
      cwd: '/Users/alice/app',
      model: null,
    });
  });

  it('takes cwd only when it is an absolute path', () => {
    expect(parseHookInput(payload('/Users/alice/app'))?.cwd).toBe(
      '/Users/alice/app',
    );
    expect(parseHookInput(payload('app'))?.cwd).toBeNull();
    expect(parseHookInput(payload(''))?.cwd).toBeNull();
    expect(parseHookInput(payload(42))?.cwd).toBeNull();
    expect(parseHookInput(payload(undefined))?.cwd).toBeNull();
  });

  // VOU-614. The model id SessionStart names, as it came.
  it('takes the model only when it is a string', () => {
    const start = (model: unknown) =>
      parseHookInput(
        JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: 's1',
          model,
        }),
      )?.model;
    expect(start('claude-opus-5')).toBe('claude-opus-5');
    expect(start(42)).toBeNull();
    expect(start(undefined)).toBeNull();
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
