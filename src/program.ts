// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { Command } from 'commander';
import { type AgentDeps, register as registerAgent } from './commands/agent.js';
import { register as registerChallenge } from './commands/challenge.js';
import { register as registerCheck } from './commands/check.js';
import { register as registerClaim } from './commands/claim.js';
import {
  type ConfigDeps,
  register as registerConfig,
} from './commands/config.js';
import { register as registerDuel } from './commands/duel.js';
import { register as registerEmit } from './commands/emit.js';
import {
  type HookCommandDeps,
  register as registerHook,
} from './commands/hook.js';
import { type InitDeps, register as registerInit } from './commands/init.js';
import { register as registerLogout } from './commands/logout.js';
import { register as registerOutcome } from './commands/outcome.js';
import { register as registerPost } from './commands/post.js';
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
import { register as registerWhatIsShared } from './commands/what-is-shared.js';
import { JSON_FLAG, JSON_HELP, terminalSafe } from './output.js';
import { VERSION } from './version.js';

// The two groups of sealkeeper --help. The six core commands first, then
// the rest under More. Hidden commands are in neither.
export const CORE_GROUP = 'Core:';
export const MORE_GROUP = 'More:';

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
    // Errors carry API messages, so they get the same escaping as stdout.
    .configureOutput({
      writeErr: (text) => process.stderr.write(terminalSafe(text)),
    });

  // The core commands, in the order a new agent meets them.
  program.commandsGroup(CORE_GROUP);
  registerInit(program, deps.init, deps.routine);
  registerRun(program, deps.tasks);
  registerChallenge(program, deps.tasks);
  registerDuel(program, deps.tasks);
  registerStatus(program, deps.tasks, deps.routine);
  registerRoutine(program, deps.routine);

  program.commandsGroup(MORE_GROUP);
  registerSubmit(program, deps.tasks);
  registerRelease(program, deps.tasks);
  registerClaim(program, deps.tasks);
  registerPost(program, deps.tasks);
  registerOutcome(program, deps.tasks);
  registerSeal(program, deps.seal);
  registerCheck(program);
  registerAgent(program, deps.agent, deps.routine);
  registerConfig(program, deps.config);
  registerLogout(program, deps.routine);
  registerWhatIsShared(program);
  program.helpCommand(true);

  // Hidden. Adapters and the hooks call emit, sync and hook, and rate waits
  // until ratings open. Each one still runs when called by name.
  registerEmit(program, deps.sync);
  registerSync(program, deps.sync);
  registerHook(program, deps.hook);
  registerRate(program, deps.rate);

  for (const sub of program.commands) addJsonFlag(sub);
  return program;
}
