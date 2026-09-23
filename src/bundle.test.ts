// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Builds the CLI with the real tsup options into a temp directory and checks
// what ends up in the two bundles, the bin (index.js) and the importable API
// (lib.js). The lib is then imported and used like an adapter would.
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { options } from '../tsup.config.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
) as {
  version: string;
  bin: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
};

describe('cli bundle', () => {
  let outDir: string;
  let bundle: string;
  let lib: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'vouched-bundle-'));
    await build({
      ...options,
      config: false,
      silent: true,
      entry: {
        index: join(packageDir, 'src/index.ts'),
        lib: join(packageDir, 'src/lib.ts'),
      },
      tsconfig: join(packageDir, 'tsconfig.json'),
      outDir,
    });
    bundle = await readFile(join(outDir, 'index.js'), 'utf8');
    lib = await readFile(join(outDir, 'lib.js'), 'utf8');
  }, 60_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('is one executable file', () => {
    expect(bundle.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('inlines @vouched/schema', () => {
    expect(bundle).toContain('EdDSA');
    expect(bundle).not.toMatch(/from ['"]@vouched\/schema/);
  });

  it('does not pull in the database layer', () => {
    expect(bundle).not.toContain('drizzle');
    expect(lib).not.toContain('drizzle');
  });

  it('builds the entries the package points at', () => {
    expect(options.entry).toEqual({
      index: 'src/index.ts',
      lib: 'src/lib.ts',
    });
    expect(pkg.bin.vouched).toBe('./dist/index.js');
    expect(pkg.exports['.']).toEqual({
      types: './types/lib.d.ts',
      import: './dist/lib.js',
    });
  });

  it('keeps the lib free of the CLI and of @vouched/schema imports', () => {
    expect(lib).not.toMatch(/from ['"]@vouched\/schema/);
    expect(lib).not.toMatch(/from ['"]commander['"]/);
    expect(lib).toMatch(/export\s*\{[^}]*\bemit\b/);
  });

  it('the built lib appends a validated event to the log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vouched-lib-'));
    vi.stubEnv('VOUCHED_HOME', home);
    try {
      const mod = (await import(
        pathToFileURL(join(outDir, 'lib.js')).href
      )) as typeof import('./lib.js');
      const event = await mod.emit({
        type: 'session.start',
        payload: { session_id: 's1' },
        version: '2.0.0',
      });
      expect(event).toMatchObject({ type: 'session.start', version: '2.0.0' });

      const [file] = await readdir(join(home, 'log'));
      const line = await readFile(join(home, 'log', file ?? ''), 'utf8');
      expect(JSON.parse(line)).toEqual({ v: 1, ...event });

      await expect(
        mod.emit({
          type: 'session.start',
          payload: { session_id: 's1', prompt: 'x' },
        } as never),
      ).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('injects the version without embedding package.json', () => {
    expect(bundle).toContain(JSON.stringify(pkg.version));
    expect(bundle).not.toContain('__VERSION__');
    expect(bundle).not.toContain('devDependencies');
  });

  it('replaces the GitHub client id placeholder at build time', () => {
    expect(bundle).not.toContain('__GITHUB_CLIENT_ID__');
  });
});
