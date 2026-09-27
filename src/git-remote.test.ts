// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoName, repoNameOf } from './git-remote.js';

describe('repoNameOf', () => {
  it.each([
    ['git@github.com:sealkeeper-dev/sealkeeper.git', 'sealkeeper'],
    ['https://github.com/sealkeeper-dev/sealkeeper', 'sealkeeper'],
    ['https://github.com/sealkeeper-dev/sealkeeper.git/', 'sealkeeper'],
    ['ssh://git@example.com:22/team/My_Agent.GIT', 'My_Agent'],
    ['/srv/git/scout.git', 'scout'],
    ['C:\\repos\\scout', 'scout'],
    ['https://example.com/a/scout?ref=main', 'scout'],
  ])('%s is %s', (url, name) => {
    expect(repoNameOf(url)).toBe(name);
  });

  it.each(['', '/', 'https://example.com/.git'])('%s has no name', (url) => {
    expect(repoNameOf(url)).toBeNull();
  });
});

describe('repoName', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sealkeeper-git-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the origin remote of a repository', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:alice/research-bot.git'],
      { cwd: dir },
    );
    expect(await repoName(dir)).toBe('research-bot');
  });

  it('is null in a repository without an origin', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(await repoName(dir)).toBeNull();
  });

  it('is null in a directory that does not exist', async () => {
    expect(await repoName(join(dir, 'missing'))).toBeNull();
  });
});
