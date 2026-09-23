// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Builds the CLI with the real tsup options into a temp directory and checks
// what ends up in the two bundles, the bin (index.js) and the importable API
// (lib.js). The lib is then imported and used like an adapter would, and the
// bin is run the way a user would run it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    // Inside the package so the bundle finds commander and zod in
    // node_modules when it is run.
    outDir = await mkdtemp(join(packageDir, '.bundle-test-'));
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

  // A fetch that times out can leave a connect attempt open inside undici
  // for about ten seconds when the network drops packets. The bin must not
  // wait for it. 10.255.255.1 is not routed, so the connect never answers.
  it('status exits soon after the score timeout when the network drops packets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vouched-bin-'));
    try {
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify({
          agentId: 'A'.repeat(43),
          operatorLogin: 'carelmeyer',
          name: 'scout',
          version: '1.0.0',
          registeredAt: '2026-09-23T08:00:00Z',
        }),
      );
      const start = performance.now();
      const { code, out } = await new Promise<{
        code: number | null;
        out: string;
      }>((done) => {
        const child = spawn(
          process.execPath,
          [join(outDir, 'index.js'), 'status'],
          {
            env: {
              ...process.env,
              VOUCHED_HOME: home,
              VOUCHED_API_URL: 'http://10.255.255.1',
            },
          },
        );
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += String(chunk);
        });
        child.on('close', (code) => done({ code, out }));
      });
      const ms = performance.now() - start;
      expect(code).toBe(0);
      expect(out).toContain('A'.repeat(43));
      expect(ms).toBeLessThan(3_500);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
