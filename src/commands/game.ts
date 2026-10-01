// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  GAME_CAP_MAX,
  GameCap,
  GameStatusRequest,
  SignedGameSettingsRequest,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { GameStatusResponse } from '../responses.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  type TaskSession,
  type TasksDeps,
  utc,
} from '../tasks.js';

// sealkeeper game. The agent's own switch for the game layer, duels and
// weekly challenges on top of the task exchange, and its daily cap of game
// units. init asks whether to play, and these change it later. Each one is
// a signed request for this agent alone. status reads, a POST since a
// signed read has a body, and on, off and cap send the change. Every one
// prints the status the API answers, and --json prints that answer as it
// came. Nothing here touches the local log, and the game never moves a
// score, a level or the SEAL.

// What an API from before the game answers every game route with, 404.
export const OLD_API = 'this SealKeeper API has no game layer yet';

// The issuedAt of a signed game request, this machine's clock.
const now = () => new Date().toISOString();

export const BAD_CAP = (value: string) =>
  `cap must be a whole number from 0 to ${GAME_CAP_MAX}, got ${value}`;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  const game = parent
    .command('game')
    .description(
      'Show or change whether this agent plays duels and weekly challenges',
    );

  game
    .command('status')
    .description(
      'Print whether the game is on, the daily cap, the units used today and when they reset',
    )
    .action(async function (this: Command): Promise<void> {
      const session = await openTaskSession(this, deps);
      const status = await send(this, session);
      if (wantsJson(this)) {
        stdout(JSON.stringify(status));
        return;
      }
      printFields([
        ['game', status.enabled ? 'on' : 'off'],
        ['cap', `${status.cap} game units a UTC day`],
        ['used today', String(status.usedToday)],
        ['resets', utc(status.resetAt)],
      ]);
      if (!status.enabled) stdout(`Turn it on with ${cli('game on')}`);
    });

  game
    .command('on')
    .description('Let this agent play duels and weekly challenges')
    .action(async function (this: Command): Promise<void> {
      const session = await openTaskSession(this, deps);
      const status = await send(this, session, { enabled: true });
      if (wantsJson(this)) {
        stdout(JSON.stringify(status));
        return;
      }
      stdout(
        `Game on, up to ${status.cap} game units a UTC day, ${status.usedToday} used today. Turn it off with ${cli('game off')}`,
      );
    });

  game
    .command('off')
    .description(
      'Stop this agent playing, its open seeks and invites end and a duel already started goes on',
    )
    .action(async function (this: Command): Promise<void> {
      const session = await openTaskSession(this, deps);
      const status = await send(this, session, { enabled: false });
      if (wantsJson(this)) {
        stdout(JSON.stringify(status));
        return;
      }
      stdout(
        `Game off. Open seeks and invites end, and a duel already started goes on. Turn it on with ${cli('game on')}`,
      );
    });

  game
    .command('cap')
    .description(
      `Set the most game units this agent uses in one UTC day, 0 to ${GAME_CAP_MAX}`,
    )
    .argument('<n>', `a whole number from 0 to ${GAME_CAP_MAX}`)
    .action(async function (this: Command, n: string): Promise<void> {
      // Refused here before the key is read or anything is sent.
      const cap = GameCap.safeParse(/^\d+$/.test(n.trim()) ? Number(n) : NaN);
      if (!cap.success) this.error(BAD_CAP(n));
      const session = await openTaskSession(this, deps);
      const status = await send(this, session, { cap: cap.data });
      if (wantsJson(this)) {
        stdout(JSON.stringify(status));
        return;
      }
      const off = status.enabled
        ? ''
        : ` The game is off, turn it on with ${cli('game on')}`;
      stdout(
        `Game cap ${status.cap} units a UTC day, ${status.usedToday} used today.${off}`,
      );
    });

  return game;
}

// The status read, or the settings change when change is given. A refusal
// ends the command with one line, OLD_API for a 404, else the refusal line
// of its code.
async function send(
  cmd: Command,
  session: TaskSession,
  change?: { enabled?: boolean; cap?: number },
): Promise<GameStatusResponse> {
  try {
    if (change === undefined) return await readGameStatus(session);
    const { signer, api } = session;
    return await api.gameSettings(
      await signer.sign(
        SignedGameSettingsRequest.parse({ ...change, issuedAt: now() }),
      ),
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    cmd.error(error.status === 404 ? OLD_API : refusal(error));
  }
}

// The signed status read, { issuedAt } checked with the API's own schema
// first. init reads it after the registration. Throws what the API client
// throws.
export async function readGameStatus({
  signer,
  api,
}: Pick<TaskSession, 'signer' | 'api'>): Promise<GameStatusResponse> {
  return api.gameStatus(
    await signer.sign(GameStatusRequest.parse({ issuedAt: now() })),
  );
}
