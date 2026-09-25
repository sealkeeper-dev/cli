// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { Command, Help } from 'commander';
import type { CardDeps } from './card.js';
import {
  type AdapterDeps,
  register as registerAdapter,
} from './commands/adapter.js';
import { type AgentDeps, register as registerAgent } from './commands/agent.js';
import { register as registerCard } from './commands/card.js';
import { register as registerCheck } from './commands/check.js';
import { register as registerConfig } from './commands/config.js';
import { register as registerEmit } from './commands/emit.js';
import {
  type HookCommandDeps,
  register as registerHook,
} from './commands/hook.js';
import { type InitDeps, register as registerInit } from './commands/init.js';
import { register as registerLogout } from './commands/logout.js';
import { register as registerProve } from './commands/prove.js';
import { type RateDeps, register as registerRate } from './commands/rate.js';
import { register as registerSeal, type SealDeps } from './commands/seal.js';
import {
  register as registerStatus,
  type StatusDeps,
} from './commands/status.js';
import { register as registerSync, type SyncDeps } from './commands/sync.js';
import { register as registerTasks } from './commands/tasks.js';
import { register as registerWhatIsShared } from './commands/what-is-shared.js';
import { register as registerWhoami } from './commands/whoami.js';
import { terminalSafe } from './output.js';
import type { TasksDeps } from './tasks.js';
import { VERSION } from './version.js';

// Root help lists leaf commands with their full path ("card show", not "card",
// and "adapter claude-code install") so `sealkeeper --help` is the whole map
// of the CLI.
function visibleCommands(this: Help, cmd: Command): Command[] {
  const direct = Help.prototype.visibleCommands.call(this, cmd);
  if (cmd.parent) return direct;
  const leaves = (sub: Command): Command[] =>
    sub.commands.length === 0
      ? [sub]
      : Help.prototype.visibleCommands
          .call(this, sub)
          .filter((leaf) => leaf.name() !== 'help')
          .flatMap(leaves);
  return direct.flatMap(leaves);
}

function subcommandTerm(this: Help, cmd: Command): string {
  const term = Help.prototype.subcommandTerm.call(this, cmd);
  const groups: string[] = [];
  for (let c = cmd.parent; c?.parent; c = c.parent) groups.unshift(c.name());
  return [...groups, term].join(' ');
}

const JSON_FLAG = '--json';
const JSON_HELP = 'print machine readable JSON where a command supports it';

// Adds --json to every leaf command. Root options are positional (see
// createProgram), so without this `sealkeeper whoami --json` would be rejected.
function addJsonFlag(cmd: Command): void {
  if (cmd.commands.length === 0) {
    cmd.option(JSON_FLAG, JSON_HELP);
    return;
  }
  for (const sub of cmd.commands) addJsonFlag(sub);
}

type ProgramDeps = {
  init?: InitDeps;
  // Used by emit, sync and status. claudeDir and cwd only matter to status.
  sync?: SyncDeps & Omit<StatusDeps, 'fetch'>;
  card?: CardDeps;
  adapter?: AdapterDeps;
  hook?: HookCommandDeps;
  tasks?: TasksDeps;
  rate?: RateDeps;
  agent?: AgentDeps;
  seal?: Partial<SealDeps>;
};

export function createProgram(deps: ProgramDeps = {}): Command {
  const program = new Command();

  // Positional options stop the root from reading options that follow a
  // subcommand. Without it `sealkeeper init --version 1.0.0` would print the
  // CLI version instead of passing the agent version to init.
  program
    .name('sealkeeper')
    .description('Cryptographic identity and track record for AI agents')
    .version(VERSION)
    .option(JSON_FLAG, JSON_HELP)
    .enablePositionalOptions()
    .configureHelp({ visibleCommands, subcommandTerm })
    // Errors carry API messages, so they get the same escaping as stdout.
    .configureOutput({
      writeErr: (text) => process.stderr.write(terminalSafe(text)),
    });

  registerInit(program, deps.init);
  registerEmit(program, deps.sync);
  registerSync(program, deps.sync);
  registerCard(program, deps.card);
  registerSeal(program, deps.seal);
  registerStatus(program, deps.sync);
  registerTasks(program, deps.tasks);
  registerProve(program, deps.tasks);
  registerRate(program, deps.rate);
  registerAgent(program, deps.agent);
  registerWhoami(program);
  registerConfig(program);
  registerLogout(program);
  registerAdapter(program, deps.adapter);
  registerHook(program, deps.hook);
  registerWhatIsShared(program);
  registerCheck(program);

  for (const sub of program.commands) addJsonFlag(sub);
  return program;
}
