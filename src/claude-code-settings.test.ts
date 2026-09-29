// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allSettingsPaths,
  claudeConfigDir,
  cliInvocation,
  HOOK_EVENTS,
  hasHooks,
  hasRetiredHooks,
  hookCommand,
  installHooks,
  invocationOf,
  isNpxCopy,
  isOurCommand,
  ourCommands,
  parseHookCommand,
  RETIRED_HOOK_EVENTS,
  removeRetiredHooks,
  SettingsError,
  settingsPath,
  sharedProjectSettingsPath,
  stableNode,
  uninstallHooks,
} from './claude-code-settings.js';

// A hook command in the absolute form hookCommand writes, for a global
// install and for an npx copy.
const HOOK_COMMAND =
  '"/usr/local/bin/node" "/usr/local/lib/node_modules/sealkeeper/dist/index.js" hook claude-code';
const NPX_COMMAND =
  '"/usr/local/bin/node" "/home/alice/.npm/_npx/abc123/node_modules/sealkeeper/dist/index.js" hook claude-code';

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
    dir = await mkdtemp(join(tmpdir(), 'sealkeeper-settings-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges next to every existing entry and keeps them byte for byte', async () => {
    await writeFile(file(), CROWDED_TEXT);
    const { added, updated } = await installHooks(file(), HOOK_COMMAND);
    expect(added).toEqual([...HOOK_EVENTS]);
    expect(updated).toEqual([]);

    const after = await readFile(file(), 'utf8');
    // The data is the old data with ours appended to each of the three
    // events.
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

  // VOU-451. The hooks record sessions only.
  it('a fresh install writes the three session hooks', async () => {
    expect(HOOK_EVENTS).toEqual(['SessionStart', 'SessionEnd', 'Stop']);
    expect(await installHooks(file(), HOOK_COMMAND)).toEqual({
      added: ['SessionStart', 'SessionEnd', 'Stop'],
      updated: [],
      removed: [],
    });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      hooks: { SessionStart: [OURS], SessionEnd: [OURS], Stop: [OURS] },
    });
  });

  // What an install before 0.4.14 left, ours under six events next to
  // another tool's hooks, at a path that has since moved.
  const olderInstall = () => {
    const old = structuredClone(CROWDED) as {
      hooks: Record<string, unknown[]>;
    };
    const npx = { hooks: [{ type: 'command', command: NPX_COMMAND }] };
    for (const event of [...HOOK_EVENTS, ...RETIRED_HOOK_EVENTS]) {
      old.hooks[event]?.push(npx);
    }
    // One group holds a foreign hook and ours, so only ours goes.
    old.hooks.PreToolUse?.push({
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: NOTIFY },
        { type: 'command', command: NPX_COMMAND },
      ],
    });
    return old;
  };

  it('a repeat install over six hooks leaves three and every foreign hook', async () => {
    await writeFile(file(), JSON.stringify(olderInstall(), null, 2));
    expect(await hasRetiredHooks(file())).toBe(true);
    expect(await installHooks(file(), HOOK_COMMAND)).toEqual({
      added: [],
      updated: [...HOOK_EVENTS],
      removed: [...RETIRED_HOOK_EVENTS],
    });
    const expected = structuredClone(CROWDED) as {
      hooks: Record<string, unknown[]>;
    };
    for (const event of HOOK_EVENTS) expected.hooks[event]?.push(OURS);
    expected.hooks.PreToolUse?.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: NOTIFY }],
    });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(expected);
    expect(await hasRetiredHooks(file())).toBe(false);
  });

  it('removeRetiredHooks takes out only our tool call hooks', async () => {
    expect(await removeRetiredHooks(file())).toEqual([]);
    const old = olderInstall();
    await writeFile(file(), JSON.stringify(old, null, 2));
    expect(await removeRetiredHooks(file(), HOOK_COMMAND)).toEqual([
      ...RETIRED_HOOK_EVENTS,
    ]);
    const after = JSON.parse(await readFile(file(), 'utf8'));
    for (const event of HOOK_EVENTS) {
      expect(after.hooks[event]).toEqual(old.hooks[event]);
    }
    expect(after.hooks.PostToolUse).toEqual(CROWDED.hooks.PostToolUse);
    expect(after.hooks.PreToolUse).toEqual([
      ...CROWDED.hooks.PreToolUse,
      { matcher: 'Bash', hooks: [{ type: 'command', command: NOTIFY }] },
    ]);
    const mtime = (await stat(file())).mtimeMs;
    expect(await removeRetiredHooks(file(), HOOK_COMMAND)).toEqual([]);
    expect((await stat(file())).mtimeMs).toBe(mtime);
    // A tool call hook of another tool is not ours to report.
    await writeFile(file(), CROWDED_TEXT);
    expect(await hasRetiredHooks(file())).toBe(false);
  });

  it('running twice changes nothing and does not write', async () => {
    await writeFile(file(), CROWDED_TEXT);
    await installHooks(file(), HOOK_COMMAND);
    const once = await readFile(file(), 'utf8');
    const mtime = (await stat(file())).mtimeMs;
    expect(await installHooks(file(), HOOK_COMMAND)).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
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
    await installHooks(file(), NPX_COMMAND);
    expect(await hasHooks(file())).toBe(true);
    expect(await ourCommands(file())).toEqual([NPX_COMMAND]);
    await writeFile(file(), 'not json');
    expect(await hasHooks(file())).toBe(false);
  });

  describe('a build in a monorepo', () => {
    // packages/cli in a checkout, with a package.json of the given name
    // beside dist, or none when name is null. Returns the hook command a
    // build there writes.
    async function checkout(repo: string, name: string | null) {
      const cli = join(dir, repo, 'packages', 'cli');
      await mkdir(join(cli, 'dist'), { recursive: true });
      if (name !== null) {
        await writeFile(join(cli, 'package.json'), JSON.stringify({ name }));
      }
      return `"/usr/local/bin/node" "${join(cli, 'dist', 'index.js')}" hook claude-code`;
    }

    it('counts a SealKeeper build as ours, so a repeat install finds it', async () => {
      const ours = await checkout('work', 'sealkeeper');
      expect(isOurCommand(ours)).toBe(true);
      await installHooks(file(), ours);
      expect(await hasHooks(file(), ours)).toBe(true);
      expect(await ourCommands(file())).toEqual([ours]);
      const again = await installHooks(file(), ours);
      expect(again).toEqual({ added: [], updated: [], removed: [] });
    });

    it('never claims the hook of another tool built at a path that looks alike', async () => {
      const others = [
        await checkout('other', 'other-tool'),
        await checkout('scoped', '@sealkeeper/cli'),
        await checkout('bare', null),
        await checkout('sealkeeper', 'sealkeeper-helper'),
      ];
      const broken = await checkout('broken', null);
      await writeFile(
        join(dir, 'broken', 'packages', 'cli', 'package.json'),
        'not json',
      );
      others.push(broken);
      // Our package.json, but not the script a build writes.
      await checkout('near', 'sealkeeper');
      others.push(
        `"/usr/local/bin/node" "${join(dir, 'near', 'packages', 'cli', 'dist', 'other.js')}" hook claude-code`,
        `"/usr/local/bin/node" "${join(dir, 'near', 'packages', 'cli', 'index.js')}" hook claude-code`,
        // Relative, so it runs from wherever Claude Code starts, and never
        // read against the folder the CLI runs in. Tests run from the root
        // of this repo, whose packages/cli/package.json names sealkeeper.
        '"/usr/local/bin/node" "./packages/cli/dist/index.js" hook claude-code',
        '"/usr/local/bin/node" "packages/cli/dist/index.js" hook claude-code',
      );
      for (const command of others) {
        expect(isOurCommand(command), command).toBe(false);
      }

      const ours = await checkout('work', 'sealkeeper');
      await writeFile(
        file(),
        JSON.stringify({
          hooks: {
            SessionStart: others.map((command) => ({
              hooks: [{ type: 'command', command }],
            })),
          },
        }),
      );
      expect(await hasHooks(file())).toBe(false);
      await installHooks(file(), ours);
      expect(await ourCommands(file())).toEqual([ours]);
      expect(await uninstallHooks(file(), ours)).toBe(HOOK_EVENTS.length);
      const left = JSON.parse(await readFile(file(), 'utf8')).hooks
        .SessionStart as { hooks: { command: string }[] }[];
      expect(left.map((group) => group.hooks[0]?.command)).toEqual(others);
    });
  });

  it('finds the Claude Code dir from CLAUDE_CONFIG_DIR, else under home', () => {
    expect(claudeConfigDir({}, '/home/alice')).toBe('/home/alice/.claude');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, '/home/alice')).toBe(
      '/home/alice/.claude',
    );
    expect(
      claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/claude' }, '/home/alice'),
    ).toBe('/tmp/claude');
    expect(
      settingsPath('user', { home: '/h', cwd: '/c', claudeDir: '/tmp/claude' }),
    ).toBe('/tmp/claude/settings.json');
    expect(settingsPath('user', { home: '/h', cwd: '/c' })).toBe(
      '/h/.claude/settings.json',
    );
    // Project hooks hold this machine's paths, so they go to the local
    // file, and the shared one is only read for older installs.
    expect(
      settingsPath('project', { home: '/h', cwd: '/c', claudeDir: '/x' }),
    ).toBe('/c/.claude/settings.local.json');
    expect(sharedProjectSettingsPath('/c')).toBe('/c/.claude/settings.json');
    expect(
      allSettingsPaths({ home: '/h', cwd: '/c', claudeDir: '/x' }),
    ).toEqual([
      '/x/settings.json',
      '/c/.claude/settings.local.json',
      '/c/.claude/settings.json',
    ]);
  });

  it('rewrites only our entries when the path changed, foreign ones byte for byte', async () => {
    await writeFile(file(), CROWDED_TEXT);
    await installHooks(file(), NPX_COMMAND);
    const before = await readFile(file(), 'utf8');
    const result = await installHooks(file(), HOOK_COMMAND);
    expect(result).toEqual({
      added: [],
      updated: [...HOOK_EVENTS],
      removed: [],
    });
    const after = await readFile(file(), 'utf8');
    // The text is the old text with our command swapped, nothing else.
    expect(after).toBe(
      before.replaceAll(
        JSON.stringify(NPX_COMMAND),
        JSON.stringify(HOOK_COMMAND),
      ),
    );
    expect(addedLines(CROWDED_TEXT, after)).toHaveLength(
      HOOK_EVENTS.length * 8,
    );
    expect(await ourCommands(file())).toEqual([HOOK_COMMAND]);
  });

  it('uninstall removes the absolute and current forms and nothing else', async () => {
    const dev =
      '"/usr/bin/node" "/src/sealkeeper/packages/cli/dist/index.js" hook claude-code';
    const before = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: NOTIFY },
              { type: 'command', command: HOOK_COMMAND },
              { type: 'command', command: dev },
            ],
          },
        ],
      },
    };
    await writeFile(file(), JSON.stringify(before, null, 2));
    expect(await uninstallHooks(file())).toBe(1);
    expect(await uninstallHooks(file(), dev)).toBe(1);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: NOTIFY }] }] },
    });
  });
});

