// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWERS_DIR, type FileRules, readGuardedFile } from './file-guard.js';

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
      routine: false,
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

  it('in a routine run reads a file in the answers folder and nothing else', async () => {
    const inside = await write(join(cwd, ANSWERS_DIR, 'a.txt'), 'answer');
    const beside = await write(join(cwd, 'b.txt'), 'answer');
    const routine = { ...rules, routine: true, allowOutsideCwd: true };
    expect(await readGuardedFile(inside, routine)).toEqual({ text: 'answer' });
    expect(await readGuardedFile(`${ANSWERS_DIR}/a.txt`, routine)).toEqual({
      text: 'answer',
    });
    const refused = await readGuardedFile(beside, routine);
    expect(refused).toEqual({
      error: `refusing to submit ${beside}, a routine run reads the answer file only from ${join(cwd, ANSWERS_DIR)}, write it there`,
    });
  });

  it('refuses a symlink out of the answers folder, and an answers folder that is a symlink', async () => {
    const secret = await write(join(dir, 'secret.txt'), 'secret');
    const link = join(cwd, ANSWERS_DIR, 'a.txt');
    await fs.symlink(secret, link);
    const routine = { ...rules, routine: true };
    expect(await readGuardedFile(link, routine)).toHaveProperty('error');
    // Outside a routine too, since the file is outside the current directory.
    expect(await readGuardedFile(link, rules)).toHaveProperty('error');

    const other = join(dir, 'other');
    await write(join(other, 'x.txt'), 'x');
    await fs.rm(join(cwd, ANSWERS_DIR), { recursive: true });
    await fs.symlink(other, join(cwd, ANSWERS_DIR));
    expect(
      await readGuardedFile(join(cwd, ANSWERS_DIR, 'x.txt'), routine),
    ).toHaveProperty('error');
  });

  it('never reads a hidden file or folder at the top of the home, whatever the flags', async () => {
    const token = await write(
      join(userHome, '.config', 'gh', 'hosts.yml'),
      't',
    );
    const netrc = await write(join(userHome, '.netrc'), 'n');
    for (const file of [token, netrc]) {
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
    for (const routine of [true, false]) {
      const read = await readGuardedFile(key, {
        ...rules,
        routine,
        allowOutsideCwd: true,
      });
      expect((read as { error: string }).error).toContain(
        "which holds this agent's private key",
      );
    }
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

  it('says when the file cannot be read', async () => {
    const missing = join(cwd, 'missing.txt');
    const read = await readGuardedFile(missing, rules);
    expect((read as { error: string }).error).toContain(
      `could not read the answer file ${missing}, ENOENT`,
    );
  });
});
