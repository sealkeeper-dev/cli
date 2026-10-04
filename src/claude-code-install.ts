// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { basename } from 'node:path';
import { type Input, readYesNo } from './ask.js';
import {
  type CommandResult,
  commandPaths,
  installCommands,
  uninstallCommands,
} from './claude-code-command.js';
import {
  type InstallResult,
  installHooks,
  invocationOf,
  SettingsError,
  uninstallHooks,
} from './claude-code-settings.js';
import {
  installSkill,
  skillPath,
  uninstallSkill,
} from './claude-code-skill.js';
import { cli } from './invocation.js';
import { NUDGE_QUESTION } from './nudge.js';
import { promptStyled } from './output.js';
import { createStyle, type Styled } from './style.js';

// The Claude Code side of SealKeeper, the hooks, the slash commands and the
// skill, as init installs them and agent delete takes them out. Every file
// is changed only where SealKeeper wrote it, the hooks by their command and
// the commands and the skill by the managed-by marker, so a file the
// operator wrote is never touched.

// The command that installs the Claude Code hooks, printed wherever
// sealkeeper suggests it. init asks again on every run until they are in.
export const INSTALL_COMMAND = cli('init');

// What install did in one settings file. commands or skill is null when
// those files could not be written, which warn said.
export type ClaudeCodeInstall = {
  hooks: InstallResult;
  commands: { path: string; result: CommandResult }[] | null;
  skill: CommandResult | null;
};

// The hooks, the slash commands and the skill for one settings file.
// Throws a SettingsError when the settings file cannot be changed. The
// hooks are in once that worked, so a command or skill file that cannot be
// written only goes to warn.
export async function installClaudeCode(
  file: string,
  hook: string,
  warn: (message: string) => void,
): Promise<ClaudeCodeInstall> {
  const hooks = await installHooks(file, hook);
  const quietly = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      warn(error.message);
      return null;
    }
  };
  const commands = await quietly(() =>
    installCommands(file, invocationOf(hook)),
  );
  const skill = await quietly(() =>
    installSkill(skillPath(file), invocationOf(hook)),
  );
  return { hooks, commands, skill };
}

// What uninstall took out of one settings file and the shared one beside
// it, and the slash commands and the skill next to it.
export type ClaudeCodeUninstall = {
  path: string;
  removed: number;
  removedFromShared: number;
  commands: string[];
  skill: boolean;
};

// Takes every hook of ours out of file and out of the shared settings an
// older install wrote, then the slash commands and the skill of ours. A
// file without the marker stays. Throws a SettingsError when a file cannot
// be read or changed.
export async function uninstallClaudeCode(
  file: string,
  shared: string | null,
  hook: string,
): Promise<ClaudeCodeUninstall> {
  const removed = await uninstallHooks(file, hook);
  const removedFromShared =
    shared === null ? 0 : await uninstallHooks(shared, hook);
  const commands = await uninstallCommands(file);
  const skill = await uninstallSkill(skillPath(file));
  return { path: file, removed, removedFromShared, commands, skill };
}

// One line for each thing uninstall took out, none when it took nothing.
export function uninstallLines(
  result: ClaudeCodeUninstall,
  shared: string | null,
): string[] {
  const lines: string[] = [];
  const hooks = (n: number, file: string) =>
    `removed ${n} sealkeeper hook${n === 1 ? '' : 's'} from ${file}`;
  if (result.removed > 0) lines.push(hooks(result.removed, result.path));
  if (result.removedFromShared > 0 && shared !== null) {
    lines.push(hooks(result.removedFromShared, shared));
  }
  for (const path of result.commands) {
    lines.push(`removed ${slashOf(path)} from ${path}`);
  }
  if (result.skill) {
    lines.push(`removed ${SKILL} from ${skillPath(result.path)}`);
  }
  return lines;
}

// Every file install writes beside one settings file, for the guard that
// refuses a project folder that links outside the project.
export const installedPaths = (file: string): string[] => [
  file,
  ...commandPaths(file),
  skillPath(file),
];

const SKILL = 'the sealkeeper skill';

// The lines init prints with --json for one install, on stderr.
export function installLines(
  result: ClaudeCodeInstall,
  file: string,
): string[] {
  return [
    ...hooksLines(result.hooks, file),
    ...(result.commands ?? []).map((c) => commandLine(c.result, c.path)),
    ...(result.skill === null
      ? []
      : [skillLine(result.skill, skillPath(file))]),
  ];
}

// What install did with the hooks, one line each for what it added, what
// it rewrote and the retired tool call hooks it took out, or one saying
// nothing changed.
function hooksLines(result: InstallResult, file: string): string[] {
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
  if (result.removed.length > 0) lines.push(retiredLine(result.removed, file));
  if (lines.length === 0)
    lines.push(`sealkeeper hooks already installed in ${file}`);
  return lines;
}

// Said when install took the hooks of an older CLI out, the tool call
// hooks and Stop.
function retiredLine(events: string[], file: string): string {
  return `removed sealkeeper hooks for ${events.join(', ')} from ${file}, which record nothing now`;
}

// A slash command by its file, the /sealkeeper-run command for
// sealkeeper-run.md.
const slashOf = (path: string): string =>
  `the /${basename(path, '.md')} command`;

// One line on what install did with one slash command.
export function commandLine(result: CommandResult, path: string): string {
  if (result === 'written') return `added ${slashOf(path)} at ${path}`;
  if (result === 'unchanged') {
    return `${slashOf(path)} is up to date at ${path}`;
  }
  return `left ${path} alone, sealkeeper did not write it`;
}

// One line on what install did with the skill.
function skillLine(result: CommandResult, path: string): string {
  if (result === 'written') return `added ${SKILL} at ${path}`;
  if (result === 'unchanged') return `${SKILL} is up to date at ${path}`;
  return `left ${path} alone, sealkeeper did not write it`;
}

// Asked again after an answer that is not yes or no, up to this many
// questions in all, and then no.
const NUDGE_MAX_ASKS = 3;

// The session nudge question on stderr. Only y or yes turns it on. init
// indents it like its other questions.
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
