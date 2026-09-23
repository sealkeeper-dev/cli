// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { homedir } from 'node:os';
import { type Command, Option } from 'commander';
import {
  type CommandResult,
  installProveCommand,
  proveCommandPath,
  uninstallProveCommand,
} from '../claude-code-command.js';
import {
  claudeConfigDir,
  hookCommand,
  installHooks,
  type Scope,
  SettingsError,
  settingsPath,
  uninstallHooks,
} from '../claude-code-settings.js';
import { stdout, wantsJson } from '../output.js';

// Installs and removes framework hooks that call vouched. The home and
// working directories are injectable so tests never touch the real
// ~/.claude. claudeDir, when given, is the Claude Code config dir and wins
// over <home>/.claude.
export type AdapterDeps = {
  home: () => string;
  cwd: () => string;
  hookCommand: () => string;
  claudeDir?: () => string;
};

export const defaultAdapterDeps: AdapterDeps = {
  home: homedir,
  cwd: () => process.cwd(),
  hookCommand: () => hookCommand(),
  claudeDir: () => claudeConfigDir(),
};

// The command that installs the Claude Code hooks, printed wherever vouched
// suggests it.
export const INSTALL_COMMAND = 'vouched adapter claude-code install';

type ScopeOptions = { scope: Scope };

function scopeOption(): Option {
  return new Option('--scope <scope>', 'which settings file to change')
    .choices(['user', 'project'])
    .default('user');
}

export function register(
  parent: Command,
  deps: AdapterDeps = defaultAdapterDeps,
): Command {
  const adapter = parent
    .command('adapter')
    .description('Connect an agent framework to vouched');
  const claude = adapter
    .command('claude-code')
    .description('Claude Code hooks');

  claude
    .command('install')
    .description('Add the vouched hooks to Claude Code settings')
    .addOption(scopeOption())
    .action(async function (this: Command, options: ScopeOptions) {
      const file = pathFor(options.scope, deps);
      const added = await orExit(this, () =>
        installHooks(file, deps.hookCommand()),
      );
      const commandPath = proveCommandPath(file);
      const command = await orExit(this, () =>
        installProveCommand(commandPath),
      );
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            path: file,
            added,
            command: { path: commandPath, result: command },
          }),
        );
        return;
      }
      if (added.length === 0) {
        stdout(`vouched hooks already installed in ${file}`);
      } else {
        stdout(`added vouched hooks for ${added.join(', ')} to ${file}`);
      }
      stdout(commandLine(command, commandPath));
    });

  claude
    .command('uninstall')
    .description('Remove the vouched hooks from Claude Code settings')
    .addOption(scopeOption())
    .action(async function (this: Command, options: ScopeOptions) {
      const file = pathFor(options.scope, deps);
      const removed = await orExit(this, () => uninstallHooks(file));
      const commandPath = proveCommandPath(file);
      const commandRemoved = await orExit(this, () =>
        uninstallProveCommand(commandPath),
      );
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            path: file,
            removed,
            command: { path: commandPath, removed: commandRemoved },
          }),
        );
        return;
      }
      if (removed === 0) {
        stdout(`no vouched hooks in ${file}`);
      } else {
        stdout(
          `removed ${removed} vouched hook${removed === 1 ? '' : 's'} from ${file}`,
        );
      }
      if (commandRemoved) stdout(`removed ${PROVE_SLASH} from ${commandPath}`);
    });

  return adapter;
}

const PROVE_SLASH = 'the /vouched-prove command';

// One line on what install did with the slash command.
export function commandLine(result: CommandResult, path: string): string {
  if (result === 'written') return `added ${PROVE_SLASH} at ${path}`;
  if (result === 'unchanged') return `${PROVE_SLASH} is up to date at ${path}`;
  return `left ${path} alone, vouched did not write it`;
}

function pathFor(scope: Scope, deps: AdapterDeps): string {
  return settingsPath(scope, {
    home: deps.home(),
    cwd: deps.cwd(),
    claudeDir: deps.claudeDir?.(),
  });
}

async function orExit<T>(cmd: Command, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SettingsError) cmd.error(error.message);
    throw error;
  }
}
