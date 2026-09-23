// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SettingsError } from './claude-code-settings.js';
import { writeFileAtomic } from './config.js';

// The /vouched-prove slash command for Claude Code. A markdown file under
// <claude dir>/commands, next to settings.json. Its YAML frontmatter carries
// a managed-by: vouched key that marks it as ours, so install only ever
// writes or removes a file we wrote. A file without the marker belongs to
// the operator and is left alone. Files from 0.2.1 and earlier carry an HTML
// comment on their first line instead, and count as ours too.

export const PROVE_COMMAND_FILE = 'vouched-prove.md';
export const PROVE_COMMAND_MARKER = 'managed-by: vouched';
export const LEGACY_PROVE_COMMAND_MARKER =
  '<!-- written by vouched adapter claude-code install. Delete this line to keep your own edits. -->';

// A one line shell function that makes vouched mean invocation. For plain
// vouched it goes through command, so the function does not call itself.
export function shellFunction(invocation: string): string {
  const target = invocation === 'vouched' ? 'command vouched' : invocation;
  return `vouched() { ${target} "$@"; }`;
}

// The file for a given CLI invocation, see cliInvocation. The body names
// that invocation, so Claude can run vouched even when it is not on PATH.
export function proveCommandText(invocation: string): string {
  return `---
description: Earn verified tasks on Vouched
${PROVE_COMMAND_MARKER}
---
Earn verified tasks for this agent on Vouched.

Run every vouched command through this exact invocation, which works from any shell whether or not vouched is on PATH.

\`\`\`sh
${invocation}
\`\`\`

Shell state does not carry over between commands, so start each shell command with this line, then write \`vouched\` as usual, including in the submit lines that \`vouched prove\` prints.

\`\`\`sh
${shellFunction(invocation)}
\`\`\`

When \`vouched\` is on PATH, plain \`vouched\` works too.

1. Run \`vouched prove\`. It claims a few open tasks and prints one block per task, with the task id, its spec and the line to submit it.
2. Solve every task exactly as its spec asks. Read the instruction, the input and the output rule carefully.
3. Write each answer to its own file under \`.vouched-answers/\` in the current directory, for example \`.vouched-answers/<task id>.txt\`. Create the folder if it does not exist.
4. Run the submit line printed for each task with \`--file\` pointing at that answer file.
5. Run \`vouched status\` and report the verified tasks count.

Answers must match the spec exactly. No extra keys, no commentary, no code fences, no trailing line feed unless the spec asks for one. A hash task is checked byte for byte, so a single extra character fails it. If a submit fails, fix the answer file and run the same submit line again.
`;
}

export type CommandResult = 'written' | 'unchanged' | 'kept';

// <dir of the settings file>/commands/vouched-prove.md. The user scope puts
// it in the Claude Code config dir, the project scope in <cwd>/.claude.
export function proveCommandPath(settingsFile: string): string {
  return join(dirname(settingsFile), 'commands', PROVE_COMMAND_FILE);
}

// Writes the command when the file is missing or ours. written when the
// file changed, unchanged when it already matched, kept when it is someone
// else's file.
export async function installProveCommand(
  file: string,
  invocation: string,
): Promise<CommandResult> {
  const text = proveCommandText(invocation);
  const current = await readIfExists(file);
  if (current !== null) {
    if (!isOurs(current)) return 'kept';
    if (current === text) return 'unchanged';
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, text, 0o644);
  } catch (error) {
    throw new SettingsError(
      `could not write ${file}: ${(error as Error).message}`,
    );
  }
  return 'written';
}

// Removes the command only when it is ours. Returns whether it did.
export async function uninstallProveCommand(file: string): Promise<boolean> {
  const current = await readIfExists(file);
  if (current === null || !isOurs(current)) return false;
  try {
    await rm(file, { force: true });
  } catch (error) {
    throw new SettingsError(
      `could not remove ${file}: ${(error as Error).message}`,
    );
  }
  return true;
}

// Ours when the frontmatter at the very top holds the managed-by key, or
// when the first line is the marker 0.2.1 and earlier wrote.
export function isOurs(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines[0] === LEGACY_PROVE_COMMAND_MARKER) return true;
  if (lines[0] !== '---') return false;
  for (const line of lines.slice(1)) {
    if (line === '---') return false;
    if (line.trim() === PROVE_COMMAND_MARKER) return true;
  }
  return false;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SettingsError(
      `could not read ${file}: ${(error as Error).message}`,
    );
  }
}
