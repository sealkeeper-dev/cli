// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { Command, Help } from 'commander';
import type { CardDeps } from './card.js';
import {
  type AdapterDeps,
  register as registerAdapter,
} from './commands/adapter.js';
import { type AgentDeps, register as registerAgent } from './commands/agent.js';
import { register as registerCard } from './commands/card.js';
import { register as registerChallenge } from './commands/challenge.js';
import { register as registerCheck } from './commands/check.js';
import {
  type ConfigDeps,
  register as registerConfig,
} from './commands/config.js';
import { register as registerDuel } from './commands/duel.js';
import { register as registerEmit } from './commands/emit.js';
import { register as registerGame } from './commands/game.js';
import {
  type HookCommandDeps,
  register as registerHook,
} from './commands/hook.js';
import { type InitDeps, register as registerInit } from './commands/init.js';
import { register as registerLogout } from './commands/logout.js';
import { register as registerModel } from './commands/model.js';
import { type RateDeps, register as registerRate } from './commands/rate.js';
import { register as registerRelease } from './commands/release.js';
import {
  type RoutineDeps,
  register as registerRoutine,
} from './commands/routine.js';
import { register as registerRun } from './commands/run.js';
import { register as registerSeal, type SealDeps } from './commands/seal.js';
import {
  register as registerStatus,
  type StatusDeps,
} from './commands/status.js';
import { register as registerSubmit } from './commands/submit.js';
import { register as registerSync, type SyncDeps } from './commands/sync.js';
import { register as registerTasks } from './commands/tasks.js';
import { register as registerWhatIsShared } from './commands/what-is-shared.js';
import { JSON_FLAG, JSON_HELP, terminalSafe } from './output.js';
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

// Adds --json to every leaf command. Root options are positional (see
// createProgram), so without this `sealkeeper status --json` would be rejected.
function addJsonFlag(cmd: Command): void {
  if (cmd.commands.length === 0) {
    cmd.option(JSON_FLAG, JSON_HELP);
    return;
  }
  for (const sub of cmd.commands) addJsonFlag(sub);
}

type ProgramDeps = {
  init?: InitDeps;
  sync?: SyncDeps;
  card?: CardDeps;
  adapter?: AdapterDeps;
  hook?: HookCommandDeps;
  // run, submit, release, the task and game commands, and status, which
  // also reads env for the one time runtime question.
  tasks?: StatusDeps;
  rate?: RateDeps;
  agent?: AgentDeps;
  seal?: Partial<SealDeps>;
  routine?: RoutineDeps;
  config?: ConfigDeps;
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

  registerInit(program, deps.init, deps.routine);
  registerEmit(program, deps.sync);
  registerSync(program, deps.sync);
  registerCard(program, deps.card);
  registerSeal(program, deps.seal);
  registerStatus(program, deps.tasks, deps.routine);
  registerRun(program, deps.tasks);
  registerSubmit(program, deps.tasks);
  registerRelease(program, deps.tasks);
  registerTasks(program, deps.tasks);
  registerGame(program, deps.tasks);
  registerDuel(program, deps.tasks);
  registerChallenge(program, deps.tasks);
  registerRoutine(program, deps.routine);
  registerRate(program, deps.rate);
  registerAgent(program, deps.agent, deps.routine);
  registerConfig(program, deps.config);
  registerModel(program);
  registerLogout(program, deps.routine);
  registerAdapter(program, deps.adapter);
  registerHook(program, deps.hook);
  registerWhatIsShared(program);
  registerCheck(program);

  for (const sub of program.commands) addJsonFlag(sub);
  return program;
}
