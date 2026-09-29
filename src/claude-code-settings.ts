// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep, win32 } from 'node:path';
import { writeFileAtomic } from './config.js';

// Adds and removes the SealKeeper hooks in a Claude Code settings file. Hooks
// live under a top level hooks object keyed by event name. Each value is an
// array of {matcher?, hooks: [{type: 'command', command}]}. Entries that are
// not ours are never changed.

// What follows the CLI invocation in every hook command we write.
const HOOK_ARGS = 'hook claude-code';
// The hooks record sessions only. Stop closes a session that never gets a
// SessionEnd, see claude-code.ts.
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'Stop'] as const;
// The tool call hooks a CLI before 0.4.14 installed. They record nothing
// now, and install takes ours out of each file it writes.
export const RETIRED_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
] as const;

export type Scope = 'user' | 'project';

export class SettingsError extends Error {
  override name = 'SettingsError';
}

type Json = Record<string, unknown>;

// Where Claude Code keeps its user settings. CLAUDE_CONFIG_DIR when set, the
// way Claude Code reads it, otherwise ~/.claude.
export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir.length > 0 ? dir : join(home, '.claude');
}

// <claude dir>/settings.json for the user, <cwd>/.claude/settings.local.json
// for the project. The claude dir defaults to <home>/.claude. A hook command
// holds this machine's absolute node and script paths, so project scope
// writes the local file, which stays on this machine, and never the shared
// settings.json a repo commits (cli-adapters-tasks-9).
export function settingsPath(
  scope: Scope,
  dirs: { home: string; cwd: string; claudeDir?: string },
): string {
  if (scope === 'user') {
    return join(dirs.claudeDir ?? join(dirs.home, '.claude'), 'settings.json');
  }
  return join(dirs.cwd, '.claude', 'settings.local.json');
}

// <cwd>/.claude/settings.json, where project scope wrote the hooks before
// they moved to settings.local.json. Still read, so hooks written there are
// found, and install and uninstall take ours out of it.
export function sharedProjectSettingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.json');
}

// Every settings file that may hold hooks of ours. The user settings, the
// project's local settings and the project's shared settings.
export function allSettingsPaths(dirs: {
  home: string;
  cwd: string;
  claudeDir?: string;
}): string[] {
  return [
    settingsPath('user', dirs),
    settingsPath('project', dirs),
    sharedProjectSettingsPath(dirs.cwd),
  ];
}

// Said after a project scope install. The hooks stay on this machine, but
// the command and skill files beside them name this machine's paths too.
export const PROJECT_PATHS_NOTE =
  'The hooks went to .claude/settings.local.json, since they hold absolute paths on this machine. .claude/commands/sealkeeper-prove.md and .claude/skills/sealkeeper/SKILL.md hold them too, so keep all three out of git and run the install on each machine.';

// How to run this CLI from any shell, whatever its PATH. The absolute node
// binary and the real path of the running script, each double quoted, for
// example "/usr/local/bin/node" "/usr/local/lib/node_modules/sealkeeper/dist/index.js".
// Under npx the script sits in the npx cache, which works until the cache is
// cleared. Without a script path, which only happens when this is not run as
// the CLI, it falls back to plain sealkeeper.
export function cliInvocation(
  execPath: string = process.execPath,
  argv1: string | undefined = process.argv[1],
): string {
  if (argv1 === undefined || argv1.length === 0) return 'sealkeeper';
  const script = realOrNull(argv1) ?? argv1;
  return `${shellQuote(stableNode(execPath))} ${shellQuote(script)}`;
}

// The same node binary and script as cliInvocation, unquoted, one argument
// each, for a scheduler that takes a program and its arguments. Empty when
// this is not run as the CLI.
export function cliProgram(
  execPath: string = process.execPath,
  argv1: string | undefined = process.argv[1],
): string[] {
  if (argv1 === undefined || argv1.length === 0) return [];
  return [stableNode(execPath), realOrNull(argv1) ?? argv1];
}

// Homebrew node reports its versioned Cellar path, such as
// /opt/homebrew/Cellar/node@24/24.20.0/bin/node, which brew cleanup deletes
// after an upgrade. When the stable opt link for the same formula exists
// and leads to the same binary, that link is used instead. Any other path
// is kept as it is.
const CELLAR_NODE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

