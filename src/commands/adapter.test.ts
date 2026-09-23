// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  chmod,
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
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVE_COMMAND_MARKER,
  PROVE_COMMAND_TEXT,
} from '../claude-code-command.js';
import { HOOK_COMMAND, hookCommand } from '../claude-code-settings.js';
import { createProgram } from '../program.js';

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

// Settings another tool already wrote, with hooks of its own on some of the
// same events.
const OTHER = {
  model: 'opus',
  permissions: { allow: ['Bash(pnpm test)'] },
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'other-tool check', timeout: 5 }],
      },
    ],
    Notification: [{ hooks: [{ type: 'command', command: 'notify-send hi' }] }],
  },
};
const OTHER_TEXT = `${JSON.stringify(OTHER, null, 2)}\n`;

const OUR_ENTRY = { hooks: [{ type: 'command', command: HOOK_COMMAND }] };
const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'Stop',
];

describe('adapter claude-code', () => {
  let root: string;
  let home: string;
  let project: string;

  const userFile = () => join(home, '.claude', 'settings.json');
  const projectFile = () => join(project, '.claude', 'settings.json');
  const userCommand = () =>
    join(home, '.claude', 'commands', 'vouched-prove.md');

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({
      adapter: {
        home: () => home,
        cwd: () => project,
        hookCommand: () => HOOK_COMMAND,
      },
    });
    throwOnExit(program);
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    try {
      await program.parseAsync(['adapter', 'claude-code', ...args], {
        from: 'user',
      });
      return { code: 0, out, err };
    } catch (error) {
      if (error instanceof CommanderError) {
        return { code: error.exitCode, out, err };
      }
      throw error;
    } finally {
      vi.restoreAllMocks();
    }
  }

  async function readJson(file: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(file, 'utf8'));
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vouched-adapter-'));
    home = join(root, 'home');
    project = join(root, 'project');
    await mkdir(home);
    await mkdir(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('install into a missing file creates it with the five hooks', async () => {
    const { code, out } = await run('install');
    expect(code).toBe(0);
    expect(out).toBe(
      `added vouched hooks for ${EVENTS.join(', ')} to ${userFile()}\nadded the /vouched-prove command at ${userCommand()}\n`,
    );
    const text = await readFile(userFile(), 'utf8');
    expect(text).toBe(
      `${JSON.stringify(
        { hooks: Object.fromEntries(EVENTS.map((e) => [e, [OUR_ENTRY]])) },
        null,
        2,
      )}\n`,
    );
  });

  it('--scope project writes under the working directory', async () => {
    const { code, out } = await run('install', '--scope', 'project');
    expect(code).toBe(0);
    expect(out).toContain(projectFile());
    expect(
      Object.keys((await readJson(projectFile())).hooks as object),
    ).toEqual(EVENTS);
  });

  it('rejects an unknown scope', async () => {
    const { code, err } = await run('install', '--scope', 'global');
    expect(code).toBe(1);
    expect(err).toContain('Allowed choices are user, project');
  });

  it('install keeps every existing entry and only appends ours', async () => {
    await mkdir(join(home, '.claude'));
    await writeFile(userFile(), OTHER_TEXT);
    await chmod(userFile(), 0o640);
    await run('install');

    const after = await readJson(userFile());
    const hooks = after.hooks as Record<string, unknown[]>;
    expect(after.model).toBe('opus');
    expect(after.permissions).toEqual(OTHER.permissions);
    expect(hooks.PreToolUse).toEqual([OTHER.hooks.PreToolUse[0], OUR_ENTRY]);
    expect(hooks.Notification).toEqual(OTHER.hooks.Notification);
    for (const event of EVENTS) expect(hooks[event]?.at(-1)).toEqual(OUR_ENTRY);
    expect((await stat(userFile())).mode & 0o777).toBe(0o640);

    // Taking our entries back out gives the original bytes.
    await run('uninstall');
    expect(await readFile(userFile(), 'utf8')).toBe(OTHER_TEXT);
  });

  it('install twice adds nothing the second time', async () => {
    await run('install');
    const first = await readFile(userFile(), 'utf8');
    const { out } = await run('install');
    expect(out).toBe(
      `vouched hooks already installed in ${userFile()}\nthe /vouched-prove command is up to date at ${userCommand()}\n`,
    );
    expect(await readFile(userFile(), 'utf8')).toBe(first);
  });

  it('treats the npx form of the command as already installed', async () => {
    await mkdir(join(home, '.claude'));
    const npx = {
      hooks: Object.fromEntries(
        EVENTS.map((e) => [
          e,
          [{ hooks: [{ type: 'command', command: `npx -y ${HOOK_COMMAND}` }] }],
        ]),
      ),
    };
    await writeFile(userFile(), JSON.stringify(npx, null, 2));
    const { out } = await run('install');
    expect(out).toContain('already installed');
  });

  it('uninstall removes only ours and cleans up empty containers', async () => {
    await mkdir(join(home, '.claude'));
    const mixed = {
      ...OTHER,
      hooks: {
        ...OTHER.hooks,
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'other-tool stop' },
              { type: 'command', command: `npx -y ${HOOK_COMMAND}` },
            ],
          },
        ],
      },
    };
    await writeFile(userFile(), JSON.stringify(mixed, null, 2));
    await run('install');
    const { code, out } = await run('uninstall', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      path: userFile(),
      removed: 5,
      command: { path: userCommand(), removed: true },
    });

    const after = await readJson(userFile());
    expect(after).toEqual({
      ...OTHER,
      hooks: {
        ...OTHER.hooks,
        Stop: [{ hooks: [{ type: 'command', command: 'other-tool stop' }] }],
      },
    });
  });

  it('uninstall drops the hooks key when only ours were there', async () => {
    await mkdir(join(home, '.claude'));
    await writeFile(userFile(), '{\n  "model": "opus"\n}\n');
    await run('install');
    const { out } = await run('uninstall');
    expect(out).toBe(
      `removed 5 vouched hooks from ${userFile()}\nremoved the /vouched-prove command from ${userCommand()}\n`,
    );
    expect(await readFile(userFile(), 'utf8')).toBe(
      '{\n  "model": "opus"\n}\n',
    );
  });

  it('uninstall with no file or none of ours changes nothing', async () => {
    expect((await run('uninstall')).out).toBe(
      `no vouched hooks in ${userFile()}\n`,
    );
    await mkdir(join(home, '.claude'));
    await writeFile(userFile(), OTHER_TEXT);
    await run('uninstall');
    expect(await readFile(userFile(), 'utf8')).toBe(OTHER_TEXT);
  });

  it('refuses a settings file that is not JSON and leaves it alone', async () => {
    await mkdir(join(home, '.claude'));
    await writeFile(userFile(), '{ nope');
    const { code, err } = await run('install');
    expect(code).toBe(1);
    expect(err).toContain('is not valid JSON');
    expect(await readFile(userFile(), 'utf8')).toBe('{ nope');
  });

  describe('the /vouched-prove command', () => {
    it('install writes it next to the settings with the marker first', async () => {
      const { out } = await run('install', '--json');
      expect(JSON.parse(out).command).toEqual({
        path: userCommand(),
        result: 'written',
      });
      const text = await readFile(userCommand(), 'utf8');
      expect(text).toBe(PROVE_COMMAND_TEXT);
      expect(text.split('\n')[0]).toBe(PROVE_COMMAND_MARKER);
      expect(text).toContain('`vouched prove`');
      expect(text).toContain('.vouched-answers/');
      expect(text).toContain('`vouched status`');
      expect(text).toContain('No extra keys, no commentary');
    });

    it('--scope project writes it under the working directory', async () => {
      await run('install', '--scope', 'project');
      expect(
        await readFile(
          join(project, '.claude', 'commands', 'vouched-prove.md'),
          'utf8',
        ),
      ).toBe(PROVE_COMMAND_TEXT);
    });

    it('is idempotent, and brings an old copy of ours up to date', async () => {
      await run('install');
      const again = await run('install', '--json');
      expect(JSON.parse(again.out).command.result).toBe('unchanged');

      await writeFile(userCommand(), `${PROVE_COMMAND_MARKER}\nold text\n`);
      const updated = await run('install', '--json');
      expect(JSON.parse(updated.out).command.result).toBe('written');
      expect(await readFile(userCommand(), 'utf8')).toBe(PROVE_COMMAND_TEXT);
    });

    it('never touches a file of the same name it did not write', async () => {
      await mkdir(join(home, '.claude', 'commands'), { recursive: true });
      await writeFile(userCommand(), 'my own prove command\n');
      const { code, out } = await run('install');
      expect(code).toBe(0);
      expect(out).toContain(
        `left ${userCommand()} alone, vouched did not write it`,
      );
      expect(await readFile(userCommand(), 'utf8')).toBe(
        'my own prove command\n',
      );

      const removed = await run('uninstall', '--json');
      expect(JSON.parse(removed.out).command.removed).toBe(false);
      expect(await readFile(userCommand(), 'utf8')).toBe(
        'my own prove command\n',
      );
    });

    it('uninstall removes ours', async () => {
      await run('install');
      await run('uninstall');
      await expect(stat(userCommand())).rejects.toThrow('ENOENT');
      expect((await run('uninstall')).out).toBe(
        `no vouched hooks in ${userFile()}\n`,
      );
    });
  });

  it('writes through a symlinked settings file', async () => {
    await mkdir(join(home, '.claude'));
    const real = join(root, 'dotfiles-settings.json');
    await writeFile(real, OTHER_TEXT);
    await symlink(real, userFile());
    await run('install');
    const hooks = (await readJson(real)).hooks as Record<string, unknown>;
    expect(hooks.SessionStart).toEqual([OUR_ENTRY]);
  });
});

describe('hookCommand', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vouched-bin-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses plain vouched when that name on PATH runs this script', async () => {
    const script = join(root, 'lib', 'node_modules', 'vouched', 'index.js');
    await mkdir(join(root, 'lib', 'node_modules', 'vouched'), {
      recursive: true,
    });
    await writeFile(script, '');
    await mkdir(join(root, 'bin'));
    await symlink(script, join(root, 'bin', 'vouched'));
    expect(hookCommand(join(root, 'bin', 'vouched'), join(root, 'bin'))).toBe(
      HOOK_COMMAND,
    );
  });

  it('uses npx otherwise', async () => {
    const script = join(
      root,
      '_npx',
      'abc',
      'node_modules',
      'vouched',
      'index.js',
    );
    await mkdir(join(root, '_npx', 'abc', 'node_modules', 'vouched'), {
      recursive: true,
    });
    await writeFile(script, '');
    await mkdir(join(root, 'bin'));
    expect(hookCommand(script, join(root, 'bin'))).toBe(
      `npx -y ${HOOK_COMMAND}`,
    );
    expect(hookCommand(undefined, '')).toBe(`npx -y ${HOOK_COMMAND}`);
  });
});
