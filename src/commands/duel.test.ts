// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  decodeTasksCursor,
  encodeTasksCursor,
  readAudience,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import type { DuelResponse } from '../responses.js';
import {
  autoCategory,
  BAD_AGENT,
  BAD_CATEGORY,
  BAD_ID,
  BAD_STATE,
  LIST_LIMIT,
  NO_AGENT,
  NO_CATEGORY,
  NO_DUEL,
  NO_SEEK,
  OLD_API,
  SHOW_PAGES,
  timeLeft,
} from './duel.js';

const API_URL = 'https://api.test';
// The fixed clock of every test, so the time left never depends on when a
// test runs.
const NOW = Date.parse('2026-10-01T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const RIVAL = `${'R'.repeat(42)}A`;
const THIRD = `${'T'.repeat(42)}A`;

type RunResult = { code: number; out: string; err: string };
type Sent = { method: string; path: string; payload?: Record<string, unknown> };

// A duel as the fake stores it, both task ids kept. The fake shows the
// caller its own task id in a signed answer and none in the public one, as
// the API does.
type Side = { agentId: string; handle: string; taskId?: string };
type Stored = {
  id: string;
  category: string;
  state: string;
  origin: string;
  challenger: Side;
  opponent: Side;
  rematchOf: string | null;
  invitedAt: string | null;
  startedAt: string | null;
  deadlineAt: string | null;
  decidedAt: string | null;
  result: string | null;
  forfeit: boolean;
};

// A stand-in for the duel routes, GET /v1/game/categories and the public
// task read. Every envelope is verified against the key its kid names,
// which must be the local agent, and must name this API. refuse answers
// every signed request with that error, and gone answers 404 for every
// duel and game route, as an API from before duels does.
class FakeDuels {
  duels = new Map<string, Stored>();
  tasks = new Map<string, Record<string, unknown>>();
  sent: Sent[] = [];
  errors: string[] = [];
  refuse: { status: number; code: string; message: string } | null = null;
  gone = false;
  // Whether a seek matches at once.
  match = false;
  // Duels of other states filling the pages ahead of the one shown.
  filler = 0;
  // Runs once after the next public read of a duel, to move it on between
  // that read and the next.
  afterRead: (() => void) | null = null;
  // The categories GET /v1/game/categories lists, in its order.
  categories = ['code', 'data'];
  // The verified tasks of each category in the agent's Trust answer, or
  // null for an API that answers the Trust read with 404.
  trust: Record<string, number> | null = {};

  constructor(readonly agentId: string) {}

  add(over: Partial<Stored> = {}): Stored {
    const duel: Stored = {
      id: randomUUID(),
      category: 'data',
      state: 'active',
      origin: 'seek',
      challenger: {
        agentId: this.agentId,
        handle: 'alice/scout',
        taskId: randomUUID(),
      },
      opponent: { agentId: RIVAL, handle: 'bob/rival', taskId: randomUUID() },
      rematchOf: null,
      invitedAt: null,
      startedAt: iso(NOW - HOUR),
      deadlineAt: iso(NOW + 47 * HOUR + 12 * 60_000 + 30_000),
      decidedAt: null,
      result: null,
      forfeit: false,
      ...over,
    };
    this.duels.set(duel.id, duel);
    return duel;
  }

  // The duel as the agent sees it, its own task id only, or none for the
  // public read.
  view(d: Stored, viewer?: string): DuelResponse {
    const side = (s: Side) => {
      const { taskId, ...rest } = s;
      return s.agentId === viewer && taskId !== undefined
        ? { ...rest, taskId }
        : rest;
    };
    return {
      ...d,
      challenger: side(d.challenger),
      opponent: side(d.opponent),
      later: 'kept',
    };
  }

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname;
    const notFound = (message = 'Not found') =>
      Response.json({ error: { code: 'not_found', message } }, { status: 404 });
    if (
      this.gone &&
      (path.startsWith('/v1/duels') || path.startsWith('/v1/game'))
    ) {
      this.sent.push({ method, path });
      return notFound();
    }
    if (method === 'GET') {
      this.sent.push({ method, path });
      if (path === '/v1/game/categories') {
        return Response.json({
          categories: this.categories.map((category) => ({ category })),
          later: 'kept',
        });
      }
      if (path === `/v1/agents/${this.agentId}/trust`) {
        if (this.trust === null) return notFound('Not found');
        return Response.json({
          agentId: this.agentId,
          trust: 120,
          categories: Object.entries(this.trust).map(([category, tasks]) => ({
            category,
            trust: tasks * 10,
            tasks,
          })),
          later: 'kept',
        });
      }
      const task = path.match(/^\/v1\/tasks\/([^/]+)$/);
      if (task) {
        const found = this.tasks.get(task[1] ?? '');
        return found ? Response.json(found) : notFound();
      }
      const one = path.match(/^\/v1\/duels\/([^/]+)$/);
      if (one) {
        const id = one[1] ?? '';
        if (!/^[0-9a-f-]{36}$/.test(id)) {
          return Response.json(
            { error: { code: 'validation_failed', message: 'Bad id' } },
            { status: 400 },
          );
        }
        const d = this.duels.get(id);
        if (!d) return notFound('Duel not found');
        const answer = Response.json(this.view(d));
        const after = this.afterRead;
        this.afterRead = null;
        after?.();
        return answer;
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
    if (typeof payload.issuedAt !== 'string') this.errors.push('no issuedAt');
    this.sent.push({ method, path, payload });
    if (this.refuse !== null) {
      const { status, code, message } = this.refuse;
      return Response.json({ error: { code, message } }, { status });
    }
    const me = this.agentId;

    if (method === 'POST' && path === '/v1/duels/seek') {
      const seek = {
        id: randomUUID(),
        category: payload.category,
        state: this.match ? 'matched' : 'open',
        expiresAt: iso(NOW + 24 * HOUR),
        duelId: null as string | null,
      };
      if (!this.match) return Response.json({ seek }, { status: 201 });
      const d = this.add({ category: String(payload.category) });
      seek.duelId = d.id;
      return Response.json(
        { seek, duel: this.view(d, me), later: 'kept' },
        { status: 201 },
      );
    }
    const cancel = path.match(/^\/v1\/duels\/seek\/([^/]+)$/);
    if (method === 'DELETE' && cancel) {
      if (payload.seekId !== cancel[1]) this.errors.push('seekId mismatch');
      if (cancel[1] === '00000000-0000-4000-8000-000000000404') {
        return notFound('Seek not found');
      }
      return Response.json({
        seek: {
          id: cancel[1],
          category: 'data',
          state: 'cancelled',
          expiresAt: iso(NOW + HOUR),
          duelId: null,
        },
        later: 'kept',
      });
    }
    if (path === '/v1/duels/challenge') {
      if (payload.opponent === 'carol/nobody') {
        return notFound('Opponent not found');
      }
      const d = this.add({
        state: 'invited',
        origin: 'challenge',
        category: String(payload.category),
        opponent: { agentId: RIVAL, handle: String(payload.opponent) },
        challenger: { agentId: me, handle: 'alice/scout' },
        invitedAt: iso(NOW),
        startedAt: null,
        deadlineAt: null,
      });
      return Response.json(this.view(d, me), { status: 201 });
    }
    if (path === '/v1/duels/mine' || path === '/v1/duels/inbox') {
      const inbox = path === '/v1/duels/inbox';
      const state = inbox ? 'invited' : String(payload.state);
      const all = [...this.duels.values()].filter(
        (d) =>
          d.state === state &&
          (inbox
            ? d.opponent.agentId === me
            : d.challenger.agentId === me || d.opponent.agentId === me),
      );
      // filler duels of this agent before the real ones, one page each.
      const limit = Number(payload.limit);
      const page =
        payload.cursor === undefined
          ? 0
          : Number(decodeTasksCursor(String(payload.cursor))?.atMicros);
      if (page < this.filler) {
        const fill = Array.from({ length: limit }, () =>
          this.view(
            {
              ...[...this.duels.values()][0],
              id: randomUUID(),
              state,
            } as Stored,
            me,
          ),
        );
        const nextCursor = encodeTasksCursor({
          atMicros: String(page + 1),
          id: '00000000-0000-4000-8000-000000000000',
        });
        return Response.json({ duels: fill, nextCursor });
      }
      return Response.json({
        duels: all.map((d) => this.view(d, me)),
        nextCursor: null,
        later: 'kept',
      });
    }
    const action = path.match(
      /^\/v1\/duels\/([^/]+)\/(rematch|accept|decline)$/,
    );
    if (action) {
      const [, id, verb] = action;
      if (payload.duelId !== id) this.errors.push('duelId mismatch');
      const d = this.duels.get(id ?? '');
      if (!d) return notFound('Duel not found');
      if (verb === 'accept') {
        Object.assign(d, {
          state: 'active',
          startedAt: iso(NOW),
          deadlineAt: iso(NOW + 48 * HOUR),
        });
        d.challenger.taskId = randomUUID();
        d.opponent.taskId = randomUUID();
        return Response.json(this.view(d, me));
      }
      if (verb === 'decline') {
        d.state = 'declined';
        return Response.json(this.view(d, me));
      }
      const other = d.challenger.agentId === me ? d.opponent : d.challenger;
      const next = this.add({
        state: 'invited',
        origin: 'rematch',
        rematchOf: d.id,
        challenger: { agentId: me, handle: 'alice/scout' },
        opponent: { agentId: other.agentId, handle: other.handle },
        invitedAt: iso(NOW),
        startedAt: null,
        deadlineAt: null,
      });
      return Response.json(this.view(next, me), { status: 201 });
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

describe('sealkeeper duel', () => {
  let home: string;
  let api: FakeDuels;
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

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-duel-'));
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
    api = new FakeDuels(agentId);
  });

  afterEach(async () => {
    expect(api.errors).toEqual([]);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('duel --help lists every subcommand', async () => {
    const { code, out } = await run('duel', '--help');
    expect(code).toBe(0);
    for (const sub of [
      'seek',
      'unseek',
      'challenge',
      'rematch',
      'inbox',
      'accept',
      'decline',
      'list',
      'show',
      'categories',
    ]) {
      expect(out).toMatch(new RegExp(`^  duel ${sub}\\b`, 'm'));
    }
  });

  // Rounded up to the minute and at least one, as sync prints a wait.
  it('prints whole hours and minutes left, never seconds', () => {
    expect(timeLeft(47 * HOUR + 12 * 60_000 + 59_000)).toBe(
      '47 hours 13 minutes left',
    );
    expect(timeLeft(HOUR + 60_000)).toBe('1 hour 1 minute left');
    expect(timeLeft(48 * HOUR)).toBe('48 hours left');
    expect(timeLeft(59 * 60_000)).toBe('59 minutes left');
    expect(timeLeft(30_000)).toBe('1 minute left');
    expect(timeLeft(0)).toBe('passed');
  });

  describe('seek and unseek', () => {
    it('seek sends the category and says the seek is open', async () => {
      const result = await run('duel', 'seek', '--category', 'data');
      expect(result.code).toBe(0);
      expect(api.signed()).toHaveLength(1);
      expect(api.signed()[0]?.method).toBe('POST');
      expect(api.signed()[0]?.path).toBe('/v1/duels/seek');
      expect(Object.keys(api.signed()[0]?.payload ?? {}).sort()).toEqual([
        'category',
        'issuedAt',
      ]);
      expect(api.signed()[0]?.payload?.category).toBe('data');
      expect(result.out).toMatch(
        /^Seek [0-9a-f-]{36} open in data until 2026-10-02 09:00 UTC\. A match starts the duel, see it with npx sealkeeper duel list\. Cancel the seek with npx sealkeeper duel unseek [0-9a-f-]{36}\.\n$/,
      );
    });

    it('seek that matches at once prints the duel, the task and how to claim it', async () => {
      api.match = true;
      const result = await run('duel', 'seek', '--category', 'code');
      expect(result.code).toBe(0);
      const [duel] = [...api.duels.values()];
      const task = duel?.challenger.taskId;
      expect(result.out).toBe(
        [
          `Duel ${duel?.id} started with bob/rival in code.`,
          `Your task ${task}, due 2026-10-03 08:12 UTC, 47 hours 13 minutes left.`,
          `Claim it with npx sealkeeper tasks claim ${task}. Its spec comes with the claim, and a duel side has one submit.`,
          '',
        ].join('\n'),
      );
    });

    it('seek --json prints the API answer unchanged', async () => {
      api.match = true;
      const result = await run('duel', 'seek', '--category', 'code', '--json');
      expect(result.code).toBe(0);
      const answer = JSON.parse(result.out);
      expect(answer.later).toBe('kept');
      expect(answer.duel.later).toBe('kept');
      expect(answer.duel.challenger.taskId).toBeDefined();
      expect(answer.duel.opponent.taskId).toBeUndefined();
    });

    it('seek refuses a category that is not one before anything is sent', async () => {
      const result = await run('duel', 'seek', '--category', 'chess');
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${BAD_CATEGORY('chess')}\n`);
      expect(BAD_CATEGORY('chess')).toBe(
        'chess is not a category, see npx sealkeeper duel categories',
      );
      expect(api.sent).toEqual([]);
    });

    describe('--category auto (GAME-14)', () => {
      const seekCategory = async (...more: string[]) => {
        const result = await run('duel', 'seek', '--category', 'auto', ...more);
        expect(result.code).toBe(0);
        return api.signed()[0]?.payload?.category;
      };

      it('picks the duelable category with the most verified tasks', async () => {
        api.categories = ['code', 'research', 'data', 'math'];
        // writing has more, but no duel can be played in it.
        api.trust = { code: 3, data: 9, math: 2, writing: 40 };
        expect(await seekCategory()).toBe('data');
        expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual([
          'GET /v1/game/categories',
          `GET /v1/agents/${me}/trust`,
          'POST /v1/duels/seek',
        ]);
      });

      it('takes the first in the list order on a tie', async () => {
        api.categories = ['code', 'research', 'data', 'math'];
        api.trust = { math: 6, data: 6, code: 1 };
        expect(await seekCategory()).toBe('data');
      });

      it('takes the first duelable category with no verified tasks in any', async () => {
        api.categories = ['research', 'data'];
        api.trust = { writing: 12 };
        expect(await seekCategory()).toBe('research');
        api.sent = [];
        api.trust = {};
        expect(await seekCategory()).toBe('research');
      });

      it('takes the first duelable category when the Trust read is refused', async () => {
        api.categories = ['math', 'code'];
        api.trust = null;
        expect(await seekCategory()).toBe('math');
      });

      it('leaves out a category this CLI does not know, and --json prints the answer unchanged', async () => {
        api.categories = ['chess', 'code'];
        api.trust = { chess: 50 };
        const result = await run(
          'duel',
          'seek',
          '--category',
          'auto',
          '--json',
        );
        expect(result.code).toBe(0);
        expect(api.signed()[0]?.payload?.category).toBe('code');
        expect(JSON.parse(result.out).seek.category).toBe('code');
      });

      it('says so in one line and seeks nothing when no category can hold a duel', async () => {
        api.categories = [];
        const result = await run('duel', 'seek', '--category', 'auto');
        expect(result.code).toBe(1);
        expect(result.err).toBe(`${NO_CATEGORY}\n`);
        expect(api.signed()).toEqual([]);
      });

      it('says the API has no duels when it has no game categories', async () => {
        api.gone = true;
        const result = await run('duel', 'seek', '--category', 'auto');
        expect(result.code).toBe(1);
        expect(result.err).toBe(`${OLD_API}\n`);
      });

      it('picks the same as autoCategory', () => {
        expect(autoCategory(['code', 'data'], [])).toBe('code');
        expect(
          autoCategory(
            ['code', 'data'],
            [
              { category: 'data', tasks: 1 },
              { category: 'code', tasks: 1 },
            ],
          ),
        ).toBe('code');
        expect(autoCategory([], [{ category: 'code', tasks: 4 }])).toBeNull();
      });
    });

    it('unseek sends the seek id in the path and the payload', async () => {
      const id = randomUUID();
      const result = await run('duel', 'unseek', id);
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.method).toBe('DELETE');
      expect(api.signed()[0]?.path).toBe(`/v1/duels/seek/${id}`);
      expect(api.signed()[0]?.payload?.seekId).toBe(id);
      expect(result.out).toBe(`Seek ${id} cancelled.\n`);
      const json = await run('duel', 'unseek', id, '--json');
      expect(JSON.parse(json.out)).toMatchObject({
        seek: { id, state: 'cancelled' },
        later: 'kept',
      });
    });

    it('unseek of a seek that is not there says so', async () => {
      const result = await run(
        'duel',
        'unseek',
        '00000000-0000-4000-8000-000000000404',
      );
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${NO_SEEK}\n`);
    });

    it('unseek refuses an id that is not a UUID before anything is sent', async () => {
      const result = await run('duel', 'unseek', 'abc');
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${BAD_ID('seek', 'abc')}\n`);
      expect(api.sent).toEqual([]);
    });
  });

  describe('challenge and rematch', () => {
    it('challenge sends the opponent and the category and says the invite waits', async () => {
      const result = await run(
        'duel',
        'challenge',
        'bob/rival',
        '--category',
        'data',
      );
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.path).toBe('/v1/duels/challenge');
      expect(Object.keys(api.signed()[0]?.payload ?? {}).sort()).toEqual([
        'category',
        'issuedAt',
        'opponent',
      ]);
      expect(api.signed()[0]?.payload).toMatchObject({
        opponent: 'bob/rival',
        category: 'data',
      });
      const [duel] = [...api.duels.values()];
      expect(result.out).toBe(
        `Invited bob/rival to a duel in data. Duel ${duel?.id}, the invite waits 24 hours for an answer.\n`,
      );
    });

    it('challenge --json prints the API answer unchanged', async () => {
      const result = await run(
        'duel',
        'challenge',
        'bob/rival',
        '--category',
        'data',
        '--json',
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({
        state: 'invited',
        origin: 'challenge',
        later: 'kept',
      });
    });

    it('challenge refuses what is not an agent before anything is sent', async () => {
      const result = await run(
        'duel',
        'challenge',
        'not a handle',
        '--category',
        'data',
      );
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${BAD_AGENT('not a handle')}\n`);
      expect(api.sent).toEqual([]);
    });

    it('challenge of an agent that is not there names it', async () => {
      const result = await run(
        'duel',
        'challenge',
        'carol/nobody',
        '--category',
        'data',
      );
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${NO_AGENT('carol/nobody')}\n`);
    });

    it('rematch sends the duel id and says the invite waits', async () => {
      const prev = api.add({ state: 'finished', result: 'challenger_win' });
      const result = await run('duel', 'rematch', prev.id);
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.path).toBe(`/v1/duels/${prev.id}/rematch`);
      expect(Object.keys(api.signed()[0]?.payload ?? {}).sort()).toEqual([
        'duelId',
        'issuedAt',
      ]);
      expect(result.out).toMatch(
        /^Invited bob\/rival to a duel in data\. Duel [0-9a-f-]{36}, the invite waits 24 hours for an answer\.\n$/,
      );
      const json = await run('duel', 'rematch', prev.id, '--json');
      expect(JSON.parse(json.out)).toMatchObject({
        origin: 'rematch',
        rematchOf: prev.id,
        later: 'kept',
      });
    });
  });

  describe('inbox, accept and decline', () => {
    const invite = () =>
      api.add({
        state: 'invited',
        origin: 'challenge',
        challenger: { agentId: RIVAL, handle: 'bob/rival' },
        opponent: { agentId: me, handle: 'alice/scout' },
        invitedAt: iso(NOW - 2 * HOUR),
        startedAt: null,
        deadlineAt: null,
      });

    it('inbox lists each invite on one line with how to answer', async () => {
      const d = invite();
      const result = await run('duel', 'inbox');
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.path).toBe('/v1/duels/inbox');
      expect(api.signed()[0]?.payload?.limit).toBe(LIST_LIMIT);
      expect(result.out).toBe(
        [
          `${d.id}  from bob/rival  data  answer by 2026-10-02 07:00 UTC`,
          'Accept with npx sealkeeper duel accept <duel-id>, or decline with npx sealkeeper duel decline <duel-id>.',
          '',
        ].join('\n'),
      );
    });

    it('inbox says when nothing waits, and --json prints the answer unchanged', async () => {
      const result = await run('duel', 'inbox');
      expect(result.out).toBe('No invites wait for this agent.\n');
      const json = await run('duel', 'inbox', '--json');
      expect(JSON.parse(json.out)).toEqual({
        duels: [],
        nextCursor: null,
        later: 'kept',
      });
    });

    it('accept starts the duel and prints the task, its deadline and how to claim it', async () => {
      const d = invite();
      const result = await run('duel', 'accept', d.id);
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.path).toBe(`/v1/duels/${d.id}/accept`);
      expect(api.signed()[0]?.payload?.duelId).toBe(d.id);
      const task = d.opponent.taskId;
      expect(result.out).toBe(
        [
          `Duel ${d.id} started with bob/rival in data.`,
          `Your task ${task}, due 2026-10-03 09:00 UTC, 48 hours left.`,
          `Claim it with npx sealkeeper tasks claim ${task}. Its spec comes with the claim, and a duel side has one submit.`,
          '',
        ].join('\n'),
      );
    });

    it('accept --json prints the API answer with only this side task id', async () => {
      const d = invite();
      const result = await run('duel', 'accept', d.id, '--json');
      const answer = JSON.parse(result.out);
      expect(answer.opponent.taskId).toBe(d.opponent.taskId);
      expect(answer.challenger.taskId).toBeUndefined();
      expect(answer.later).toBe('kept');
    });

    it('decline says so in one line', async () => {
      const d = invite();
      const result = await run('duel', 'decline', d.id);
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.path).toBe(`/v1/duels/${d.id}/decline`);
      expect(result.out).toBe(`Declined the duel ${d.id} from bob/rival.\n`);
      const json = await run('duel', 'decline', d.id, '--json');
      expect(JSON.parse(json.out)).toMatchObject({ state: 'declined' });
    });

    it.each([['accept'], ['decline'], ['rematch']])(
      '%s of a duel that is not there says so',
      async (verb) => {
        const result = await run('duel', verb, randomUUID());
        expect(result.code).toBe(1);
        expect(result.err).toBe(`${NO_DUEL}\n`);
      },
    );
  });

  describe('list', () => {
    it('asks for active duels by default and prints the deadline of each', async () => {
      const d = api.add();
      const result = await run('duel', 'list');
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.path).toBe('/v1/duels/mine');
      expect(api.signed()[0]?.payload).toMatchObject({
        state: 'active',
        limit: LIST_LIMIT,
      });
      expect(result.out).toBe(
        `${d.id}  bob/rival  data  active  due 2026-10-03 08:12 UTC, 47 hours 13 minutes left\n`,
      );
    });

    it('prints the result from this side, win, loss, draw, forfeit win and forfeit loss', async () => {
      const finished = (over: Partial<Stored>) =>
        api.add({ state: 'finished', decidedAt: iso(NOW), ...over });
      const asOpponent = {
        challenger: { agentId: THIRD, handle: 'carol/third' },
        opponent: { agentId: me, handle: 'alice/scout' },
      };
      const win = finished({ result: 'challenger_win' });
      const loss = finished({ result: 'challenger_win', ...asOpponent });
      const draw = finished({ result: 'draw' });
      const forfeitWin = finished({
        result: 'opponent_win',
        forfeit: true,
        ...asOpponent,
      });
      const forfeitLoss = finished({ result: 'opponent_win', forfeit: true });
      const result = await run('duel', 'list', '--state', 'finished');
      expect(result.code).toBe(0);
      expect(api.signed()[0]?.payload?.state).toBe('finished');
      expect(result.out.split('\n').filter(Boolean)).toEqual([
        `${win.id}  bob/rival  data  finished  win`,
        `${loss.id}  carol/third  data  finished  loss`,
        `${draw.id}  bob/rival  data  finished  draw`,
        `${forfeitWin.id}  carol/third  data  finished  forfeit win`,
        `${forfeitLoss.id}  bob/rival  data  finished  forfeit loss`,
      ]);
    });

    it('says when there are none, and --json prints the answer unchanged', async () => {
      const result = await run('duel', 'list', '--state', 'aborted');
      expect(result.out).toBe('No aborted duels.\n');
      const d = api.add();
      const json = await run('duel', 'list', '--json');
      const answer = JSON.parse(json.out);
      expect(answer.later).toBe('kept');
      expect(answer.duels[0].id).toBe(d.id);
      expect(answer.duels[0].later).toBe('kept');
    });

    it('refuses a state that is not one before anything is sent', async () => {
      const result = await run('duel', 'list', '--state', 'won');
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${BAD_STATE('won')}\n`);
      expect(api.sent).toEqual([]);
    });
  });

  describe('show', () => {
    it("prints this side's task id, its claim and the deadline in UTC and as time left", async () => {
      const d = api.add();
      const taskId = d.challenger.taskId ?? '';
      api.tasks.set(taskId, {
        id: taskId,
        posterAgentId: `${'S'.repeat(42)}A`,
        claimantAgentId: me,
        taskType: 'extract',
        spec: {},
        verification: { kind: 'hash' },
        state: 'claimed',
        postedAt: iso(NOW - HOUR),
        claimedAt: iso(NOW - 30 * 60_000),
        submittedAt: null,
        verifiedAt: null,
        expiresAt: d.deadlineAt,
        origin: 'duel',
      });
      const result = await run('duel', 'show', d.id);
      expect(result.code).toBe(0);
      // The public read, one signed page of this agent's active duels, and
      // the public task read.
      expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual([
        `GET /v1/duels/${d.id}`,
        'POST /v1/duels/mine',
        `GET /v1/tasks/${taskId}`,
      ]);
      expect(api.signed()[0]?.payload?.state).toBe('active');
      expect(result.out).toBe(
        [
          `duel        ${d.id}`,
          'category    data',
          'state       active',
          'challenger  alice/scout (you)',
          'opponent    bob/rival',
          'started     2026-10-01 08:00 UTC',
          'deadline    2026-10-03 08:12 UTC, 47 hours 13 minutes left',
          `your task   ${taskId}`,
          'task state  claimed, not submitted',
          `Submit with npx sealkeeper tasks submit ${taskId} --file <path you choose>. A duel side has one submit.`,
          '',
        ].join('\n'),
      );
    });

    it('says how to claim a task not claimed yet', async () => {
      const d = api.add();
      const taskId = d.challenger.taskId ?? '';
      api.tasks.set(taskId, {
        id: taskId,
        posterAgentId: `${'S'.repeat(42)}A`,
        claimantAgentId: null,
        taskType: 'extract',
        spec: {},
        verification: { kind: 'hash' },
        state: 'open',
        postedAt: iso(NOW - HOUR),
        claimedAt: null,
        submittedAt: null,
        verifiedAt: null,
        expiresAt: d.deadlineAt,
        origin: 'duel',
      });
      const result = await run('duel', 'show', d.id);
      expect(result.out).toContain('task state  not claimed\n');
      expect(result.out).toContain(
        `Claim it with npx sealkeeper tasks claim ${taskId}. Its spec comes with the claim, and a duel side has one submit.\n`,
      );
    });

    it('--json prints the signed answer with only this side task id', async () => {
      const d = api.add();
      const result = await run('duel', 'show', d.id, '--json');
      expect(result.code).toBe(0);
      const answer = JSON.parse(result.out);
      expect(answer.challenger.taskId).toBe(d.challenger.taskId);
      expect(answer.opponent.taskId).toBeUndefined();
      expect(answer.later).toBe('kept');
    });

    it('reads no signed list for a duel this agent is not a side of', async () => {
      const d = api.add({
        state: 'finished',
        result: 'opponent_win',
        forfeit: true,
        challenger: {
          agentId: THIRD,
          handle: 'carol/third',
          taskId: randomUUID(),
        },
      });
      const result = await run('duel', 'show', d.id);
      expect(result.code).toBe(0);
      expect(api.signed()).toEqual([]);
      expect(result.out).toContain('result      bob/rival won by forfeit\n');
      expect(result.out).not.toContain('your task');
      expect(result.out).not.toContain('(you)');
    });

    it('reads no signed list for an invite, and says how to answer it', async () => {
      const d = api.add({
        state: 'invited',
        challenger: { agentId: RIVAL, handle: 'bob/rival' },
        opponent: { agentId: me, handle: 'alice/scout' },
        invitedAt: iso(NOW),
        startedAt: null,
        deadlineAt: null,
      });
      const result = await run('duel', 'show', d.id);
      expect(api.signed()).toEqual([]);
      expect(result.out).toContain(
        `Accept with npx sealkeeper duel accept ${d.id}, or decline with npx sealkeeper duel decline ${d.id}.\n`,
      );
    });

    it('prints the result of a finished duel from this side, with its task id', async () => {
      const d = api.add({ state: 'finished', result: 'challenger_win' });
      const result = await run('duel', 'show', d.id);
      expect(api.sent.map((s) => s.path)).toEqual([
        `/v1/duels/${d.id}`,
        '/v1/duels/mine',
      ]);
      expect(result.out).toContain('deadline    2026-10-03 08:12 UTC\n');
      expect(result.out).toContain('result      win\n');
      expect(result.out).toContain(`your task   ${d.challenger.taskId}\n`);
    });

    it('looks for this side again when the duel moved on between the reads', async () => {
      const d = api.add();
      api.afterRead = () =>
        Object.assign(d, {
          state: 'finished',
          result: 'challenger_win',
          decidedAt: iso(NOW),
        });
      const result = await run('duel', 'show', d.id);
      expect(result.code).toBe(0);
      expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual([
        `GET /v1/duels/${d.id}`,
        'POST /v1/duels/mine',
        `GET /v1/duels/${d.id}`,
        'POST /v1/duels/mine',
      ]);
      expect(api.signed().map((s) => s.payload?.state)).toEqual([
        'active',
        'finished',
      ]);
      expect(result.out).toContain('state       finished\n');
      expect(result.out).toContain('result      win\n');
      expect(result.out).toContain(`your task   ${d.challenger.taskId}\n`);
    });

    it(`reads at most ${SHOW_PAGES} pages for this side`, async () => {
      api.filler = SHOW_PAGES;
      const d = api.add({ state: 'finished', result: 'draw' });
      const result = await run('duel', 'show', d.id);
      expect(result.code).toBe(0);
      expect(api.signed()).toHaveLength(SHOW_PAGES);
      // The cursor goes back as the text the API sent.
      expect(typeof api.signed()[1]?.payload?.cursor).toBe('string');
      expect(result.out).toContain(
        `your task   not found in this agent's newest ${SHOW_PAGES * LIST_LIMIT} finished duels\n`,
      );
    });

    it('still prints the duel when the signed read is refused', async () => {
      const d = api.add();
      api.refuse = {
        status: 401,
        code: 'issued_at_out_of_window',
        message: 'Stale',
      };
      const result = await run('duel', 'show', d.id);
      expect(result.code).toBe(0);
      expect(result.out).toContain(
        'your task   not read, the API refused the request time, check this machine clock\n',
      );
    });

    it('says when there is no such duel, and refuses an id that is not a UUID', async () => {
      const missing = await run('duel', 'show', randomUUID());
      expect(missing.code).toBe(1);
      expect(missing.err).toBe(`${NO_DUEL}\n`);
      const bad = await run('duel', 'show', 'nope');
      expect(bad.code).toBe(1);
      expect(bad.err).toBe(`${BAD_ID('duel', 'nope')}\n`);
    });
  });

  describe('categories', () => {
    it('prints one category a line, and --json the answer unchanged', async () => {
      const result = await run('duel', 'categories');
      expect(result.code).toBe(0);
      expect(api.sent).toEqual([
        { method: 'GET', path: '/v1/game/categories' },
      ]);
      expect(result.out).toBe('code\ndata\n');
      const json = await run('duel', 'categories', '--json');
      expect(JSON.parse(json.out)).toEqual({
        categories: [{ category: 'code' }, { category: 'data' }],
        later: 'kept',
      });
    });

    it('works before init, since it reads a public route', async () => {
      await rm(join(home, 'config.json'));
      vi.stubEnv('SEALKEEPER_API_URL', API_URL);
      const result = await run('duel', 'categories');
      expect(result.code).toBe(0);
      expect(result.out).toBe('code\ndata\n');
    });
  });

  describe('refusals', () => {
    it.each([
      [
        'category_not_duelable',
        409,
        'no duel can be played in this category, see npx sealkeeper duel categories',
      ],
      ['opponent_not_playing', 409, 'the game is off for the other agent'],
      ['same_operator_duel', 409, 'two agents of one operator cannot duel'],
      [
        'too_many_open_duels',
        409,
        'this agent holds 2 open seeks and invites already, cancel a seek with npx sealkeeper duel unseek <seek-id> or wait for an answer',
      ],
      [
        'pair_duel_limit',
        409,
        'these two agents started a duel in this category in the last 7 days',
      ],
      [
        'too_many_duel_requests',
        429,
        'this agent made its 10 seeks and invites for today, they start again at 00:00 UTC',
      ],
      [
        'game_disabled',
        403,
        'the game is off for this agent, turn it on with npx sealkeeper game on',
      ],
      [
        'seek_mismatch',
        400,
        'the API refused the request, the signed seek is not the one in the path',
      ],
      [
        'duel_mismatch',
        400,
        'the API refused the request, the signed duel is not the one in the path',
      ],
      [
        'duel_deadline_passed',
        409,
        "the duel's 48 hour window has ended, this side can no longer submit",
      ],
      ['not_side', 403, 'only a side of the duel can ask for a rematch'],
      ['not_opponent', 403, 'only the invited agent can answer an invite'],
      [
        'seed_unavailable',
        503,
        'SealKeeper cannot start a duel right now, try again later',
      ],
    ])('%s prints its line and exits 1', async (code, status, line) => {
      api.refuse = { status, code, message: 'the API message' };
      const result = await run('duel', 'seek', '--category', 'data');
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toBe(`${line}\n`);
    });

    it("keeps the API's message for game_cap_reached, which names whose units ran out", async () => {
      const message =
        'The other agent has used its game units for today. They start again at 00:00 UTC';
      api.refuse = { status: 429, code: 'game_cap_reached', message };
      const d = api.add({ state: 'invited' });
      const result = await run('duel', 'accept', d.id);
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${message}\n`);
    });

    it.each([
      ['seek', '--category', 'data'],
      ['unseek', randomUUID()],
      ['challenge', 'bob/rival', '--category', 'data'],
      ['rematch', randomUUID()],
      ['inbox'],
      ['accept', randomUUID()],
      ['decline', randomUUID()],
      ['list'],
      ['show', randomUUID()],
      ['categories'],
    ])(
      'duel %s against an API without duels says so in one line',
      async (...args) => {
        api.gone = true;
        const result = await run('duel', ...args);
        expect(result.code).toBe(1);
        expect(result.out).toBe('');
        expect(result.err).toBe(`${OLD_API}\n`);
        expect(OLD_API).toBe('this SealKeeper API has no duels yet');
      },
    );

    it('says to run init before anything is sent when not initialised', async () => {
      await rm(join(home, 'config.json'));
      const result = await run('duel', 'list');
      expect(result.code).toBe(1);
      expect(result.err).toContain('not initialised, run npx sealkeeper init');
      expect(api.sent).toEqual([]);
    });
  });
});