export function stableNode(execPath: string): string {
  const match = CELLAR_NODE.exec(execPath);
  if (match === null) return execPath;
  const opt = `${match[1]}/opt/${match[2]}/bin/node`;
  const target = realOrNull(opt);
  return target !== null && target === (realOrNull(execPath) ?? execPath)
    ? opt
    : execPath;
}

// The command the hooks run.
export function hookCommand(
  execPath: string = process.execPath,
  argv1: string | undefined = process.argv[1],
): string {
  return `${cliInvocation(execPath, argv1)} ${HOOK_ARGS}`;
}

// The invocation a hook command starts with, the command minus HOOK_ARGS.
export function invocationOf(command: string): string {
  const suffix = ` ${HOOK_ARGS}`;
  return command.endsWith(suffix) ? command.slice(0, -suffix.length) : command;
}

// Whether the running script came through npx, whose cache lives under a
// directory named _npx.
export function isNpxCopy(
  argv1: string | undefined = process.argv[1],
): boolean {
  if (argv1 === undefined || argv1.length === 0) return false;
  const script = realOrNull(argv1) ?? argv1;
  return /[\\/]_npx[\\/]/.test(script);
}

// Double quoted for sh. Inside double quotes only these four characters
// are special, so each gets a backslash.
function shellQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}

// "<node>" "<script>" hook claude-code, as hookCommand writes it.
const ABSOLUTE = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)" hook claude-code$/;
// The sealkeeper package, installed by npm or in the npx cache.
const OUR_SCRIPT = /[\\/]sealkeeper[\\/]dist[\\/]index\.js$/;
// A build in the SealKeeper monorepo. Other monorepos have a
// packages/cli/dist/index.js too, so it is ours only while the package.json
// beside dist names sealkeeper.
const CHECKOUT_SCRIPT = /[\\/]packages[\\/]cli[\\/]dist[\\/]index\.js$/;

function unquote(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

// The node binary and script of a hook command in the absolute form, or
// null for any other command.
export function parseHookCommand(
  command: string,
): { node: string; script: string } | null {
  const match = ABSOLUTE.exec(command);
  if (match === null) return null;
  return { node: unquote(match[1] ?? ''), script: unquote(match[2] ?? '') };
}

// Whether a command is one of ours. The absolute form whose script is a
// sealkeeper package or a build in the SealKeeper monorepo, or exactly the
// command being installed now. It decides which hooks install rewrites and
// uninstall removes, so it never matches a hook of another tool.
export function isOurCommand(command: string, current?: string): boolean {
  if (command === current) return true;
  const parsed = parseHookCommand(command);
  return parsed !== null && isOurScript(parsed.script);
}

// A build in a checkout counts only at an absolute path, since a relative
// one runs from wherever Claude Code starts and would be read here against
// the folder the CLI runs in. win32.isAbsolute takes a POSIX path too.
function isOurScript(script: string): boolean {
  if (OUR_SCRIPT.test(script)) return true;
  if (!CHECKOUT_SCRIPT.test(script) || !win32.isAbsolute(script)) return false;
  try {
    const file = join(dirname(dirname(script)), 'package.json');
    return JSON.parse(readFileSync(file, 'utf8'))?.name === 'sealkeeper';
  } catch {
    return false;
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// updated lists the events where one of ours ran another command, removed
// the retired events whose hooks of ours were taken out.
export type InstallResult = {
  added: string[];
  updated: string[];
  removed: string[];
};

// A cloned repo can make .claude, its settings.json or its commands folder a
// symlink to anywhere on the machine. Project scope is only ever written
// inside the project, so each path must resolve there. User scope follows
// links on purpose, for settings kept in a dotfiles repo.
export async function refuseOutsideProject(
  cwd: string,
  paths: string[],
): Promise<void> {
  const root = await realpath(cwd).catch(() => cwd);
  for (const path of paths) {
    const real = await resolveExisting(path);
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new SettingsError(
        `refusing to write ${path}, it resolves to ${real}, outside the project`,
      );
    }
  }
}

// The real path of the nearest part of path that exists, with the rest
// appended, so a link anywhere along it is followed.
async function resolveExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await resolveExisting(parent), basename(path));
  }
}

