// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  GAME_CAP_MAX,
  GameStatusRequest,
  SignedGameSettingsRequest,
} from '@sealkeeper/schema';
import type { ApiError } from './api.js';
import { refusal } from './refusal.js';
import type { GameSettingsResponse, GameStatusResponse } from './responses.js';
import type { TaskSession } from './tasks.js';

// The agent's switch for the game layer, duels and weekly challenges on top
// of the task exchange, and its daily cap of game units. init sends the
// switch with the registration and the cap after it, challenge and duel
// turn the game on through their routes, config game shows the switch and
// turns it on or off (VOU-611), routine set --game-cap changes the cap and
// status shows the game. Each one is a signed request for this agent alone.
// The game never moves a score, a level or the SEAL.

// What an API from before the game answers every game route with, 404.
export const OLD_API = 'this SealKeeper API has no game layer yet';

// The issuedAt of a signed game request, this machine's clock.
const now = () => new Date().toISOString();

export const BAD_CAP = (value: string) =>
  `cap must be a whole number from 0 to ${GAME_CAP_MAX}, got ${value}`;

// The signed settings change, { enabled?, cap?, issuedAt } checked with
// the API's own schema first, the path init, config game and routine set
// share. Throws what the API client throws.
export async function changeGame(
  { signer, api }: Pick<TaskSession, 'signer' | 'api'>,
  change: { enabled?: boolean; cap?: number },
): Promise<GameSettingsResponse> {
  return api.gameSettings(
    await signer.sign(
      SignedGameSettingsRequest.parse({ ...change, issuedAt: now() }),
    ),
  );
}

// The duels started today against the ceiling, as a sentence that starts
// with a space, or nothing when the API did not send both numbers (VOU-618).
// config game and status print it on their game line, numbers as the API
// sent them.
export const duelsStarted = (game: GameStatusResponse): string =>
  game.duelsStartedToday === undefined || game.duelsPerDay === undefined
    ? ''
    : ` ${game.duelsStartedToday} of ${game.duelsPerDay} duels started today.`;

// One line for a refused settings change, OLD_API for a 404, else the
// refusal line of its code.
export const gameRefusal = (error: ApiError): string =>
  error.status === 404 ? OLD_API : refusal(error);

// The signed game status read, { issuedAt } checked with the API's own
// schema first. init reads it after the registration and the routine setup
// before it turns the game on, and config game reads it to show the
// switch. Throws what the API client throws.
export async function readGameStatus({
  signer,
  api,
}: Pick<TaskSession, 'signer' | 'api'>): Promise<GameStatusResponse> {
  return api.gameStatus(
    await signer.sign(GameStatusRequest.parse({ issuedAt: now() })),
  );
}
