// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { GAME } from '@sealkeeper/schema';
import type { ApiError } from './api.js';
import { cli } from './invocation.js';

// One line per refusal. The API message is the fallback for codes this
// version does not know.
export function refusal(error: ApiError): string {
  switch (error.code) {
    // The API's message names the handle and a free name, as in
    // alice/claude-code is taken, try claude-code-2.
    case 'name_taken':
      return error.message;
    case 'stale_rename':
      return 'a newer rename of this agent is already stored';
    case 'stale_version':
      return 'a newer version change of this agent is already stored';
    case 'stale_runtime':
      return 'a newer runtime change of this agent is already stored';
    case 'stale_game_settings':
      return 'a newer game settings change of this agent is already stored';
    // The game layer. Every game command reads these two. The game is off
    // for the agent that acts, never the other side, which has its own
    // code.
    case 'game_disabled':
      return `the game is off for this agent, turn it on with ${cli('game on')}`;
    // The API's message names whose game units ran out, this agent's or
    // the other side's of a duel, and that they start again at 00:00 UTC,
    // so it is kept as it came.
    case 'game_cap_reached':
      return error.message;
    // The duel commands, and submit for duel_deadline_passed.
    case 'category_not_duelable':
      return `no duel can be played in this category, see ${cli('duel categories')}`;
    case 'opponent_not_playing':
      return 'the game is off for the other agent';
    case 'same_operator_duel':
      return 'two agents of one operator cannot duel';
    case 'too_many_open_duels':
      return `this agent holds ${GAME.openOutgoingMax} open seeks and invites already, cancel a seek with ${cli('duel unseek <seek-id>')} or wait for an answer`;
    case 'pair_duel_limit':
      return `these two agents started a duel in this category in the last ${GAME.pairDays} days`;
    case 'too_many_duel_requests':
      return `this agent made its ${GAME.requestsPerDay} seeks and invites for today, they start again at 00:00 UTC`;
    case 'seek_mismatch':
      return 'the API refused the request, the signed seek is not the one in the path';
    case 'duel_mismatch':
      return 'the API refused the request, the signed duel is not the one in the path';
    case 'duel_deadline_passed':
      return `the duel's ${GAME.duelHours} hour window has ended, this side can no longer submit`;
    case 'not_side':
      return 'only a side of the duel can ask for a rematch';
    case 'not_opponent':
      return 'only the invited agent can answer an invite';
    case 'seed_unavailable':
      return 'SealKeeper cannot start a duel right now, try again later';
    // The challenge commands, and submit of a challenge task from
    // the week's close on.
    case 'challenge_closed':
      return "this week's challenge has closed, the next one opens on Monday at 00:00 UTC";
    case 'issued_at_out_of_window':
      return 'the API refused the request time, check this machine clock';
    case 'rate_limited':
      return error.retryAfterSec === null
        ? 'too many requests, try again later'
        : `too many requests, try again in ${error.retryAfterSec} seconds`;
    case 'unknown_agent':
      return `this agent is not registered, run ${cli('init')}`;
    case 'forbidden':
      return 'the API refused, the key on this machine is not this agent';
    // The request was signed for the apiUrl in config, and the API that
    // answered serves another address.
    case 'wrong_audience':
      return `the API answers as another address, check apiUrl, ${error.message}`;
    default:
      return error.message;
  }
}
