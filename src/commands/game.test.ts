// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  GAME_CAP_MAX,
  readAudience,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import { BAD_CAP, OLD_API } from './game.js';

const API_URL = 'https://api.test';
const RESET_AT = '2026-10-02T00:00:00.000Z';

type RunResult = { code: number; out: string; err: string };
type Sent = { method: string; path: string; payload: Record<string, unknown> };

// A stand-in for the two signed game routes. Every envelope is verified
// against the key its kid names, which must be the local agent, and must
// name this API. The status starts on with the full cap, and a settings
// change moves it as the API does. refuse answers every request with that
// error instead, and gone answers 404 as an API from before the game does.
class FakeGame {
  status = {
    enabled: true,
    cap: GAME_CAP_MAX,
    usedToday: 2,
    resetAt: RESET_AT,
  };
  sent: Sent[] = [];
  errors: string[] = [];
  refuse: { status: number; code: string; message: string } | null = null;
  gone = false;

  constructor(readonly agentId: string) {}

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const route = `${method} ${url.pathname}`;
    if (route !== 'POST /v1/game/status' && route !== 'PUT /v1/game/settings') {
      this.errors.push(`unexpected ${route}`);
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
    this.sent.push({ method, path: url.pathname, payload });
    if (this.gone) {
      return Response.json(
        { error: { code: 'not_found', message: 'Not found' } },
        { status: 404 },
      );
    }
    if (this.refuse !== null) {
      const { status, code, message } = this.refuse;
      return Response.json({ error: { code, message } }, { status });
    }
    if (method === 'PUT') {
      const { enabled, cap } = payload as { enabled?: boolean; cap?: number };
      this.status = {
        ...this.status,
        ...(enabled === undefined ? {} : { enabled }),
        ...(cap === undefined ? {} : { cap }),
      };
    }
    // A field a later API adds, which --json keeps.
    return Response.json({ ...this.status, later: 'kept' });
  }) as typeof fetch;
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('sealkeeper game', () => {
  let home: string;
  let game: FakeGame;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({ tasks: { fetch: game.fetch } });
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
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-game-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    const { agentId } = await createKey();
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    game = new FakeGame(agentId);
  });

  afterEach(async () => {
    expect(game.errors).toEqual([]);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  describe('status', () => {
    it('prints the switch, the cap, the units used today and the reset in UTC', async () => {
      const result = await run('game', 'status');
      expect(result.code).toBe(0);
      expect(result.out).toBe(
        [
          'game        on',
          'cap         5 game units a UTC day',
          'used today  2',
          'resets      2026-10-02 00:00 UTC',
          '',
        ].join('\n'),
      );
      expect(game.sent).toHaveLength(1);
      expect(game.sent[0]?.method).toBe('POST');
      expect(game.sent[0]?.path).toBe('/v1/game/status');
      expect(Object.keys(game.sent[0]?.payload ?? {})).toEqual(['issuedAt']);
    });

    it('says how to turn it on when it is off', async () => {
      game.status.enabled = false;
      const result = await run('game', 'status');
      expect(result.code).toBe(0);
      expect(result.out).toContain('game        off\n');
      expect(result.out).toContain('Turn it on with npx sealkeeper game on\n');
    });

    it('--json prints the API answer unchanged', async () => {
      const result = await run('game', 'status', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual({
        enabled: true,
        cap: 5,
        usedToday: 2,
        resetAt: RESET_AT,
        later: 'kept',
      });
    });
  });

  describe('on and off', () => {
    it('on sends enabled true and says so in one line', async () => {
      game.status.enabled = false;
      const result = await run('game', 'on');
      expect(result.code).toBe(0);
      expect(game.sent).toHaveLength(1);
      expect(game.sent[0]?.method).toBe('PUT');
      expect(game.sent[0]?.path).toBe('/v1/game/settings');
      expect(Object.keys(game.sent[0]?.payload ?? {}).sort()).toEqual([
        'enabled',
        'issuedAt',
      ]);
      expect(game.sent[0]?.payload.enabled).toBe(true);
      expect(result.out).toBe(
        'Game on, up to 5 game units a UTC day, 2 used today. Turn it off with npx sealkeeper game off\n',
      );
    });

    it('off sends enabled false and says what ends and what goes on', async () => {
      const result = await run('game', 'off');
      expect(result.code).toBe(0);
      expect(game.sent[0]?.payload.enabled).toBe(false);
      expect(result.out).toBe(
        'Game off. Open seeks and invites end, and a duel already started goes on. Turn it on with npx sealkeeper game on\n',
      );
    });

    it.each([['on'], ['off']])(
      '%s --json prints the API answer unchanged',
      async (which) => {
        const result = await run('game', which, '--json');
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual({
          enabled: which === 'on',
          cap: 5,
          usedToday: 2,
          resetAt: RESET_AT,
          later: 'kept',
        });
      },
    );
  });

  describe('cap', () => {
    it('sends the cap alone and says the cap and the units used', async () => {
      const result = await run('game', 'cap', '3');
      expect(result.code).toBe(0);
      expect(Object.keys(game.sent[0]?.payload ?? {}).sort()).toEqual([
        'cap',
        'issuedAt',
      ]);
      expect(game.sent[0]?.payload.cap).toBe(3);
      expect(result.out).toBe('Game cap 3 units a UTC day, 2 used today.\n');
    });

    it('takes 0, a game with no units', async () => {
      const result = await run('game', 'cap', '0');
      expect(result.code).toBe(0);
      expect(game.sent[0]?.payload.cap).toBe(0);
    });

    it('says the game is off beside the new cap', async () => {
      game.status.enabled = false;
      const result = await run('game', 'cap', '4');
      expect(result.code).toBe(0);
      expect(result.out).toBe(
        'Game cap 4 units a UTC day, 2 used today. The game is off, turn it on with npx sealkeeper game on\n',
      );
    });

    it('--json prints the API answer unchanged', async () => {
      const result = await run('game', 'cap', '1', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual({
        enabled: true,
        cap: 1,
        usedToday: 2,
        resetAt: RESET_AT,
        later: 'kept',
      });
    });

    it.each([['6'], ['-1'], ['2.5'], ['x'], ['']])(
      'refuses %j before any request',
      async (value) => {
        const result = await run('game', 'cap', value);
        expect(result.code).toBe(1);
        expect(result.err).toBe(`${BAD_CAP(value)}\n`);
        expect(game.sent).toEqual([]);
      },
    );

    it('names the range in the refusal of 6', () => {
      expect(BAD_CAP('6')).toBe(
        'cap must be a whole number from 0 to 5, got 6',
      );
    });
  });

  describe('refusals', () => {
    it.each([['status'], ['on'], ['off'], ['cap', '2']])(
      'game %s against an API without the game says so in one line',
      async (...args) => {
        game.gone = true;
        const result = await run('game', ...args);
        expect(result.code).toBe(1);
        expect(result.out).toBe('');
        expect(result.err).toBe(`${OLD_API}\n`);
        expect(OLD_API).toBe('this SealKeeper API has no game layer yet');
      },
    );

    it.each([
      [
        { status: 403, code: 'game_disabled', message: 'The game is off' },
        'the game is off for this agent, turn it on with npx sealkeeper game on\n',
      ],
      [
        {
          status: 429,
          code: 'game_cap_reached',
          message:
            'This agent has used its 5 game units for today. They start again at 00:00 UTC',
        },
        'This agent has used its 5 game units for today. They start again at 00:00 UTC\n',
      ],
      [
        {
          status: 409,
          code: 'stale_game_settings',
          message:
            'A game settings change issued at the same time or later is already stored',
        },
        'a newer game settings change of this agent is already stored\n',
      ],
    ])('prints the refusal line of %o and exits 1', async (refuse, line) => {
      game.refuse = refuse;
      const result = await run('game', 'on');
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toBe(line);
    });

    it('says to run init before anything is sent when not initialised', async () => {
      await rm(join(home, 'config.json'));
      const result = await run('game', 'status');
      expect(result.code).toBe(1);
      expect(result.err).toContain('not initialised, run npx sealkeeper init');
      expect(game.sent).toEqual([]);
    });
  });
});
