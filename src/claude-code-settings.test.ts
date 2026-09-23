// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeConfigDir,
  HOOK_COMMAND,
  HOOK_EVENTS,
  hasHooks,
  installHooks,
  SettingsError,
  settingsPath,
} from './claude-code-settings.js';

// Shaped like a real settings file with another tool's hooks under every
// event name, most without a matcher. Written with no trailing newline, as
// Claude Code leaves it.
const NOTIFY =
  '[ -n "$OTHER_HOME" ] && [ -x "$OTHER_HOME/hooks/notify.sh" ] && "$OTHER_HOME/hooks/notify.sh" || true';
const plain = () => [{ hooks: [{ type: 'command', command: NOTIFY }] }];
const matched = (matcher: string) => [
  { matcher, hooks: [{ type: 'command', command: NOTIFY }] },
];
const CROWDED = {
  env: { SOME_FLAG: '1' },
  model: 'opus',
  hooks: {
    UserPromptSubmit: plain(),
    Stop: plain(),
    PostToolUse: matched('*'),
    PostToolUseFailure: matched('*'),
    PermissionRequest: matched('*'),
    SessionStart: plain(),
    SessionEnd: plain(),
    StopFailure: plain(),
    SubagentStart: plain(),
    SubagentStop: plain(),
    PreToolUse: matched('Artifact'),
  },
  effortLevel: 'high',
  modelSettings: { opus: { effortLevel: 'high' } },
  theme: 'dark',
};
const CROWDED_TEXT = JSON.stringify(CROWDED, null, 2);

const OURS = { hooks: [{ type: 'command', command: HOOK_COMMAND }] };

// Walks the new text line by line against the old. Every old line must turn
// up in order, unchanged or with a comma added because an entry now follows
// it. Returns the lines that are new.
function addedLines(before: string, after: string): string[] {
  const old = before.split('\n');
  const added: string[] = [];
  let i = 0;
  for (const line of after.split('\n')) {
    if (i < old.length && (line === old[i] || line === `${old[i]},`)) i++;
    else added.push(line);
  }
  expect(i, 'every original line is kept in order').toBe(old.length);
  return added;
}

describe('Claude Code settings', () => {
  let dir: string;
  const file = () => join(dir, 'settings.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vouched-settings-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges next to every existing entry and keeps them byte for byte', async () => {
    await writeFile(file(), CROWDED_TEXT);
    const added = await installHooks(file(), HOOK_COMMAND);
    expect(added).toEqual([...HOOK_EVENTS]);

    const after = await readFile(file(), 'utf8');
    // The data is the old data with ours appended to each of the five events.
    const expected = structuredClone(CROWDED) as {
      hooks: Record<string, unknown[]>;
    };
    for (const event of HOOK_EVENTS) expected.hooks[event]?.push(OURS);
    expect(JSON.parse(after)).toEqual(expected);
    // Key order is kept everywhere, including the event names.
    expect(Object.keys(JSON.parse(after).hooks)).toEqual(
      Object.keys(CROWDED.hooks),
    );
    // And the text is the old text plus our entries, nothing else.
    const ourEntry = JSON.stringify([OURS], null, 2)
      .split('\n')
      .slice(1, -1)
      .map((line) => `    ${line}`);
    expect(addedLines(CROWDED_TEXT, after)).toEqual(
      HOOK_EVENTS.flatMap(() => ourEntry),
    );
    expect(after.endsWith('\n')).toBe(false);
  });

  it('running twice changes nothing and does not write', async () => {
    await writeFile(file(), CROWDED_TEXT);
    await installHooks(file(), HOOK_COMMAND);
    const once = await readFile(file(), 'utf8');
    const mtime = (await stat(file())).mtimeMs;
    expect(await installHooks(file(), HOOK_COMMAND)).toEqual([]);
    expect(await readFile(file(), 'utf8')).toBe(once);
    expect((await stat(file())).mtimeMs).toBe(mtime);
  });

  it('keeps a tab indent, a four space indent and CRLF line endings', async () => {
    for (const indent of ['\t', '    ']) {
      const before = { model: 'opus', hooks: { Stop: plain() } };
      const text = `${JSON.stringify(before, null, indent)}\n`;
      await writeFile(file(), text);
      await installHooks(file(), HOOK_COMMAND);
      const expected = structuredClone(before) as {
        model: string;
        hooks: Record<string, unknown[]>;
      };
      expected.hooks.Stop?.push(OURS);
      for (const event of HOOK_EVENTS.filter((e) => e !== 'Stop')) {
        expected.hooks[event] = [OURS];
      }
      expect(await readFile(file(), 'utf8')).toBe(
        `${JSON.stringify(expected, null, indent)}\n`,
      );
    }

    const crlf = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`.replace(
      /\n/g,
      '\r\n',
    );
    await writeFile(file(), crlf);
    await installHooks(file(), HOOK_COMMAND);
    const after = await readFile(file(), 'utf8');
    expect(after.includes('\r\n')).toBe(true);
    expect(after.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('writes two spaces for a one line file', async () => {
    await writeFile(file(), '{}');
    await installHooks(file(), HOOK_COMMAND);
    expect(await readFile(file(), 'utf8')).toContain('\n  "hooks": {\n');
  });

  it('refuses a file that is not valid JSON, names it and leaves it', async () => {
    const broken = '{ "model": "opus", ';
    await writeFile(file(), broken);
    await expect(installHooks(file(), HOOK_COMMAND)).rejects.toThrow(
      new SettingsError(`${file()} is not valid JSON, left it unchanged`),
    );
    expect(await readFile(file(), 'utf8')).toBe(broken);
  });

  it('hasHooks sees ours and nothing else', async () => {
    expect(await hasHooks(file())).toBe(false);
    await writeFile(file(), CROWDED_TEXT);
    expect(await hasHooks(file())).toBe(false);
    await installHooks(file(), `npx -y ${HOOK_COMMAND}`);
    expect(await hasHooks(file())).toBe(true);
    await writeFile(file(), 'not json');
    expect(await hasHooks(file())).toBe(false);
  });

  it('finds the Claude Code dir from CLAUDE_CONFIG_DIR, else under home', () => {
    expect(claudeConfigDir({}, '/home/carl')).toBe('/home/carl/.claude');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, '/home/carl')).toBe(
      '/home/carl/.claude',
    );
    expect(
      claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/claude' }, '/home/carl'),
    ).toBe('/tmp/claude');
    expect(
      settingsPath('user', { home: '/h', cwd: '/c', claudeDir: '/tmp/claude' }),
    ).toBe('/tmp/claude/settings.json');
    expect(settingsPath('user', { home: '/h', cwd: '/c' })).toBe(
      '/h/.claude/settings.json',
    );
    expect(
      settingsPath('project', { home: '/h', cwd: '/c', claudeDir: '/x' }),
    ).toBe('/c/.claude/settings.json');
  });
});
