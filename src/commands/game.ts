// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  GAME_CAP_MAX,
  GameStatusRequest,
  SignedGameSettingsRequest,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { stdout, wantsJson } from '../output.js';
import { gameOnHint, refusal } from '../refusal.js';
import type { GameStatusResponse } from '../responses.js';
import {
  defaultTasksDeps,
  openTaskSession,
  type TaskSession,
  type TasksDeps,
} from '../tasks.js';

// sealkeeper game. The agent's own switch for the game layer, duels and
// weekly challenges on top of the task exchange. init asks whether to
// play, the agent's duel --json turns it on and looks for a duel
// (VOU-598), routine set --game-cap changes its daily cap of game units
// (VOU-599), and off turns it off, until VOU-603 gives that a home. Each
// one is a signed request for this agent alone, and sealkeeper status shows the game (VOU-596). Every
// one prints the game status the API answers, and --json prints that
// answer as it came.
// Nothing here touches the local log, and the game never moves a score, a
// level or the SEAL.

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
    .description('Change whether this agent plays duels and weekly challenges');

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
        `Game off. Open seeks and invites end, and a duel already started goes on. ${gameOnHint()}`,
      );
    });

  return game;
}

// The settings change. A refusal ends the command with one line, see
// gameRefusal.
async function send(
  cmd: Command,
  session: TaskSession,
  change: { enabled?: boolean; cap?: number },
): Promise<GameStatusResponse> {
  try {
    return await changeGame(session, change);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    cmd.error(gameRefusal(error));
  }
}

// The signed settings change, { enabled?, cap?, issuedAt } checked with
// the API's own schema first, the path game off and routine set share.
// Throws what the API client throws.
export async function changeGame(
  { signer, api }: Pick<TaskSession, 'signer' | 'api'>,
  change: { enabled?: boolean; cap?: number },
): Promise<GameStatusResponse> {
  return api.gameSettings(
    await signer.sign(
      SignedGameSettingsRequest.parse({ ...change, issuedAt: now() }),
    ),
  );
}

// One line for a refused settings change, OLD_API for a 404, else the
// refusal line of its code.
export const gameRefusal = (error: ApiError): string =>
  error.status === 404 ? OLD_API : refusal(error);

// The signed game status read, { issuedAt } checked with the API's own
// schema first. init reads it after the registration and a routine run
// before its game section. Throws what the API client throws.
export async function readGameStatus({
  signer,
  api,
}: Pick<TaskSession, 'signer' | 'api'>): Promise<GameStatusResponse> {
  return api.gameStatus(
    await signer.sign(GameStatusRequest.parse({ issuedAt: now() })),
  );
}