// Adds one hook entry per event that has none of ours yet, rewrites any of
// ours whose command differs from command, in place, and takes ours out of
// the retired events. Entries that are not ours are never touched. Returns
// the events it added to, rewrote and took hooks out of, and writes only
// when there are some.
export async function installHooks(
  file: string,
  command: string,
): Promise<InstallResult> {
  const settings = await readSettings(file);
  const hooks = hooksOf(settings.data, file) ?? {};
  const added: string[] = [];
  const updated: string[] = [];
  const removed = dropOurs(hooks, RETIRED_HOOK_EVENTS, command).events;
  for (const event of HOOK_EVENTS) {
    const list = hooks[event] ?? [];
    if (!Array.isArray(list)) {
      throw new SettingsError(`hooks.${event} in ${file} is not an array`);
    }
    let found = false;
    let rewrote = false;
    for (const group of list) {
      for (const hook of ourHooks(group, command)) {
        found = true;
        if (hook.command !== command) {
          rewrote = true;
          hook.command = command;
        }
      }
    }
    if (rewrote) updated.push(event);
    if (found) continue;
    list.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = list;
    added.push(event);
  }
  if (added.length > 0 || updated.length > 0 || removed.length > 0) {
    settings.data.hooks = hooks;
    await writeSettings(file, settings);
  }
  return { added, updated, removed };
}

// Takes our hooks out of the retired events only, as install does, and
// leaves the rest of the file as it is. For init, which finds the current
// hooks in and does not install again. Returns the events it took hooks out
// of, and writes only when there are some.
export async function removeRetiredHooks(
  file: string,
  current?: string,
): Promise<string[]> {
  const settings = await readSettings(file);
  if (!settings.exists) return [];
  const hooks = hooksOf(settings.data, file);
  if (hooks === null) return [];
  const { events } = dropOurs(hooks, RETIRED_HOOK_EVENTS, current);
  if (events.length === 0) return [];
  if (Object.keys(hooks).length === 0) delete settings.data.hooks;
  await writeSettings(file, settings);
  return events;
}

// Whether the file holds a hook of ours under a retired event. A missing or
// unreadable file, or one that is not valid JSON, counts as none.
export async function hasRetiredHooks(file: string): Promise<boolean> {
  try {
    const hooks = hooksOf((await readSettings(file)).data, file);
    if (hooks === null) return false;
    return RETIRED_HOOK_EVENTS.some((event) => {
      const list = hooks[event];
      return (
        Array.isArray(list) && list.some((group) => ourHooks(group).length > 0)
      );
    });
  } catch {
    return false;
  }
}

// Whether the file holds at least one of our hooks. A missing or unreadable
// file, or one that is not valid JSON, counts as none.
// With current given, only a hook that runs exactly that command counts, so
// a stale path reads as not installed and gets rewritten.
export async function hasHooks(
  file: string,
  current?: string,
): Promise<boolean> {
  const commands = await ourCommands(file);
  if (current === undefined) return commands.length > 0;
  return commands.includes(current);
}

// Whether the Claude Code user or project settings hold hooks of ours, from
// any path. The /sealkeeper-prove command is written with them.
export async function claudeCodeHooksIn(dirs: {
  claudeDir?: () => string;
  cwd?: () => string;
}): Promise<boolean> {
  const where = {
    home: '',
    cwd: (dirs.cwd ?? (() => process.cwd()))(),
    claudeDir: (dirs.claudeDir ?? claudeConfigDir)(),
  };
  const found = await Promise.all(
    allSettingsPaths(where).map((file) => hasHooks(file)),
  );
  return found.some(Boolean);
}

// The commands of our hooks in the file, each once. A missing or unreadable
// file, or one that is not valid JSON, has none.
export async function ourCommands(file: string): Promise<string[]> {
  try {
    const settings = await readSettings(file);
    const hooks = hooksOf(settings.data, file);
    if (hooks === null) return [];
    const commands = new Set<string>();
    for (const list of Object.values(hooks)) {
      if (!Array.isArray(list)) continue;
      for (const group of list) {
        for (const hook of ourHooks(group)) commands.add(hook.command);
      }
    }
    return [...commands];
  } catch {
    return [];
  }
}