describe('hookCommand', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-bin-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function script(...parts: string[]): Promise<string> {
    const path = join(root, ...parts, 'sealkeeper', 'dist', 'index.js');
    await mkdir(join(root, ...parts, 'sealkeeper', 'dist'), {
      recursive: true,
    });
    await writeFile(path, '');
    return path;
  }

  it('quotes the node binary and the real script path for a global install', async () => {
    const real = await script('lib', 'node_modules');
    // npm links bin/sealkeeper to the script. argv[1] is the link.
    await mkdir(join(root, 'bin'));
    await symlink(real, join(root, 'bin', 'sealkeeper'));
    const command = hookCommand(
      '/usr/local/bin/node',
      join(root, 'bin', 'sealkeeper'),
    );
    const realRoot = parseHookCommand(command)?.script;
    expect(
      realRoot?.endsWith('/lib/node_modules/sealkeeper/dist/index.js'),
    ).toBe(true);
    expect(command).toBe(
      `"/usr/local/bin/node" "${realRoot}" hook claude-code`,
    );
    expect(isOurCommand(command)).toBe(true);
    expect(isNpxCopy(join(root, 'bin', 'sealkeeper'))).toBe(false);
  });

  it('points at the npx cache copy under npx', async () => {
    const npx = await script('.npm', '_npx', 'abc123', 'node_modules');
    const command = hookCommand('/opt/node/bin/node', npx);
    expect(command).toMatch(
      /^"\/opt\/node\/bin\/node" "[^"]*\/\.npm\/_npx\/abc123\/node_modules\/sealkeeper\/dist\/index\.js" hook claude-code$/,
    );
    expect(isOurCommand(command)).toBe(true);
    expect(isNpxCopy(npx)).toBe(true);
  });

  it('writes the Homebrew opt link in place of a versioned Cellar node', async () => {
    const cellar = join(root, 'Cellar', 'node@24', '24.20.0', 'bin');
    await mkdir(cellar, { recursive: true });
    const node = join(cellar, 'node');
    await writeFile(node, '');
    await mkdir(join(root, 'opt'));
    await symlink(
      join(root, 'Cellar', 'node@24', '24.20.0'),
      join(root, 'opt', 'node@24'),
    );
    const opt = join(root, 'opt', 'node@24', 'bin', 'node');
    expect(stableNode(node)).toBe(opt);
    const npx = await script('_npx', 'c', 'node_modules');
    expect(hookCommand(node, npx).startsWith(`"${opt}" "`)).toBe(true);
  });

  it('keeps a Cellar node when the opt link is missing or leads elsewhere', async () => {
    const node = join(root, 'Cellar', 'node@24', '24.20.0', 'bin', 'node');
    await mkdir(join(root, 'Cellar', 'node@24', '24.20.0', 'bin'), {
      recursive: true,
    });
    await writeFile(node, '');
    expect(stableNode(node)).toBe(node);

    const other = join(root, 'Cellar', 'node@24', '24.21.0');
    await mkdir(join(other, 'bin'), { recursive: true });
    await writeFile(join(other, 'bin', 'node'), '');
    await mkdir(join(root, 'opt'));
    await symlink(other, join(root, 'opt', 'node@24'));
    expect(stableNode(node)).toBe(node);
    expect(stableNode('/usr/local/bin/node')).toBe('/usr/local/bin/node');
  });

  it('never looks at PATH', async () => {
    const npx = await script('_npx', 'x', 'node_modules');
    // A sealkeeper on PATH that runs this very script, the case 0.2.1 got wrong.
    await mkdir(join(root, 'bin'));
    await symlink(npx, join(root, 'bin', 'sealkeeper'));
    const saved = process.env.PATH;
    try {
      process.env.PATH = join(root, 'bin');
      const withPath = hookCommand('/n', npx);
      process.env.PATH = '';
      expect(hookCommand('/n', npx)).toBe(withPath);
      expect(withPath.startsWith('"/n" "')).toBe(true);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('escapes what is special inside double quotes', () => {
    const command = hookCommand(
      '/Program Files/node',
      '/no/such/dir with "quotes" $HOME `x`/sealkeeper/dist/index.js',
    );
    expect(command).toBe(
      '"/Program Files/node" "/no/such/dir with \\"quotes\\" \\$HOME \\`x\\`/sealkeeper/dist/index.js" hook claude-code',
    );
    expect(parseHookCommand(command)).toEqual({
      node: '/Program Files/node',
      script: '/no/such/dir with "quotes" $HOME `x`/sealkeeper/dist/index.js',
    });
    expect(isOurCommand(command)).toBe(true);
  });

  it('gives the invocation without the hook arguments', () => {
    expect(invocationOf(HOOK_COMMAND)).toBe(
      '"/usr/local/bin/node" "/usr/local/lib/node_modules/sealkeeper/dist/index.js"',
    );
    expect(invocationOf(HOOK_COMMAND)).toBe(
      cliInvocation(
        '/usr/local/bin/node',
        '/usr/local/lib/node_modules/sealkeeper/dist/index.js',
      ),
    );
    expect(cliInvocation('/n', '')).toBe('sealkeeper');
  });

  it('does not claim a command that only looks similar', () => {
    expect(isOurCommand('other-tool hook claude-code')).toBe(false);
    expect(isOurCommand('"/n" "/x/other/dist/index.js" hook claude-code')).toBe(
      false,
    );
    expect(isOurCommand(NOTIFY)).toBe(false);
    expect(isOurCommand('vouched hook claude-code')).toBe(false);
    expect(
      isOurCommand(
        '"/n" "/usr/local/lib/node_modules/vouched/dist/index.js" hook claude-code',
      ),
    ).toBe(false);
  });
});
