// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { refusal } from './refusal.js';

describe('refusal', () => {
  it('says to check apiUrl on wrong_audience and keeps the API message', () => {
    const message =
      'Envelope aud does not name this API. Sign with aud https://api.sealkeeper.run';
    const line = refusal(new ApiError(401, 'wrong_audience', message));
    expect(line).toBe(
      `the API answers as another address, check apiUrl, ${message}`,
    );
  });

  it('says how to turn the game on for game_disabled', () => {
    expect(
      refusal(new ApiError(403, 'game_disabled', 'The game is off')),
    ).toMatch(
      /^the game is off for this agent, .*duel --json, run by your agent, turns it on and looks for a duel$/,
    );
  });

  it('names the duel forms, never a removed duel command', () => {
    expect(
      refusal(new ApiError(409, 'category_not_duelable', 'Not duelable')),
    ).toMatch(/leave out --category and .*duel picks one$/);
    expect(
      refusal(new ApiError(409, 'too_many_open_duels', 'Too many')),
    ).toMatch(/cancel a seek with .*duel --cancel or wait for an answer$/);
  });

  it('keeps the API message for game_cap_reached, which names whose units ran out', () => {
    for (const message of [
      'This agent has used its 5 game units for today. They start again at 00:00 UTC',
      'The other agent has used its game units for today. They start again at 00:00 UTC',
    ]) {
      expect(
        refusal(new ApiError(429, 'game_cap_reached', message, [], 3600)),
      ).toBe(message);
    }
  });

  it('falls back to the API message for a code it does not know', () => {
    expect(refusal(new ApiError(400, 'something_new', 'no'))).toBe('no');
  });
});
