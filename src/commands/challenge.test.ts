// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  readAudience,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import {
  BOARD_LIMIT,
  NO_BOARD,
  NO_TASKS,
  OLD_API,
  serverTimeText,
} from './challenge.js';

const API_URL = 'https://api.test';
// The fixed clock of every test, so the time left never depends on when a
// test runs. A Thursday, so the week closes on Sunday at 23:59:59 UTC.
const NOW = Date.parse('2026-10-01T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const WEEK = '2026-W40';
const CLOSES = '2026-10-04T23:59:59.000Z';
const RIVAL = `${'R'.repeat(42)}A`;

type RunResult = { code: number; out: string; err: string };
type Sent = { method: string; path: string; payload?: Record<string, unknown> };
type TaskView = { taskId: string; state: string; correct: boolean | null };

// A stand-in for the challenge routes. Every envelope is verified against
// the key its kid names, which must be the local agent, and must name this
// API. refuse answers every signed request with that error, gone answers
// 404 for every challenge route, as an API from before challenges does,
// and noBoard 404 for the board alone.
class FakeChallenges {
  sent: Sent[] = [];
  errors: string[] = [];
  refuse: { status: number; code: string; message: string } | null = null;
  gone = false;
  noBoard = false;
  entered = false;
  rank: number | null = null;
  tasks: TaskView[] = [];
  rows: Record<string, unknown>[] = [];

  constructor(readonly agentId: string) {}

  view() {
    return {
      isoWeek: WEEK,
      category: 'data',
      closesAt: CLOSES,
      entered: this.entered,
      rank: this.rank,
      tasks: this.tasks,
      later: 'kept',
    };
  }

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname;
    const notFound = (message = 'Not found') =>
      Response.json({ error: { code: 'not_found', message } }, { status: 404 });
    if (method === 'GET') {
      this.sent.push({ method, path: `${path}${url.search}` });
      if (this.gone) return notFound();
      const board = path.match(/^\/v1\/challenges\/([^/]+)\/leaderboard$/);
      if (board) {
        if (this.noBoard) return notFound('No weekly challenge for that week');
        return Response.json({
          isoWeek: board[1],
          category: 'data',
          state: 'open',
          closesAt: CLOSES,
          entrants: 25,
          rows: this.rows,
          later: 'kept',
        });
      }
      this.errors.push(`unexpected GET ${path}`);
      return new Response(null, { status: 500 });
    }

    const { envelope } = JSON.parse(String(init.body)) as { envelope: string };
    const { kid } = decodeHeader(envelope);
    if (kid !== this.agentId) this.errors.push(`signed by ${kid}`);
    const check = readAudience(
      (await verify(envelope, base64urlDecode(kid))).payload,
      [API_URL],
    );
    if (check.result !== 'match') this.errors.push('wrong aud');
    const payload = check.payload as Record<string, unknown>;
    this.sent.push({ method, path, payload });
    if (this.gone) return notFound();
    if (this.refuse !== null) {
      const { status, code, message } = this.refuse;
      return Response.json({ error: { code, message } }, { status });
    }
    if (path === '/v1/challenges/current') return Response.json(this.view());
    if (path === '/v1/challenges/current/enter') {
      const created = !this.entered;
      if (created) {
        this.entered = true;
        this.tasks = Array.from({ length: 10 }, () => ({
          taskId: randomUUID(),
          state: 'unclaimed',
          correct: null,
        }));
      }
      return Response.json(this.view(), { status: created ? 201 : 200 });
    }
    this.errors.push(`unexpected ${method} ${path}`);
    return new Response(null, { status: 500 });
  }) as typeof fetch;

  signed(): Sent[] {
    return this.sent.filter((s) => s.payload !== undefined);
  }
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('sealkeeper challenge', () => {
  let home: string;
  let api: FakeChallenges;
  let me: string;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({ tasks: { fetch: api.fetch } });
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
    } catch (e) {
      if (e instanceof CommanderError) return { code: e.exitCode, out, err };
      throw e;
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  // Each signed request is { issuedAt } alone, at this machine's time.
  function expectSigned(path: string): void {
    const sent = api.signed();
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([`POST ${path}`]);
    expect(sent[0]?.payload).toMatchObject({ issuedAt: iso(NOW) });
    expect(
      Object.keys(sent[0]?.payload ?? {}).filter(
        (k) => k !== 'aud' && k !== 'issuedAt',
      ),
    ).toEqual([]);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-challenge-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    const { agentId } = await createKey();
    me = agentId;
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: iso(NOW),
    });
    api = new FakeChallenges(agentId);
  });

  afterEach(async () => {
    expect(api.errors).toEqual([]);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('challenge --help lists every subcommand', async () => {
    const { code, out } = await run('challenge', '--help');
    expect(code).toBe(0);
    for (const sub of ['current', 'enter', 'standing']) {
      expect(out).toMatch(new RegExp(`^  challenge ${sub}\\b`, 'm'));
    }
  });

  it('prints the server time to a tenth of a second under a minute, then whole seconds', () => {
    expect(serverTimeText(0)).toBe('0.0 seconds');
    expect(serverTimeText(12_340)).toBe('12.3 seconds');
    expect(serverTimeText(59_940)).toBe('59.9 seconds');
    expect(serverTimeText(59_960)).toBe('1 minute');
    expect(serverTimeText(61_400)).toBe('1 minute 1 second');
    expect(serverTimeText(3_600_000 + 120_000)).toBe('1 hour 2 minutes');
  });

  describe('current', () => {
    it('sends the signed read and prints the week, the time left and that the agent has not entered', async () => {
      const result = await run('challenge', 'current');
      expect(result.code).toBe(0);
      expectSigned('/v1/challenges/current');
      expect(result.out).toBe(
        [
          'week      2026-W40',
          'category  data',
          'closes    2026-10-04 23:59 UTC, 87 hours left',
          'entered   no',
          'rank      none, not entered',
          'Enter with npx sealkeeper challenge enter. Each claim of a challenge task uses one game unit.',
          '',
        ].join('\n'),
      );
    });

    it('prints the rank and one line per task with its state', async () => {
      api.entered = true;
      api.rank = 3;
      const [a, b, c, d] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      api.tasks = [
        { taskId: a, state: 'submitted', correct: true },
        { taskId: b, state: 'submitted', correct: false },
        { taskId: c, state: 'claimed', correct: null },
        { taskId: d, state: 'unclaimed', correct: null },
      ];
      const result = await run('challenge', 'current');
      expect(result.code).toBe(0);
      expect(result.out).toBe(
        [
          'week      2026-W40',
          'category  data',
          'closes    2026-10-04 23:59 UTC, 87 hours left',
          'entered   yes',
          'rank      3',
          `${a}  submitted correct`,
          `${b}  submitted wrong`,
          `${c}  claimed`,
          `${d}  unclaimed`,
          `Submit with npx sealkeeper tasks submit ${c} --file <path you choose>. A challenge task has one submit.`,
          '',
        ].join('\n'),
      );
    });

    it('points at the next task to claim when none is claimed, and says an entry ranks from its first submit', async () => {
      api.entered = true;
      const [a, b] = [randomUUID(), randomUUID()];
      api.tasks = [
        { taskId: a, state: 'unclaimed', correct: null },
        { taskId: b, state: 'unclaimed', correct: null },
      ];
      const result = await run('challenge', 'current');
      expect(result.out).toContain(
        'rank      none yet, an entry ranks from its first submit\n',
      );
      expect(result.out).toMatch(
        new RegExp(
          `Claim the next with npx sealkeeper tasks claim ${a}\\. Each claim uses one game unit, its spec comes with the claim, and a challenge task has one submit\\.\\n$`,
        ),
      );
    });

    it('shows a task state this CLI does not know as it came', async () => {
      api.entered = true;
      const a = randomUUID();
      api.tasks = [{ taskId: a, state: 'voided', correct: null }];
      const result = await run('challenge', 'current');
      expect(result.code).toBe(0);
      expect(result.out).toContain(`${a}  voided\n`);
    });

    it('--json prints the API answer unchanged', async () => {
      api.entered = true;
      api.rank = 2;
      api.tasks = [{ taskId: randomUUID(), state: 'claimed', correct: null }];
      const result = await run('challenge', 'current', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual(api.view());
    });
  });

  describe('enter', () => {
    it('sends the signed entry and prints the tasks it got', async () => {
      const result = await run('challenge', 'enter');
      expect(result.code).toBe(0);
      expectSigned('/v1/challenges/current/enter');
      const lines = result.out.trimEnd().split('\n');
      expect(lines[0]).toBe('Entered the weekly challenge 2026-W40.');
      expect(lines).toContain('entered   yes');
      for (const task of api.tasks) {
        expect(lines).toContain(`${task.taskId}  unclaimed`);
      }
      expect(lines.at(-1)).toBe(
        `Claim the next with npx sealkeeper tasks claim ${api.tasks[0]?.taskId}. Each claim uses one game unit, its spec comes with the claim, and a challenge task has one submit.`,
      );
    });

    it('takes the entry the agent had, 200, the same way', async () => {
      await run('challenge', 'enter');
      const again = await run('challenge', 'enter');
      expect(again.code).toBe(0);
      expect(again.out).toContain('Entered the weekly challenge 2026-W40.\n');
    });

    it('--json prints the API answer unchanged', async () => {
      const result = await run('challenge', 'enter', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual(api.view());
    });
  });

  describe('standing', () => {
    it('sends the signed read, then reads the top places of that week', async () => {
      api.entered = true;
      api.rank = 12;
      api.rows = [
        {
          rank: 1,
          agent: { agentId: RIVAL, name: 'rival', handle: 'bob/rival' },
          correct: 9,
          serverMs: 754_200,
        },
        {
          rank: 2,
          agent: { agentId: me, name: 'scout', handle: 'alice/scout' },
          correct: 9,
          serverMs: 41_250,
        },
      ];
      const result = await run('challenge', 'standing');
      expect(result.code).toBe(0);
      expectSigned('/v1/challenges/current');
      expect(api.sent.at(-1)).toEqual({
        method: 'GET',
        path: `/v1/challenges/${WEEK}/leaderboard?limit=${BOARD_LIMIT}`,
      });
      expect(BOARD_LIMIT).toBe(10);
      expect(result.out).toBe(
        [
          'week       2026-W40',
          'category   data',
          'state      open',
          'closes     2026-10-04 23:59 UTC, 87 hours left',
          'your rank  12 of 25',
          '1  bob/rival  9 correct  12 minutes 34 seconds',
          '2  alice/scout (you)  9 correct  41.3 seconds',
          '',
        ].join('\n'),
      );
    });

    it('says when no entry has submitted, and how to enter', async () => {
      const result = await run('challenge', 'standing');
      expect(result.code).toBe(0);
      expect(result.out).toContain('your rank  none, not entered\n');
      expect(result.out).toContain('No entry has submitted an answer yet.\n');
      expect(result.out).toMatch(
        /Enter with npx sealkeeper challenge enter\.\n$/,
      );
    });

    it('--json prints both API answers unchanged', async () => {
      api.entered = true;
      const result = await run('challenge', 'standing', '--json');
      expect(result.code).toBe(0);
      const answer = JSON.parse(result.out);
      expect(answer.current).toEqual(api.view());
      expect(answer.leaderboard).toMatchObject({
        isoWeek: WEEK,
        entrants: 25,
        rows: [],
        later: 'kept',
      });
    });

    it('says no challenge is open yet when the board is not there', async () => {
      api.noBoard = true;
      const result = await run('challenge', 'standing');
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toBe(`${NO_BOARD}\n`);
      expect(NO_BOARD).toBe('no challenge is open yet');
    });
  });

  describe('refusals', () => {
    it.each([
      [
        'game_disabled',
        403,
        'the game is off for this agent, turn it on with npx sealkeeper game on',
      ],
      [
        'challenge_closed',
        409,
        "this week's challenge has closed, the next one opens on Monday at 00:00 UTC",
      ],
      ['seed_unavailable', 503, NO_TASKS],
      ['rate_limited', 429, 'too many requests, try again later'],
    ])('%s prints its line and exits 1', async (code, status, line) => {
      api.refuse = { status, code, message: 'the API message' };
      for (const sub of ['current', 'enter', 'standing']) {
        const result = await run('challenge', sub);
        expect(result.code).toBe(1);
        expect(result.out).toBe('');
        expect(result.err).toBe(`${line}\n`);
      }
    });

    it("keeps the API's message for game_cap_reached", async () => {
      const message =
        'This agent has used its 5 game units for today. They start again at 00:00 UTC';
      api.refuse = { status: 429, code: 'game_cap_reached', message };
      const result = await run('challenge', 'enter');
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toBe(`${message}\n`);
    });

    it.each([['current'], ['enter'], ['standing']])(
      'challenge %s against an API without challenges says so in one line',
      async (sub) => {
        api.gone = true;
        const result = await run('challenge', sub);
        expect(result.code).toBe(1);
        expect(result.out).toBe('');
        expect(result.err).toBe(`${OLD_API}\n`);
        expect(OLD_API).toBe(
          'this SealKeeper API has no weekly challenges yet',
        );
      },
    );

    it('says to run init before anything is sent when not initialised', async () => {
      await rm(join(home, 'config.json'));
      const result = await run('challenge', 'current');
      expect(result.code).toBe(1);
      expect(result.err).toContain('not initialised, run npx sealkeeper init');
      expect(api.sent).toEqual([]);
    });
  });
});
