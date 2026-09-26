// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { homedir } from 'node:os';
import { type Command, Option } from 'commander';
import { type Input, readYesNo, streamInput } from '../ask.js';
import {
  type CommandResult,
  installProveCommand,
  proveCommandPath,
  uninstallProveCommand,
} from '../claude-code-command.js';
import {
  claudeConfigDir,
  hookCommand,
  type InstallResult,
  installHooks,
  invocationOf,
  refuseOutsideProject,
  type Scope,
  SettingsError,
  settingsPath,
  uninstallHooks,
} from '../claude-code-settings.js';
import {
  installSkill,
  skillPath,
  uninstallSkill,
} from '../claude-code-skill.js';
import {
  ConfigError,
  type Paths,
  paths,
  readConfig,
  readNudge,
} from '../config.js';
import { cli } from '../invocation.js';
import { NUDGE_OFF, NUDGE_ON, NUDGE_QUESTION, setNudge } from '../nudge.js';
import { promptStyled, stdout, wantsJson } from '../output.js';
import { createStyle, type Styled } from '../style.js';

// Installs and removes framework hooks that call sealkeeper. The home and
// working directories are injectable so tests never touch the real
// ~/.claude. claudeDir, when given, is the Claude Code config dir and wins
// over <home>/.claude. stdin answers the session nudge question, which is
// never asked without it, and paths is the SealKeeper home it reads and
// writes the answer in.
export type AdapterDeps = {
  home: () => string;
  cwd: () => string;
  hookCommand: () => string;
  claudeDir?: () => string;
  stdin?: () => Input;
  paths?: () => Paths;
};

const defaultAdapterDeps: AdapterDeps = {
  home: homedir,
  cwd: () => process.cwd(),
  hookCommand: () => hookCommand(),
  claudeDir: () => claudeConfigDir(),
  stdin: () => streamInput(process.stdin),
};

// The command that installs the Claude Code hooks, printed wherever
// sealkeeper suggests it.
export const INSTALL_COMMAND = cli('adapter claude-code install');

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
      const commandPath = proveCommandPath(file);
      const skillFile = skillPath(file);
      await guardProject(this, options.scope, deps, [
        file,
        commandPath,
        skillFile,
      ]);
      const hook = deps.hookCommand();
      const result = await orExit(this, () => installHooks(file, hook));
      const command = await orExit(this, () =>
        installProveCommand(commandPath, invocationOf(hook)),
      );
      const skill = await orExit(this, () =>
        installSkill(skillFile, invocationOf(hook)),
      );
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            path: file,
            added: result.added,
            updated: result.updated,
            command: { path: commandPath, result: command },
            skill: { path: skillFile, result: skill },
          }),
        );
        return;
      }
      for (const line of hooksLines(result, file)) stdout(line);
      stdout(commandLine(command, commandPath));
      stdout(skillLine(skill, skillFile));
      await offerNudge(deps);
    });

  claude
    .command('uninstall')
    .description('Remove the sealkeeper hooks from Claude Code settings')
    .addOption(scopeOption())
    .action(async function (this: Command, options: ScopeOptions) {
      const file = pathFor(options.scope, deps);
      const commandPath = proveCommandPath(file);
      const skillFile = skillPath(file);
      await guardProject(this, options.scope, deps, [
        file,
        commandPath,
        skillFile,
      ]);
      const removed = await orExit(this, () =>
        uninstallHooks(file, deps.hookCommand()),
      );
      const commandRemoved = await orExit(this, () =>
        uninstallProveCommand(commandPath),
      );
      const skillRemoved = await orExit(this, () => uninstallSkill(skillFile));
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            path: file,
            removed,
            command: { path: commandPath, removed: commandRemoved },
            skill: { path: skillFile, removed: skillRemoved },
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
      if (skillRemoved) stdout(`removed ${SKILL} from ${skillFile}`);
    });

  return adapter;
}

const PROVE_SLASH = 'the /sealkeeper-prove command';
const SKILL = 'the sealkeeper skill';

// What install did with the hooks, one line for what it added and one for
// what it rewrote, or one saying nothing changed.
export function hooksLines(result: InstallResult, file: string): string[] {
  const lines: string[] = [];
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

// One line on what install did with the skill.
export function skillLine(result: CommandResult, path: string): string {
  if (result === 'written') return `added ${SKILL} at ${path}`;
  if (result === 'unchanged') return `${SKILL} is up to date at ${path}`;
  return `left ${path} alone, sealkeeper did not write it`;
}

// Asks once whether to add the session nudge, on a terminal, when this
// machine has an agent and the operator was never asked. No is the default
// and is kept, so the question does not come back. config nudge on|off
// changes it later.
async function offerNudge(deps: AdapterDeps): Promise<void> {
  const input = deps.stdin?.();
  if (input === undefined || !input.isTTY) return;
  const p = deps.paths?.() ?? paths();
  let config: Awaited<ReturnType<typeof readConfig>>;
  try {
    config = await readConfig(p);
  } catch (error) {
    if (error instanceof ConfigError) return;
    throw error;
  }
  if (config === null || (await readNudge(p)) !== undefined) return;
  const on = await askNudge(input);
  await setNudge(on, p);
  stdout(on ? NUDGE_ON : NUDGE_OFF);
}

// Asked again after an answer that is not yes or no, up to this many
// questions in all, and then no.
const NUDGE_MAX_ASKS = 3;

// The nudge question on stderr. Only y or yes turns it on. init indents it
// like its other questions.
export async function askNudge(
  input: Input,
  layout: (line: Styled) => Styled = (line) => line,
): Promise<boolean> {
  const e = createStyle(process.stderr);
  const [question = ''] = NUDGE_QUESTION.split(' [y/N]');
  for (let asked = 0; asked < NUDGE_MAX_ASKS; asked++) {
    const again = asked === 0 ? '' : 'Please answer y or n. ';
    promptStyled(layout(e.line`${again}${question} ${e.dim('[y/N]')} `));
    const answer = readYesNo(await input.readLine(), 'no');
    if (answer !== 'unclear') return answer === 'yes';
  }
  return false;
}

function pathFor(scope: Scope, deps: AdapterDeps): string {
  return settingsPath(scope, {
    home: deps.home(),
    cwd: deps.cwd(),
    claudeDir: deps.claudeDir?.(),
  });
}

async function guardProject(
  cmd: Command,
  scope: Scope,
  deps: AdapterDeps,
  paths: string[],
): Promise<void> {
  if (scope !== 'project') return;
  await orExit(cmd, () => refuseOutsideProject(deps.cwd(), paths));
}

async function orExit<T>(cmd: Command, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SettingsError) cmd.error(error.message);
    throw error;
  }
}
