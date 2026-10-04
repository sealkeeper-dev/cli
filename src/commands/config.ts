// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { requireConfig } from '../cli-config.js';
import { paths, readNudge, writeConfig } from '../config.js';
import {
  changeGame,
  duelsStarted,
  gameRefusal,
  readGameStatus,
} from '../game.js';
import { cli } from '../invocation.js';
import { NUDGE_OFF, NUDGE_ON, setNudge } from '../nudge.js';
import { stdout, wantsJson } from '../output.js';
import type { GameSettingsResponse, GameStatusResponse } from '../responses.js';
import { openTaskSession, utc } from '../tasks.js';
import { AUTO_SYNC_ON } from './sync.js';

const AUTO_SYNC_OFF = `automatic sync is off, events wait in the local log. See them with ${cli('sync --dry-run')} and send them with ${cli('sync')}`;

// The game switch, as config game shows it and as on leaves it. The cap,
// the units and the duels started come from the API's answer.
export const gameSwitchLine = (game: GameStatusResponse): string =>
  game.enabled
    ? `Game on, ${game.usedToday} of ${game.cap} game units used today, they reset ${utc(game.resetAt)}.${duelsStarted(game)} ${cli('config game off')} stops it.`
    : `Game off, cap ${game.cap} game units a UTC day. ${cli('config game on')} turns it on.`;

// What config game off prints, Game off and what the API says the change
// closed (VOU-618). Only Game off when it closed nothing, the game was off
// already, or the API sends no counts.
export function gameOffLine({ closed }: GameSettingsResponse): string {
  const parts = closed
    ? [
        closed.seeks > 0 && `${count(closed.seeks, 'open seek')} ended`,
        closed.invitesSent > 0 &&
          `${count(closed.invitesSent, 'sent invite')} withdrawn`,
        closed.invitesReceived > 0 &&
          `${count(closed.invitesReceived, 'received invite')} declined`,
      ].filter((p) => p !== false)
    : [];
  return parts.length === 0 ? 'Game off.' : `Game off. ${parts.join(', ')}.`;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// fetch fills the goal cache when the nudge is turned on, and sends the
// game switch.
export type ConfigDeps = { fetch: typeof fetch };

export const defaultConfigDeps: ConfigDeps = {
  fetch: (...args) => fetch(...args),
};

// Local settings. auto-sync in config.json and the nudge in nudge.json can
// be changed here, the identity fields come from init, and the routine's
// settings from routine set (VOU-599). game is the one setting SealKeeper
// holds, the agent's game switch, read and changed with a signed request
// (VOU-611). Off is the one way to stop invites, since the cap counts only
// the duels the agent creates and the challenge tasks it claims.
export function register(
  parent: Command,
  deps: ConfigDeps = defaultConfigDeps,
): Command {
  const config = parent
    .command('config')
    .description('Show or change settings, the local ones and the game switch');

  config
    .command('show')
    .description(
      'Print config.json, including whether auto-sync and the nudge are on',
    )
    .action(async function (this: Command): Promise<void> {
      const current = await requireConfig(this);
      // autoSync is unset until the first confirmed sync. Either way only
      // true sends on its own, so show and --json always say on or off.
      // nudge is the same, only true adds the summary.
      const shown = {
        ...current,
        autoSync: current.autoSync === true,
        nudge: (await readNudge()) === true,
      };
      if (wantsJson(this)) {
        stdout(JSON.stringify(shown));
        return;
      }
      const rows = Object.entries(shown).map(
        ([key, value]) =>
          [
            key,
            typeof value === 'boolean'
              ? value
                ? 'on'
                : 'off'
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value),
          ] as const,
      );
      const width = Math.max(...rows.map(([key]) => key.length));
      for (const [key, value] of rows) stdout(`${key.padEnd(width)}  ${value}`);
    });

  config
    .command('auto-sync')
    .description('Turn automatic sync after emit on or off')
    .argument('<state>', 'on or off')
    .action(async function (this: Command, state: string): Promise<void> {
      if (state !== 'on' && state !== 'off') {
        this.error('auto-sync takes on or off');
      }
      const current = await requireConfig(this);
      const autoSync = state === 'on';
      await writeConfig({ ...current, autoSync });
      if (wantsJson(this)) {
        stdout(JSON.stringify({ autoSync }));
        return;
      }
      stdout(autoSync ? AUTO_SYNC_ON : AUTO_SYNC_OFF);
    });

  config
    .command('nudge')
    .description(
      'Turn the session nudge, a short goal summary at agent session start, on or off',
    )
    .argument('<state>', 'on or off')
    .action(async function (this: Command, state: string): Promise<void> {
      if (state !== 'on' && state !== 'off') {
        this.error('nudge takes on or off');
      }
      await requireConfig(this);
      const nudge = state === 'on';
      await setNudge(nudge, paths(), deps.fetch);
      if (wantsJson(this)) {
        stdout(JSON.stringify({ nudge }));
        return;
      }
      stdout(nudge ? NUDGE_ON : NUDGE_OFF);
    });

  config
    .command('game')
    .description(
      'Show the game switch and cap, or turn duels and weekly challenges on or off. Off is the one way to stop invites, since accepting one spends no game unit',
    )
    .argument('[state]', 'on or off, leave it out to show the switch')
    .action(async function (
      this: Command,
      state: string | undefined,
    ): Promise<void> {
      if (state !== undefined && state !== 'on' && state !== 'off') {
        this.error('game takes on or off, or nothing to show it');
      }
      const session = await openTaskSession(this, deps);
      let game: GameSettingsResponse;
      try {
        game =
          state === undefined
            ? await readGameStatus(session)
            : await changeGame(session, { enabled: state === 'on' });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        this.error(gameRefusal(error));
      }
      if (wantsJson(this)) {
        stdout(JSON.stringify(game));
        return;
      }
      stdout(state === 'off' ? gameOffLine(game) : gameSwitchLine(game));
    });

  return config;
}