// Removes every hook of ours, see isOurCommand, with current as the command
// install would write now. A group left with no hooks goes, then an event
// left with no groups, then the hooks key when it ends up empty. Returns how
// many hooks it removed.
export async function uninstallHooks(
  file: string,
  current?: string,
): Promise<number> {
  const settings = await readSettings(file);
  if (!settings.exists) return 0;
  const hooks = hooksOf(settings.data, file);
  if (hooks === null) return 0;

  const { count } = dropOurs(hooks, Object.keys(hooks), current);
  if (count === 0) return 0;
  if (Object.keys(hooks).length === 0) delete settings.data.hooks;
  await writeSettings(file, settings);
  return count;
}

// Takes every hook of ours out of the named events, in place. A group left
// with no hooks goes, then an event left with no groups. Returns how many
// hooks it took out and the events it took them from.
function dropOurs(
  hooks: Record<string, unknown>,
  events: readonly string[],
  current?: string,
): { count: number; events: string[] } {
  let count = 0;
  const changed: string[] = [];
  for (const event of events) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    let removedHere = 0;
    const kept: unknown[] = [];
    for (const group of list) {
      const n = ourHooks(group, current).length;
      if (n === 0) {
        kept.push(group);
        continue;
      }
      removedHere += n;
      const rest = (group as { hooks: unknown[] }).hooks.filter(
        (hook) => !isOurs(hook, current),
      );
      if (rest.length > 0) kept.push({ ...(group as Json), hooks: rest });
    }
    if (removedHere === 0) continue;
    count += removedHere;
    changed.push(event);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return { count, events: changed };
}

type Settings = {
  data: Json;
  exists: boolean;
  // Whether the file ended with a newline, kept on write.
  newline: boolean;
  // The file's own indent and line ending, kept on write.
  indent: string;
  crlf: boolean;
};

const DEFAULT_INDENT = '  ';

// The whitespace before the first indented line. A file with none, such as
// {} on one line, gets two spaces like Claude Code writes.
function indentOf(raw: string): string {
  return /\n([ \t]+)\S/.exec(raw)?.[1] ?? DEFAULT_INDENT;
}

async function readSettings(file: string): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fresh(false);
    }
    throw error;
  }
  if (raw.trim().length === 0) return fresh(true);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SettingsError(`${file} is not valid JSON, left it unchanged`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SettingsError(`${file} is not a JSON object, left it unchanged`);
  }
  return {
    data: data as Json,
    exists: true,
    newline: raw.endsWith('\n'),
    indent: indentOf(raw),
    crlf: raw.includes('\r\n'),
  };
}

function fresh(exists: boolean): Settings {
  return {
    data: {},
    exists,
    newline: true,
    indent: DEFAULT_INDENT,
    crlf: false,
  };
}

function hooksOf(data: Json, file: string): Record<string, unknown> | null {
  const hooks = data.hooks;
  if (hooks === undefined) return null;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new SettingsError(`hooks in ${file} is not an object`);
  }
  return hooks as Record<string, unknown>;
}

type Hook = Json & { command: string };

function isOurs(hook: unknown, current?: string): hook is Hook {
  if (typeof hook !== 'object' || hook === null) return false;
  const { command } = hook as Json;
  return typeof command === 'string' && isOurCommand(command, current);
}

// Our hooks in one group, as the objects in the file, so install can
// rewrite them in place.
function ourHooks(group: unknown, current?: string): Hook[] {
  if (typeof group !== 'object' || group === null) return [];
  const { hooks } = group as Json;
  return Array.isArray(hooks)
    ? hooks.filter((hook): hook is Hook => isOurs(hook, current))
    : [];
}

// The indent and line endings the file had, two spaces and LF for a new one.
// Keys keep their order, so everything that was there is written back as it
// was apart from what we changed. A symlinked settings file is
// written through the link, and an existing file keeps its mode.
async function writeSettings(file: string, settings: Settings): Promise<void> {
  const target = await realpath(file).catch(() => file);
  await mkdir(dirname(target), { recursive: true });
  const mode = await stat(target)
    .then((s) => s.mode & 0o777)
    .catch(() => 0o644);
  const json = JSON.stringify(settings.data, null, settings.indent);
  const text = settings.newline ? `${json}\n` : json;
  await writeFileAtomic(
    target,
    settings.crlf ? text.replace(/\n/g, '\r\n') : text,
    mode,
  );
}
