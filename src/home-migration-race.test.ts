// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type * as fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// rename is wrapped so a test can run a step between the last check and the
// rename, such as a second command started at the same moment making the new
// home first.
const race = vi.hoisted(() => ({
  before: null as null | (() => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      const step = race.before;
      race.before = null;
      if (step) await step();
      return real.rename(from, to);
    },
  };
});

const { HomeMigrationError, migrateHome } = await import('./home-migration.js');

describe('migrateHome when another command moves the home first', () => {
  let root: string;
  let from: string;
  let to: string;
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-race-'));
    from = join(root, '.vouched');
    to = join(root, '.sealkeeper');
    lines = [];
    await mkdir(from);
    await writeFile(join(from, 'key'), 'old key', { mode: 0o600 });
  });

  afterEach(async () => {
    race.before = null;
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the home the other command made and fails nothing', async () => {
    race.before = async () => {
      await mkdir(to);
      await writeFile(join(to, 'key'), 'other key', { mode: 0o600 });
    };

    expect(await migrateHome(from, to, log)).toBe(false);
    expect(lines).toEqual([]);
    expect(await readFile(join(to, 'key'), 'utf8')).toBe('other key');
    expect((await readdir(root)).sort()).toEqual(['.sealkeeper', '.vouched']);
    expect(await readFile(join(from, 'key'), 'utf8')).toBe('old key');
  });

  it('still fails when the rename fails for another reason', async () => {
    race.before = async () => {
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    };

    const error = await migrateHome(from, to, log).catch((e) => e);
    expect(error).toBeInstanceOf(HomeMigrationError);
    expect(lines).toEqual([]);
    expect(await readdir(root)).toEqual(['.vouched']);
  });
});
