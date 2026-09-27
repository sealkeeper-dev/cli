// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { OperatorSlug } from '@sealkeeper/schema';
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
import { readOperatorSlug } from '../operator-slug.js';
import { stdout, wantsJson } from '../output.js';
import { allowedNames, normalLogin } from '../routine.js';
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
          JSON.stringify({
            limits: current.limits,
            allow: current.allow,
            allowSlugs: current.allowSlugs,
          }),
        );
        return;
      }
      for (const line of limitLines(current.limits)) stdout(line);
      stdout(`Allowed operators: ${allowedNames(current)}`);
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
    .argument('<operator>', 'the operator slug, the first half of its handles')
    .action(async function (this: Command, operator: string): Promise<void> {
      await changeAllow(this, operator, 'add');
    });

  routine
    .command('disallow')
    .description('Take an operator off the routine allowlist')
    .argument('<operator>', 'the operator slug, as the allowlist shows it')
    .action(async function (this: Command, operator: string): Promise<void> {
      await changeAllow(this, operator, 'remove');
    });
}

// New entries are operator slugs (VOU-196), as posters are shown by their
// handle, slug/name, and go to allowSlugs. Entries in allow are GitHub
// logins added before, still matched by login, never by slug. None is
// moved across, since a login and a slug of one spelling can belong to two
// operators. disallow takes a name off both lists, a login that is no slug
// included.
async function changeAllow(
  cmd: Command,
  raw: string,
  change: 'add' | 'remove',
): Promise<void> {
  const operator = normalLogin(raw);
  const config = await requireConfig(cmd);
  const current = await loadRoutineConfig(cmd);
  const same = (entry: string) => normalLogin(entry) === operator;
  const listed = current.allow.some(same) || current.allowSlugs.some(same);
  if (
    (change === 'add' || !listed) &&
    !OperatorSlug.safeParse(operator).success
  ) {
    cmd.error(
      `not an operator slug: ${raw}. A slug is the first half of a handle, lowercase letters, digits and single hyphens`,
    );
  }
  const own =
    (await readOperatorSlug(config.agentId)) ??
    normalLogin(config.operatorLogin);
  if (change === 'add' && own === operator) {
    cmd.error(
      'tasks between agents of the same operator never count, so your own operator is not added',
    );
  }
  const allow =
    change === 'add'
      ? current.allow
      : current.allow.filter((entry) => !same(entry));
  const allowSlugs =
    change === 'add'
      ? [...new Set([...current.allowSlugs, operator])].sort()
      : current.allowSlugs.filter((entry) => !same(entry));
  await writeRoutineConfig({ ...current, allow, allowSlugs });
  if (wantsJson(cmd)) {
    stdout(JSON.stringify({ allow, allowSlugs }));
    return;
  }
  stdout(
    change === 'add'
      ? `${operator} is allowed. Routine runs may claim tasks ${operator} addresses to this agent and confirm submissions from ${operator}.`
      : `${operator} is off the allowlist.`,
  );
}
