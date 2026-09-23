// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { Command, Help } from 'commander';
import type { CardDeps } from './card.js';
import { register as registerCard } from './commands/card.js';
import { register as registerEmit } from './commands/emit.js';
import { type InitDeps, register as registerInit } from './commands/init.js';
import { register as registerLogout } from './commands/logout.js';
import { register as registerRate } from './commands/rate.js';
import { register as registerStatus } from './commands/status.js';
import { register as registerSync, type SyncDeps } from './commands/sync.js';
import { register as registerTasks } from './commands/tasks.js';
import { register as registerWhoami } from './commands/whoami.js';
import { VERSION } from './version.js';

// Root help lists leaf commands with their full path ("card show", not "card")
// so `vouched --help` is the whole map of the CLI.
function visibleCommands(this: Help, cmd: Command): Command[] {
  const direct = Help.prototype.visibleCommands.call(this, cmd);
  if (cmd.parent) return direct;
  return direct.flatMap((sub) =>
    sub.commands.length === 0
      ? [sub]
      : Help.prototype.visibleCommands
          .call(this, sub)
          .filter((leaf) => leaf.name() !== 'help'),
  );
}

function subcommandTerm(this: Help, cmd: Command): string {
  const term = Help.prototype.subcommandTerm.call(this, cmd);
  const group = cmd.parent?.parent ? cmd.parent.name() : null;
  return group ? `${group} ${term}` : term;
}

const JSON_FLAG = '--json';
const JSON_HELP = 'print machine readable JSON where a command supports it';

// Adds --json to every leaf command. Root options are positional (see
// createProgram), so without this `vouched whoami --json` would be rejected.
function addJsonFlag(cmd: Command): void {
  if (cmd.commands.length === 0) {
    cmd.option(JSON_FLAG, JSON_HELP);
    return;
  }
  for (const sub of cmd.commands) addJsonFlag(sub);
}

export type ProgramDeps = {
  init?: InitDeps;
  // Used by emit, sync and status.
  sync?: SyncDeps;
  card?: CardDeps;
};

export function createProgram(deps: ProgramDeps = {}): Command {
  const program = new Command();

  // Positional options stop the root from reading options that follow a
  // subcommand. Without it `vouched init --version 1.0.0` would print the
  // CLI version instead of passing the agent version to init.
  program
    .name('vouched')
    .description('Cryptographic identity and track record for AI agents')
    .version(VERSION)
    .option(JSON_FLAG, JSON_HELP)
    .enablePositionalOptions()
    .configureHelp({ visibleCommands, subcommandTerm });

  registerInit(program, deps.init);
  registerEmit(program, deps.sync);
  registerSync(program, deps.sync);
  registerCard(program, deps.card);
  registerStatus(program, deps.sync);
  registerTasks(program);
  registerRate(program);
  registerWhoami(program);
  registerLogout(program);

  for (const sub of program.commands) addJsonFlag(sub);
  return program;
}
