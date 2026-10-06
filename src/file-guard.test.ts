// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANSWERS_DIR,
  type FileRules,
  readGuardedFile,
  SECRET_FILE_REFUSAL,
} from './file-guard.js';

// open is wrapped so a test can tell whether a file was opened at all.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe('readGuardedFile (VOU-229)', () => {
  let dir: string;
  let cwd: string;
  let userHome: string;
  let rules: FileRules;

  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'sealkeeper-guard-')),
    );
    vi.stubEnv('SEALKEEPER_HOME', join(dir, 'sealkeeper-home'));
    vi.stubEnv('SEALKEEPER_ROOT', join(dir, 'sealkeeper-root'));
    await fs.mkdir(join(dir, 'sealkeeper-home'));
    cwd = join(dir, 'work');
    userHome = join(dir, 'home');
    await fs.mkdir(join(cwd, ANSWERS_DIR), { recursive: true });
    await fs.mkdir(userHome);
    rules = {
      maxBytes: 100,
      refusing: 'refusing to submit',
      what: 'the answer file',
      cwd,
      userHome,
    };
    vi.mocked(fs.open).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(file: string, text: string): Promise<string> {
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  }

  it('refuses a symlink out of the answers folder, and an answers folder that is a symlink', async () => {
    const secret = await write(join(dir, 'secret.txt'), 'secret');
    const link = join(cwd, ANSWERS_DIR, 'a.txt');
    await fs.symlink(secret, link);
    // The file is outside the current directory.
    expect(await readGuardedFile(link, rules)).toHaveProperty('error');

    const other = join(dir, 'other');
    await write(join(other, 'x.txt'), 'x');
    await fs.rm(join(cwd, ANSWERS_DIR), { recursive: true });
    await fs.symlink(other, join(cwd, ANSWERS_DIR));
    expect(
      await readGuardedFile(join(cwd, ANSWERS_DIR, 'x.txt'), rules),
    ).toHaveProperty('error');
  });

  it('never reads a hidden file or folder at the top of the home, whatever the flags', async () => {
    const token = await write(
      join(userHome, '.config', 'gh', 'hosts.yml'),
      't',
    );
    // A name off the secret list, so the hidden folder rule is the one that
    // refuses it.
    const history = await write(join(userHome, '.zsh_history'), 'n');
    for (const file of [token, history]) {
      for (const at of [{ cwd }, { cwd: userHome }]) {
        const read = await readGuardedFile(file, {
          ...rules,
          ...at,
          allowOutsideCwd: true,
        });
        expect(read).toHaveProperty('error');
        expect((read as { error: string }).error).toContain(
          'a hidden file or folder in your home',
        );
      }
    }
    // A hidden folder deeper down is an ordinary folder.
    const deeper = await write(join(userHome, 'code', '.notes', 'a.txt'), 'a');
    expect(await readGuardedFile(deeper, { ...rules, cwd: userHome })).toEqual({
      text: 'a',
    });
  });

  it('reads a project of its own below a hidden home folder (VOU-241)', async () => {
    const project = join(userHome, '.config', 'tool', 'project');
    const own = await write(join(project, 'answer.txt'), 'own');
    await fs.mkdir(join(project, '.git'), { recursive: true });
    const sibling = await write(
      join(userHome, '.config', 'gh', 'hosts.yml'),
      't',
    );
    const at = { ...rules, cwd: project };
    expect(await readGuardedFile(own, at)).toEqual({ text: 'own' });
    // The rest of the hidden folder stays closed, also with the flag.
    const refused = await readGuardedFile(sibling, {
      ...at,
      allowOutsideCwd: true,
    });
    expect((refused as { error: string }).error).toContain(
      'a hidden file or folder in your home',
    );
    expect((refused as { error: string }).error).toContain(
      `A file in ${join(project, ANSWERS_DIR)} is always read`,
    );
  });

  it('reads a project below a hidden folder marked by a package.json in a parent', async () => {
    const root = join(userHome, '.local', 'src', 'app');
    await write(join(root, 'package.json'), '{}');
    const sub = join(root, 'packages', 'cli');
    const own = await write(join(sub, 'answer.txt'), 'own');
    expect(await readGuardedFile(own, { ...rules, cwd: sub })).toEqual({
      text: 'own',
    });
    // A .git file, as a worktree or a submodule has, marks a project too.
    const worktree = join(userHome, '.cache', 'wt');
    await write(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    const inTree = await write(join(worktree, 'a.txt'), 'wt');
    expect(await readGuardedFile(inTree, { ...rules, cwd: worktree })).toEqual({
      text: 'wt',
    });
  });

  it('refuses the files of a credential folder below a hidden home folder, run from inside it', async () => {
    const gh = join(userHome, '.config', 'gh');
    const hosts = await write(join(gh, 'hosts.yml'), 'oauth_token: t');
    const read = await readGuardedFile(hosts, { ...rules, cwd: gh });
    expect((read as { error: string }).error).toContain(
      'a hidden file or folder in your home',
    );
    expect((read as { error: string }).error).toContain(
      'one with a .git or a package.json',
    );
    // A marker in the hidden folder itself opens nothing below it.
    await write(join(userHome, '.config', 'package.json'), '{}');
    expect(await readGuardedFile(hosts, { ...rules, cwd: gh })).toHaveProperty(
      'error',
    );
  });

  it('keeps a hidden home folder closed when it is the current directory itself', async () => {
    const ssh = join(userHome, '.ssh');
    const key = await write(join(ssh, 'known_hosts'), 'k');
    const read = await readGuardedFile(key, { ...rules, cwd: ssh });
    expect((read as { error: string }).error).toContain(
      'a hidden file or folder in your home',
    );
  });

  it('reads the answers folder of a current directory that is the home', async () => {
    const answer = await write(join(userHome, ANSWERS_DIR, 'a.txt'), 'a');
    expect(await readGuardedFile(answer, { ...rules, cwd: userHome })).toEqual({
      text: 'a',
    });
  });

  it('refuses a file outside the current directory unless allowed', async () => {
    const file = await write(join(dir, 'elsewhere', 'a.txt'), 'a');
    const refused = await readGuardedFile(file, rules);
    expect((refused as { error: string }).error).toContain(
      `it is outside the current directory ${cwd}`,
    );
    expect(
      await readGuardedFile(file, { ...rules, allowOutsideCwd: true }),
    ).toEqual({ text: 'a' });
  });

  it('refuses the SealKeeper home in every mode', async () => {
    const key = await write(join(dir, 'sealkeeper-home', 'answer.txt'), 'k');
    for (const allowOutsideCwd of [true, false]) {
      const read = await readGuardedFile(key, { ...rules, allowOutsideCwd });
      expect((read as { error: string }).error).toContain(
        "which holds this agent's private key",
      );
    }
  });

  it("refuses any agent's home under the SealKeeper root in every mode", async () => {
    const root = join(dir, 'sealkeeper-root');
    const other = await write(join(root, 'agents', 'billing', 'key'), 'k');
    const map = await write(join(root, 'agents.json'), '{}');
    // A symlink from the current directory into the root is judged by
    // where it points.
    const link = join(cwd, ANSWERS_DIR, 'a.txt');
    await fs.symlink(other, link);
    for (const file of [other, map, link]) {
      for (const allowOutsideCwd of [true, false]) {
        const read = await readGuardedFile(file, { ...rules, allowOutsideCwd });
        expect((read as { error: string }).error).toContain(
          `it is inside ${root}, which holds the private keys of the agents on this machine`,
        );
      }
    }
    // Also when this agent's own home is a named one under the root.
    vi.stubEnv('SEALKEEPER_HOME', join(root, 'agents', 'app'));
    const own = await write(join(root, 'agents', 'app', 'key'), 'k');
    const read = await readGuardedFile(own, {
      ...rules,
      allowOutsideCwd: true,
    });
    expect((read as { error: string }).error).toContain(
      "which holds this agent's private key",
    );
    expect(await readGuardedFile(other, rules)).toHaveProperty('error');
  });

  it('refuses a file over the cap without opening it', async () => {
    const big = join(cwd, 'big.txt');
    await fs.writeFile(big, '');
    await fs.truncate(big, 101);
    expect(await readGuardedFile(big, rules)).toEqual({
      error: `refusing to submit ${big}, it is 101 bytes and the most allowed is 100. Nothing was read`,
    });
    expect(fs.open).not.toHaveBeenCalled();
    const exact = await write(join(cwd, 'exact.txt'), 'x'.repeat(100));
    expect(await readGuardedFile(exact, rules)).toEqual({
      text: 'x'.repeat(100),
    });
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a folder, a device and a fifo without opening them',
    async () => {
      const { execFileSync } = await import('node:child_process');
      const fifo = join(cwd, 'fifo');
      execFileSync('mkfifo', [fifo]);
      for (const file of [join(cwd, ANSWERS_DIR), '/dev/zero', fifo]) {
        const read = await readGuardedFile(file, {
          ...rules,
          allowOutsideCwd: true,
        });
        expect(read).toEqual({
          error: `refusing to submit ${file}, it is not a regular file`,
        });
      }
      expect(fs.open).not.toHaveBeenCalled();
    },
  );

  // VOU-649. A spec can ask an agent with tools for --file .env, or --text
  // @.env on post, and the file is inside the current directory.
  it('refuses a file whose name marks secrets, anywhere and in every mode, without opening it', async () => {
    const names = [
      '.env',
      '.env.local',
      '.ENV.production',
      '.envrc',
      'server.pem',
      'tls.KEY',
      'credentials',
      'credentials.json',
      'id_rsa',
      'id_ed25519.pub',
      'secrets.yaml',
      '.npmrc',
      '.netrc',
      '.pgpass',
      '.git-credentials',
      'cert.p12',
    ];
    for (const name of names) {
      for (const file of [join(cwd, name), join(cwd, ANSWERS_DIR, name)]) {
        await write(file, 'SECRET=1');
        for (const allowOutsideCwd of [true, false]) {
          const read = await readGuardedFile(file, {
            ...rules,
            allowOutsideCwd,
          });
          expect(read, file).toEqual({
            error: `refusing to submit ${file}, ${SECRET_FILE_REFUSAL}`,
          });
        }
      }
    }
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('judges a symlink by its own name and by the name of what it points to', async () => {
    const env = await write(join(cwd, '.env'), 'SECRET=1');
    const answer = join(cwd, ANSWERS_DIR, 'a.txt');
    await fs.symlink(env, answer);
    expect(await readGuardedFile(answer, rules)).toHaveProperty('error');
    const plain = await write(join(cwd, 'plain.txt'), 'p');
    const named = join(cwd, 'deploy.key');
    await fs.symlink(plain, named);
    expect(await readGuardedFile(named, rules)).toHaveProperty('error');
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('reads files whose names only look close', async () => {
    for (const name of [
      'environment.md',
      'my.env.txt',
      'keys.txt',
      'monkey.ts',
      'pem.md',
      'answer.txt',
    ]) {
      const file = await write(join(cwd, ANSWERS_DIR, name), 'ok');
      expect(await readGuardedFile(file, rules), name).toEqual({ text: 'ok' });
    }
  });

  it('says when the file cannot be read', async () => {
    const missing = join(cwd, 'missing.txt');
    const read = await readGuardedFile(missing, rules);
    expect((read as { error: string }).error).toContain(
      `could not read the answer file ${missing}, ENOENT`,
    );
  });
});
