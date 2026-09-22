// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { Command, Help } from 'commander';
import { register as registerCard } from './commands/card.js';
import { register as registerEmit } from './commands/emit.js';
import { register as registerInit } from './commands/init.js';
import { register as registerLogout } from './commands/logout.js';
import { register as registerRate } from './commands/rate.js';
import { register as registerStatus } from './commands/status.js';
import { register as registerSync } from './commands/sync.js';
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

export function createProgram(): Command {
  const program = new Command();

  program
    .name('vouched')
    .description('Cryptographic identity and track record for AI agents')
    .version(VERSION)
    .option('--json', 'print machine readable JSON where a command supports it')
    .configureHelp({ visibleCommands, subcommandTerm });

  registerInit(program);
  registerEmit(program);
  registerSync(program);
  registerCard(program);
  registerStatus(program);
  registerTasks(program);
  registerRate(program);
  registerWhoami(program);
  registerLogout(program);

  return program;
}
