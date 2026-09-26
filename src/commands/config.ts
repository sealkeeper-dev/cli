// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { loadRoutineConfig, requireConfig } from '../cli-config.js';
import {
  ROUTINE_LIMIT_MAX,
  readNudge,
  writeConfig,
  writeRoutineConfig,
} from '../config.js';
import { cli } from '../invocation.js';
import { NUDGE_OFF, NUDGE_ON, setNudge } from '../nudge.js';
import { stdout, wantsJson } from '../output.js';
import { normalLogin } from '../routine.js';
import { LIMIT_OPTIONS, limitLines } from './routine.js';
import { AUTO_SYNC_ON } from './sync.js';

const AUTO_SYNC_OFF = `automatic sync is off, events wait in the local log. See them with ${cli('sync --dry-run')} and send them with ${cli('sync')}`;

// Local settings. auto-sync in config.json, the nudge in nudge.json and the
// routine's limits and allowlist in routine.json can be changed here, the
// identity fields come from init.
export function register(parent: Command): Command {
  const config = parent
    .command('config')
    .description('Show or change local settings');

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
      await setNudge(nudge);
      if (wantsJson(this)) {
        stdout(JSON.stringify({ nudge }));
        return;
      }
      stdout(nudge ? NUDGE_ON : NUDGE_OFF);
    });

  registerRoutine(config);
  return config;
}

// config routine. The guardrails of sealkeeper routine (VOU-138). The
// limits and the allowlist exist before routine install, so an operator can
// set them first.
function registerRoutine(parent: Command): void {
  const routine = parent
    .command('routine')
    .description("Show or change the routine's limits and allowlist");

  routine
    .command('show')
    .description("Print the routine's limits and allowlist")
    .action(async function (this: Command): Promise<void> {
      const current = await loadRoutineConfig(this);
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({ limits: current.limits, allow: current.allow }),
        );
        return;
      }
      for (const line of limitLines(current.limits)) stdout(line);
      stdout(
        `Allowed operators: ${current.allow.length === 0 ? 'nobody yet' : current.allow.join(', ')}`,
      );
    });

  const names = Object.keys(LIMIT_OPTIONS).join(', ');
  routine
    .command('set')
    .description('Change one routine limit')
    .argument('<limit>', names)
    .argument('<value>', 'a whole number')
    .action(async function (
      this: Command,
      name: string,
      value: string,
    ): Promise<void> {
      const key = LIMIT_OPTIONS[name];
      if (key === undefined) this.error(`limit must be one of ${names}`);
      const n = Number(value);
      const min =
        key === 'minutesPerRun' ? 1 : key === 'tokensPerRun' ? 1000 : 0;
      const max = ROUTINE_LIMIT_MAX[key];
      if (!/^\d+$/.test(value) || n < min || n > max) {
        this.error(`${name} takes a whole number from ${min} to ${max}`);
      }
      const current = await loadRoutineConfig(this);
      const limits = { ...current.limits, [key]: n };
      await writeRoutineConfig({ ...current, limits });
      if (wantsJson(this)) {
        stdout(JSON.stringify({ limits }));
        return;
      }
      stdout(`${name} is ${n}.`);
    });

  routine
    .command('allow')
    .description(
      'Let routine runs take addressed tasks and submissions from an operator',
    )
    .argument('<login>', 'the operator GitHub login')
    .action(async function (this: Command, login: string): Promise<void> {
      await changeAllow(this, login, 'add');
    });

  routine
    .command('disallow')
    .description('Take an operator off the routine allowlist')
    .argument('<login>', 'the operator GitHub login')
    .action(async function (this: Command, login: string): Promise<void> {
      await changeAllow(this, login, 'remove');
    });
}

// A GitHub login. Letters, digits and single hyphens, at most 39.
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

async function changeAllow(
  cmd: Command,
  raw: string,
  change: 'add' | 'remove',
): Promise<void> {
  const login = normalLogin(raw);
  if (!LOGIN.test(login)) cmd.error(`not a GitHub login: ${raw}`);
  const config = await requireConfig(cmd);
  const current = await loadRoutineConfig(cmd);
  if (change === 'add' && normalLogin(config.operatorLogin) === login) {
    cmd.error(
      'tasks between agents of the same operator never count, so your own login is not added',
    );
  }
  const allow =
    change === 'add'
      ? [...new Set([...current.allow, login])].sort()
      : current.allow.filter((l) => l !== login);
  await writeRoutineConfig({ ...current, allow });
  if (wantsJson(cmd)) {
    stdout(JSON.stringify({ allow }));
    return;
  }
  stdout(
    change === 'add'
      ? `${login} is allowed. Routine runs may claim tasks ${login} addresses to this agent and confirm submissions from ${login}.`
      : `${login} is off the allowlist.`,
  );
}
