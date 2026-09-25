// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BARE_INVOCATION,
  cli,
  detectInvocation,
  NPX_INVOCATION,
  printedInvocation,
  resetInvocation,
} from './invocation.js';

describe('printed invocation', () => {
  let root: string;

  // <root>/<...parts>/sealkeeper/dist/index.js, the way npm lays it out.
  async function script(...parts: string[]): Promise<string> {
    const dir = join(root, ...parts, 'sealkeeper', 'dist');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'index.js');
    await writeFile(file, '');
    return file;
  }

  // <root>/<...parts>/sealkeeper, a bin symlink to target.
  async function bin(target: string, ...parts: string[]): Promise<string> {
    const dir = join(root, ...parts);
    await mkdir(dir, { recursive: true });
    const link = join(dir, 'sealkeeper');
    await symlink(target, link);
    return link;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-invocation-'));
    resetInvocation();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetInvocation();
    await rm(root, { recursive: true, force: true });
  });

  it('is sealkeeper for a global bin on a PATH directory', async () => {
    const target = await script('lib', 'node_modules');
    const link = await bin(target, 'bin');
    const PATH = ['/usr/bin', join(root, 'bin')].join(delimiter);
    expect(detectInvocation(link, { PATH })).toBe(BARE_INVOCATION);
  });

  it('is npx sealkeeper for the same bin when its directory is not on PATH', async () => {
    const target = await script('lib', 'node_modules');
    const link = await bin(target, 'bin');
    expect(detectInvocation(link, { PATH: '/usr/bin' })).toBe(NPX_INVOCATION);
    expect(detectInvocation(link, {})).toBe(NPX_INVOCATION);
  });

  it('is npx sealkeeper for the npx cache bin, even though npx puts it on PATH', async () => {
    const target = await script('.npm', '_npx', 'abc123', 'node_modules');
    const link = await bin(
      target,
      '.npm',
      '_npx',
      'abc123',
      'node_modules',
      '.bin',
    );
    const PATH = [
      join(root, '.npm', '_npx', 'abc123', 'node_modules', '.bin'),
      '/usr/bin',
    ].join(delimiter);
    expect(detectInvocation(link, { PATH })).toBe(NPX_INVOCATION);
  });

  it('is npx sealkeeper for a PATH bin that resolves into the npx cache', async () => {
    const target = await script('.npm', '_npx', 'abc123', 'node_modules');
    const link = await bin(target, 'bin');
    const PATH = join(root, 'bin');
    expect(detectInvocation(link, { PATH })).toBe(NPX_INVOCATION);
  });

  it('is npx sealkeeper for a project bin that npm run puts on PATH', async () => {
    const target = await script('app', 'node_modules');
    const link = await bin(target, 'app', 'node_modules', '.bin');
    const PATH = join(root, 'app', 'node_modules', '.bin');
    expect(detectInvocation(link, { PATH })).toBe(NPX_INVOCATION);
  });

  it('is npx sealkeeper when node runs the script path directly', async () => {
    const target = await script('lib', 'node_modules');
    const PATH = join(root, 'lib', 'node_modules', 'sealkeeper', 'dist');
    expect(detectInvocation(target, { PATH })).toBe(NPX_INVOCATION);
    expect(detectInvocation(undefined, { PATH })).toBe(NPX_INVOCATION);
    expect(detectInvocation('', { PATH })).toBe(NPX_INVOCATION);
  });

  it('takes SEALKEEPER_INVOCATION over anything it finds', async () => {
    const target = await script('lib', 'node_modules');
    const link = await bin(target, 'bin');
    const PATH = join(root, 'bin');
    expect(
      detectInvocation(link, {
        PATH,
        SEALKEEPER_INVOCATION: ' pnpm dlx sealkeeper ',
      }),
    ).toBe('pnpm dlx sealkeeper');
    expect(detectInvocation(link, { PATH, SEALKEEPER_INVOCATION: '' })).toBe(
      BARE_INVOCATION,
    );
  });

  it('decides once per run and prefixes every command with it', () => {
    vi.stubEnv('SEALKEEPER_INVOCATION', 'sealkeeper');
    expect(cli('sync --yes')).toBe('sealkeeper sync --yes');
    vi.stubEnv('SEALKEEPER_INVOCATION', 'npx sealkeeper');
    expect(printedInvocation()).toBe('sealkeeper');
    resetInvocation();
    expect(cli('status')).toBe('npx sealkeeper status');
  });

  it('is the npx form under the tests, which do not run through a PATH bin', () => {
    expect(cli('sync')).toBe('npx sealkeeper sync');
  });
});
