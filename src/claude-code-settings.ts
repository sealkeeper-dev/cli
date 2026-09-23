// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { writeFileAtomic } from './config.js';

// Adds and removes the Vouched hooks in a Claude Code settings file. Hooks
// live under a top level hooks object keyed by event name. Each value is an
// array of {matcher?, hooks: [{type: 'command', command}]}. Entries that are
// not ours are never changed.

export const HOOK_COMMAND = 'vouched hook claude-code';
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'Stop',
] as const;

export type Scope = 'user' | 'project';

export class SettingsError extends Error {
  override name = 'SettingsError';
}

type Json = Record<string, unknown>;

// ~/.claude/settings.json for the user, <cwd>/.claude/settings.json for the
// project.
export function settingsPath(
  scope: Scope,
  dirs: { home: string; cwd: string },
): string {
  return join(
    scope === 'user' ? dirs.home : dirs.cwd,
    '.claude',
    'settings.json',
  );
}

// The command Claude Code runs. Plain `vouched` when that name on PATH runs
// this very script (a global install), otherwise through npx.
export function hookCommand(
  argv1: string | undefined = process.argv[1],
  pathEnv: string = process.env.PATH ?? '',
): string {
  const self = argv1 ? realOrNull(argv1) : null;
  const global =
    self !== null &&
    pathEnv
      .split(delimiter)
      .some(
        (dir) => dir.length > 0 && realOrNull(join(dir, 'vouched')) === self,
      );
  return global ? HOOK_COMMAND : `npx -y ${HOOK_COMMAND}`;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// Adds one hook entry per event that has none of ours yet. Returns the
// events it added, and writes only when there are some.
export async function installHooks(
  file: string,
  command: string,
): Promise<string[]> {
  const settings = await readSettings(file);
  const hooks = hooksOf(settings.data, file) ?? {};
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    const list = hooks[event] ?? [];
    if (!Array.isArray(list)) {
      throw new SettingsError(`hooks.${event} in ${file} is not an array`);
    }
    if (list.some((group) => ourHooks(group) > 0)) continue;
    list.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = list;
    added.push(event);
  }
  if (added.length > 0) {
    settings.data.hooks = hooks;
    await writeSettings(file, settings);
  }
  return added;
}

// Removes every hook whose command contains HOOK_COMMAND. A group left with
// no hooks goes, then an event left with no groups, then the hooks key when
// it ends up empty. Returns how many hooks it removed.
export async function uninstallHooks(file: string): Promise<number> {
  const settings = await readSettings(file);
  if (!settings.exists) return 0;
  const hooks = hooksOf(settings.data, file);
  if (hooks === null) return 0;

  let removed = 0;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    let removedHere = 0;
    const kept: unknown[] = [];
    for (const group of list) {
      const count = ourHooks(group);
      if (count === 0) {
        kept.push(group);
        continue;
      }
      removedHere += count;
      const rest = (group as { hooks: unknown[] }).hooks.filter(
        (hook) => !isOurs(hook),
      );
      if (rest.length > 0) kept.push({ ...(group as Json), hooks: rest });
    }
    if (removedHere === 0) continue;
    removed += removedHere;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removed === 0) return 0;
  if (Object.keys(hooks).length === 0) delete settings.data.hooks;
  await writeSettings(file, settings);
  return removed;
}

type Settings = {
  data: Json;
  exists: boolean;
  // Whether the file ended with a newline, kept on write.
  newline: boolean;
};

async function readSettings(file: string): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { data: {}, exists: false, newline: true };
    }
    throw error;
  }
  if (raw.trim().length === 0) return { data: {}, exists: true, newline: true };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SettingsError(`${file} is not valid JSON, left it unchanged`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SettingsError(`${file} is not a JSON object, left it unchanged`);
  }
  return { data: data as Json, exists: true, newline: raw.endsWith('\n') };
}

function hooksOf(data: Json, file: string): Record<string, unknown> | null {
  const hooks = data.hooks;
  if (hooks === undefined) return null;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new SettingsError(`hooks in ${file} is not an object`);
  }
  return hooks as Record<string, unknown>;
}

function isOurs(hook: unknown): boolean {
  if (typeof hook !== 'object' || hook === null) return false;
  const { command } = hook as Json;
  return typeof command === 'string' && command.includes(HOOK_COMMAND);
}

// How many of our hooks one group holds.
function ourHooks(group: unknown): number {
  if (typeof group !== 'object' || group === null) return 0;
  const { hooks } = group as Json;
  return Array.isArray(hooks) ? hooks.filter(isOurs).length : 0;
}

// Two space indent, like Claude Code writes it. A symlinked settings file is
// written through the link, and an existing file keeps its mode.
async function writeSettings(file: string, settings: Settings): Promise<void> {
  const target = await realpath(file).catch(() => file);
  await mkdir(dirname(target), { recursive: true });
  const mode = await stat(target)
    .then((s) => s.mode & 0o777)
    .catch(() => 0o644);
  const text = JSON.stringify(settings.data, null, 2);
  await writeFileAtomic(target, settings.newline ? `${text}\n` : text, mode);
}
