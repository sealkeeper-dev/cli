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
import { writeConfig } from './config.js';
import { BAD_CAP, OLD_API } from './game.js';
import { createKey } from './identity.js';
import { createProgram } from './program.js';

const API_URL = 'https://api.test';
const RESET_AT = '2026-10-02T00:00:00.000Z';

type RunResult = { code: number; out: string; err: string };
type Sent = { method: string; path: string; payload: Record<string, unknown> };

// A stand-in for the two signed game routes. Every envelope is verified
// against the key its kid names, which must be the local agent, and must
// name this API. The status starts on with the full cap, and a settings
// change moves it as the API does. refuse answers every request with that
// error instead, and gone answers 404 as an API from before the game does.
// status starts as an API before VOU-618 answers it, with no duels started
// and no closed, and closed is what a settings change answers beside it.
class FakeGame {
  status: Record<string, unknown> & {
    enabled: boolean;
    cap: number;
    usedToday: number;
    resetAt: string;
  } = {
    enabled: true,
    cap: GAME_CAP_MAX,
    usedToday: 2,
    resetAt: RESET_AT,
  };
  closed: Record<string, unknown> | undefined;
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
    return Response.json({
      ...this.status,
      ...(method === 'PUT' && this.closed ? { closed: this.closed } : {}),
      later: 'kept',
    });
  }) as typeof fetch;
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('the game settings', () => {
  let home: string;
  let game: FakeGame;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({
      tasks: { fetch: game.fetch },
      routine: { fetch: game.fetch },
      config: { fetch: game.fetch },
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

  // game cap went to routine set --game-cap (VOU-599).
  describe('routine set --game-cap', () => {
    it('sends the cap alone and says the cap and the units used', async () => {
      const result = await run('routine', 'set', '--game-cap', '3', '--yes');
      expect(result.code).toBe(0);
      expect(Object.keys(game.sent[0]?.payload ?? {}).sort()).toEqual([
        'cap',
        'issuedAt',
      ]);
      expect(game.sent[0]?.payload.cap).toBe(3);
      expect(result.out).toBe('Game cap 3 units a UTC day, 2 used today.\n');
    });

    it('takes 0, a game with no units', async () => {
      const result = await run('routine', 'set', '--game-cap', '0', '--yes');
      expect(result.code).toBe(0);
      expect(game.sent[0]?.payload.cap).toBe(0);
    });

    it('says the game is off beside the new cap', async () => {
      game.status.enabled = false;
      const result = await run('routine', 'set', '--game-cap', '4', '--yes');
      expect(result.code).toBe(0);
      expect(result.out).toBe(
        'Game cap 4 units a UTC day, 2 used today. The game is off, npx sealkeeper duel --json, run by your agent, turns it on and looks for a duel\n',
      );
    });

    it('--json prints the cap SealKeeper holds now', async () => {
      const result = await run(
        'routine',
        'set',
        '--game-cap',
        '1',
        '--yes',
        '--json',
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).gameCap).toBe(1);
    });

    it.each([['6'], ['-1'], ['2.5'], ['x'], ['']])(
      'refuses %j before any request',
      async (value) => {
        const result = await run(
          'routine',
          'set',
          '--game-cap',
          value,
          '--yes',
        );
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

    // VOU-603. The game command is gone. init sets the switch and the
    // cap, challenge and duel turn the game on, routine set changes the cap
    // and config game the switch (VOU-611).
    it.each([['on'], ['off'], ['cap', '3'], ['status']])(
      'game %s is gone',
      async (...args) => {
        expect((await run('game', ...args)).code).toBe(1);
        expect(game.sent).toEqual([]);
      },
    );
  });

  // VOU-611. The switch is a config setting, read and changed with a
  // signed request, and every line prints what the API answered.
  describe('config game', () => {
    it('with no word reads the switch and sends only the time', async () => {
      const result = await run('config', 'game');
      expect(result.code).toBe(0);
      expect(game.sent.map((s) => `${s.method} ${s.path}`)).toEqual([
        'POST /v1/game/status',
      ]);
      expect(Object.keys(game.sent[0]?.payload ?? {})).toEqual(['issuedAt']);
      expect(result.out).toBe(
        'Game on, 2 of 5 game units used today, they reset 2026-10-02 00:00 UTC. npx sealkeeper config game off stops it.\n',
      );
    });

    it('with no word says the cap and how to turn it on while it is off', async () => {
      game.status.enabled = false;
      game.status.cap = 3;
      const result = await run('config', 'game');
      expect(result.out).toBe(
        'Game off, cap 3 game units a UTC day. npx sealkeeper config game on turns it on.\n',
      );
    });

    it('off sends the switch alone and says what the API closed', async () => {
      const result = await run('config', 'game', 'off');
      expect(result.code).toBe(0);
      expect(game.sent[0]?.method).toBe('PUT');
      expect(Object.keys(game.sent[0]?.payload ?? {}).sort()).toEqual([
        'enabled',
        'issuedAt',
      ]);
      expect(game.sent[0]?.payload.enabled).toBe(false);
      expect(game.status.enabled).toBe(false);
      // An API before VOU-618 sends no counts, so only Game off.
      expect(result.out).toBe('Game off.\n');
    });

    it('off prints what the API says it closed, and only Game off for nothing', async () => {
      game.closed = { seeks: 1, invitesSent: 0, invitesReceived: 2 };
      expect((await run('config', 'game', 'off')).out).toBe(
        'Game off. 1 open seek ended, 2 received invites declined.\n',
      );
      game.closed = { seeks: 2, invitesSent: 1, invitesReceived: 1 };
      expect((await run('config', 'game', 'off')).out).toBe(
        'Game off. 2 open seeks ended, 1 sent invite withdrawn, 1 received invite declined.\n',
      );
      game.closed = { seeks: 0, invitesSent: 0, invitesReceived: 0 };
      expect((await run('config', 'game', 'off')).out).toBe('Game off.\n');
      // A malformed closed is dropped, never a failed command.
      game.closed = { seeks: 'one' };
      const odd = await run('config', 'game', 'off');
      expect(odd.code).toBe(0);
      expect(odd.out).toBe('Game off.\n');
    });

    it('with no word says the duels started against the ceiling the API sent', async () => {
      game.status = { ...game.status, duelsStartedToday: 3, duelsPerDay: 10 };
      expect((await run('config', 'game')).out).toBe(
        'Game on, 2 of 5 game units used today, they reset 2026-10-02 00:00 UTC. 3 of 10 duels started today. npx sealkeeper config game off stops it.\n',
      );
      // Half the pair, or a malformed one, is left out.
      game.status = { ...game.status, duelsStartedToday: 3, duelsPerDay: -1 };
      expect((await run('config', 'game')).out).toBe(
        'Game on, 2 of 5 game units used today, they reset 2026-10-02 00:00 UTC. npx sealkeeper config game off stops it.\n',
      );
    });

    it('on sends the switch alone and says the units', async () => {
      game.status.enabled = false;
      const result = await run('config', 'game', 'on');
      expect(result.code).toBe(0);
      expect(game.sent[0]?.payload.enabled).toBe(true);
      expect(Object.keys(game.sent[0]?.payload ?? {}).sort()).toEqual([
        'enabled',
        'issuedAt',
      ]);
      expect(result.out).toContain('Game on, 2 of 5 game units used today');
    });

    it.each([[[]], [['on']], [['off']]])(
      '%j --json prints the answer as it came',
      async (words) => {
        const result = await run('config', 'game', ...words, '--json');
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual({
          ...game.status,
          later: 'kept',
        });
      },
    );

    it('refuses any other word before any request', async () => {
      const result = await run('config', 'game', 'maybe');
      expect(result.code).toBe(1);
      expect(result.err).toBe('game takes on or off, or nothing to show it\n');
      expect(game.sent).toEqual([]);
    });

    it.each([[[]], [['off']]])(
      '%j against an API without the game says so in one line',
      async (words) => {
        game.gone = true;
        const result = await run('config', 'game', ...words);
        expect(result.code).toBe(1);
        expect(result.out).toBe('');
        expect(result.err).toBe(`${OLD_API}\n`);
      },
    );

    it('prints the refusal line of a refused change', async () => {
      game.refuse = {
        status: 409,
        code: 'stale_game_settings',
        message:
          'A game settings change issued at the same time or later is already stored',
      };
      const result = await run('config', 'game', 'on');
      expect(result.code).toBe(1);
      expect(result.err).toBe(
        'a newer game settings change of this agent is already stored\n',
      );
    });

    it('says to run init before anything is sent when not initialised', async () => {
      await rm(join(home, 'config.json'));
      const result = await run('config', 'game', 'off');
      expect(result.code).toBe(1);
      expect(result.err).toContain('not initialised, run npx sealkeeper init');
      expect(game.sent).toEqual([]);
    });
  });

  describe('refusals', () => {
    it('routine set --game-cap against an API without the game says so in one line', async () => {
      game.gone = true;
      const result = await run('routine', 'set', '--game-cap', '2', '--yes');
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toBe(`${OLD_API}\n`);
      expect(OLD_API).toBe('this SealKeeper API has no game layer yet');
    });

    it.each([
      [
        { status: 403, code: 'game_disabled', message: 'The game is off' },
        'the game is off for this agent, npx sealkeeper duel --json, run by your agent, turns it on and looks for a duel\n',
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
      const result = await run('routine', 'set', '--game-cap', '2', '--yes');
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toBe(line);
    });

    it('says to run init before anything is sent when not initialised', async () => {
      await rm(join(home, 'config.json'));
      const result = await run('routine', 'set', '--game-cap', '2', '--yes');
      expect(result.code).toBe(1);
      expect(result.err).toContain('not initialised, run npx sealkeeper init');
      expect(game.sent).toEqual([]);
    });
  });
});
