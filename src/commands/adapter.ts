// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { homedir } from 'node:os';
import { type Command, Option } from 'commander';
import {
  type CommandResult,
  installProveCommand,
  proveCommandPath,
  removeOldProveCommand,
  uninstallProveCommand,
} from '../claude-code-command.js';
import {
  claudeConfigDir,
  hookCommand,
  type InstallResult,
  installHooks,
  invocationOf,
  type Scope,
  SettingsError,
  settingsPath,
  uninstallHooks,
} from '../claude-code-settings.js';
import { stdout, wantsJson } from '../output.js';

// Installs and removes framework hooks that call sealkeeper. The home and
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

// The command that installs the Claude Code hooks, printed wherever
// sealkeeper suggests it.
export const INSTALL_COMMAND = 'sealkeeper adapter claude-code install';

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
    .description('Connect an agent framework to sealkeeper');
  const claude = adapter
    .command('claude-code')
    .description('Claude Code hooks');

  claude
    .command('install')
    .description('Add the sealkeeper hooks to Claude Code settings')
    .addOption(scopeOption())
    .action(async function (this: Command, options: ScopeOptions) {
      const file = pathFor(options.scope, deps);
      const hook = deps.hookCommand();
      const result = await orExit(this, () => installHooks(file, hook));
      const commandPath = proveCommandPath(file);
      const command = await orExit(this, () =>
        installProveCommand(commandPath, invocationOf(hook)),
      );
      const oldCommand =
        command === 'kept'
          ? null
          : await orExit(this, () => removeOldProveCommand(file));
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            path: file,
            added: result.added,
            updated: result.updated,
            replaced: result.replaced,
            command: { path: commandPath, result: command },
            oldCommandRemoved: oldCommand,
          }),
        );
        return;
      }
      for (const line of hooksLines(result, file)) stdout(line);
      stdout(commandLine(command, commandPath));
      if (oldCommand !== null) stdout(oldCommandLine(oldCommand));
    });

  claude
    .command('uninstall')
    .description('Remove the sealkeeper hooks from Claude Code settings')
    .addOption(scopeOption())
    .action(async function (this: Command, options: ScopeOptions) {
      const file = pathFor(options.scope, deps);
      const removed = await orExit(this, () =>
        uninstallHooks(file, deps.hookCommand()),
      );
      const commandPath = proveCommandPath(file);
      const commandRemoved = await orExit(this, () =>
        uninstallProveCommand(commandPath),
      );
      const oldCommand = await orExit(this, () => removeOldProveCommand(file));
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            path: file,
            removed,
            command: { path: commandPath, removed: commandRemoved },
            oldCommandRemoved: oldCommand,
          }),
        );
        return;
      }
      if (removed === 0) {
        stdout(`no sealkeeper hooks in ${file}`);
      } else {
        stdout(
          `removed ${removed} sealkeeper hook${removed === 1 ? '' : 's'} from ${file}`,
        );
      }
      if (commandRemoved) stdout(`removed ${PROVE_SLASH} from ${commandPath}`);
      if (oldCommand !== null) stdout(oldCommandLine(oldCommand));
    });

  return adapter;
}

const PROVE_SLASH = 'the /sealkeeper-prove command';

// What install did with the hooks, one line for what it added and one for
// what it rewrote, or one saying nothing changed.
export function hooksLines(result: InstallResult, file: string): string[] {
  const lines: string[] = [];
  if (result.replaced.length > 0) {
    lines.push(
      `replaced the old vouched hooks for ${result.replaced.join(', ')} in ${file} with sealkeeper hooks`,
    );
  }
  if (result.added.length > 0) {
    lines.push(
      `added sealkeeper hooks for ${result.added.join(', ')} to ${file}`,
    );
  }
  if (result.updated.length > 0) {
    lines.push(
      `updated sealkeeper hooks for ${result.updated.join(', ')} in ${file}`,
    );
  }
  if (lines.length === 0)
    lines.push(`sealkeeper hooks already installed in ${file}`);
  return lines;
}

// One line on what install did with the slash command.
export function commandLine(result: CommandResult, path: string): string {
  if (result === 'written') return `added ${PROVE_SLASH} at ${path}`;
  if (result === 'unchanged') return `${PROVE_SLASH} is up to date at ${path}`;
  return `left ${path} alone, sealkeeper did not write it`;
}

// One line when install removed the slash command the old vouched package
// wrote.
export function oldCommandLine(path: string): string {
  return `removed the old /vouched-prove command at ${path}`;
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
