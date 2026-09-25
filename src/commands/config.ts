// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { requireConfig } from '../cli-config.js';
import { writeConfig } from '../config.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import { AUTO_SYNC_ON } from './sync.js';

const AUTO_SYNC_OFF = `automatic sync is off, events wait in the local log. See them with ${cli('sync --dry-run')} and send them with ${cli('sync')}`;

// Local settings in config.json. Only auto-sync can be changed here, the
// identity fields come from init.
export function register(parent: Command): Command {
  const config = parent
    .command('config')
    .description('Show or change local settings');

  config
    .command('show')
    .description('Print config.json, including whether auto-sync is on')
    .action(async function (this: Command): Promise<void> {
      const current = await requireConfig(this);
      // autoSync is unset until the first confirmed sync. Either way only
      // true sends on its own, so show and --json always say on or off.
      const shown = { ...current, autoSync: current.autoSync === true };
      if (wantsJson(this)) {
        stdout(JSON.stringify(shown));
        return;
      }
      const rows = Object.entries(shown).map(
        ([key, value]) =>
          [
            key,
            key === 'autoSync' ? (value ? 'on' : 'off') : String(value),
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

  return config;
}
