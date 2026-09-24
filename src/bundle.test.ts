// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Builds the CLI with the real tsup options into a temp directory and checks
// what ends up in the bundles, the bin (index.js), the importable API
// (lib.js), the Mastra adapter (mastra.js) and the OpenClaw plugin entry
// (openclaw.js). The lib and the adapters are then imported and used like
// an agent would, and the bin is run the way a user would run it.
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

// An import or require of the module, or of any path under it, in any of
// the forms esbuild writes, a from clause, a dynamic import, a require call
// and a bare side effect import.
function importOf(module: string): RegExp {
  const name = module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*)['"]${name}(?:/[^'"]*)?['"]`,
  );
}

// Modules no bundle may import at runtime. @vouched-dev/schema is inlined,
// and its /db entry, Drizzle and the Postgres driver belong to the API.
const FORBIDDEN = [
  '@vouched-dev/schema',
  '@vouched-dev/schema/db',
  'drizzle-orm',
  'drizzle-kit',
  'pg',
  'postgres',
];

describe('import guards', () => {
  // Built from parts so the isolation test, which reads this file's own
  // imports, does not take the samples for real ones.
  const q = (m: string, quote = '"') => `${quote}${m}${quote}`;
  const FROM = 'from';
  const IMPORT = 'im' + 'port';
  const REQUIRE = 're' + 'quire';

  it('match the real module names in every form', () => {
    expect(`${IMPORT} { x } ${FROM} ${q('@vouched-dev/schema/db')};`).toMatch(
      importOf('@vouched-dev/schema/db'),
    );
    expect(`${IMPORT}{x}${FROM}${q('@vouched-dev/schema', "'")}`).toMatch(
      importOf('@vouched-dev/schema'),
    );
    expect(`await ${IMPORT}(${q('drizzle-orm/pg-core')})`).toMatch(
      importOf('drizzle-orm'),
    );
    expect(`var pg = ${REQUIRE}(${q('pg')});`).toMatch(importOf('pg'));
    expect(`${IMPORT} ${q('pg')};`).toMatch(importOf('pg'));
  });

  it('do not match other names', () => {
    expect(`${IMPORT} { Pool } ${FROM} ${q('pg-pool')};`).not.toMatch(
      importOf('pg'),
    );
    expect(`${FROM} ${q('@vouched/schema')}`).not.toMatch(
      importOf('@vouched-dev/schema'),
    );
  });
});

describe('cli bundle', () => {
  let outDir: string;
  let bundle: string;
  let lib: string;
  let mastra: string;
  let openclaw: string;

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
        mastra: join(packageDir, 'src/mastra.ts'),
        openclaw: join(packageDir, 'src/openclaw.ts'),
      },
      tsconfig: join(packageDir, 'tsconfig.json'),
      outDir,
    });
    bundle = await readFile(join(outDir, 'index.js'), 'utf8');
    lib = await readFile(join(outDir, 'lib.js'), 'utf8');
    mastra = await readFile(join(outDir, 'mastra.js'), 'utf8');
    openclaw = await readFile(join(outDir, 'openclaw.js'), 'utf8');
  }, 60_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('is one executable file', () => {
    expect(bundle.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('inlines @vouched-dev/schema', () => {
    expect(bundle).toContain('EdDSA');
    expect(bundle).not.toMatch(importOf('@vouched-dev/schema'));
  });

  it('does not pull in the database layer', () => {
    for (const code of [bundle, lib, mastra, openclaw]) {
      expect(code).not.toContain('drizzle');
      for (const module of FORBIDDEN) {
        expect(code).not.toMatch(importOf(module));
      }
    }
  });

  it('builds the entries the package points at', () => {
    expect(options.entry).toEqual({
      index: 'src/index.ts',
      lib: 'src/lib.ts',
      mastra: 'src/mastra.ts',
      openclaw: 'src/openclaw.ts',
    });
    expect(pkg.bin.vouched).toBe('dist/index.js');
    expect(pkg.exports['.']).toEqual({
      types: './types/lib.d.ts',
      import: './dist/lib.js',
    });
    expect(pkg.exports['./mastra']).toEqual({
      types: './types/mastra.d.ts',
      import: './dist/mastra.js',
    });
    expect(pkg.exports['./openclaw']).toEqual({
      types: './types/openclaw.d.ts',
      import: './dist/openclaw.js',
    });
  });

  it('keeps the adapter free of Mastra, the CLI and @vouched-dev/schema imports', () => {
    expect(mastra).not.toMatch(/from ['"]@mastra\//);
    expect(mastra).not.toMatch(importOf('@vouched-dev/schema'));
    expect(mastra).not.toMatch(/from ['"]commander['"]/);
    expect(mastra).toContain('kickBackgroundSync');
    expect(mastra).toMatch(/export\s*\{[^}]*\bwithVouched\b/);
    expect(mastra).toMatch(/export\s*\{[^}]*\bvouchedSession\b/);
  });

  it('the built adapter wraps a tool and records a session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vouched-mastra-'));
    vi.stubEnv('VOUCHED_HOME', home);
    try {
      const mod = (await import(
        pathToFileURL(join(outDir, 'mastra.js')).href
      )) as typeof import('./mastra.js');
      const session = mod.vouchedSession('bundle-session');
      const tools = mod.withVouched({
        echo: { id: 'echo', execute: async (x: number) => x + 1 },
      });
      expect(await tools.echo.execute(1)).toBe(2);
      await session.onStepFinish({
        usage: { promptTokens: 10, completionTokens: 5 },
        response: { modelId: 'gpt-4o', timestamp: new Date() },
      });
      await session.end();

      const [file] = await readdir(join(home, 'log'));
      const types = (await readFile(join(home, 'log', file ?? ''), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(types.sort()).toEqual([
        'session.end',
        'session.start',
        'tool.call',
        'usage',
      ]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the OpenClaw entry free of OpenClaw, the CLI and @vouched-dev/schema imports', () => {
    expect(openclaw).not.toMatch(/from ['"]openclaw/);
    expect(openclaw).not.toMatch(importOf('@vouched-dev/schema'));
    expect(openclaw).not.toMatch(/from ['"]commander['"]/);
    // It syncs only through the throttled background sync.
    expect(openclaw).toContain('kickBackgroundSync');
    expect(openclaw).toMatch(/export\s*\{[^}]*\bvouchedPlugin\b/);
    expect(openclaw).toMatch(/export\s*\{[^}]*\bdefault\b/);
  });

  it('the built OpenClaw entry records a session, a tool call and usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vouched-openclaw-'));
    vi.stubEnv('VOUCHED_HOME', home);
    try {
      const mod = (await import(
        pathToFileURL(join(outDir, 'openclaw.js')).href
      )) as typeof import('./openclaw.js');
      const handlers = new Map<string, (event: unknown) => unknown>();
      mod.default.register({
        on: (name: string, handler: (event: never, ctx: never) => unknown) => {
          handlers.set(name, handler as (event: unknown) => unknown);
        },
      });
      const fire = (name: string, event: unknown) =>
        handlers.get(name)?.(event);
      await fire('session_start', { sessionId: 'bundle-session' });
      await fire('after_tool_call', { toolName: 'exec', durationMs: 5 });
      await fire('model_call_ended', { runId: 'r1', durationMs: 90 });
      await fire('llm_output', {
        runId: 'r1',
        model: 'gpt-5.4',
        usage: { input: 10, output: 5 },
      });
      await fire('session_end', { sessionId: 'bundle-session' });

      const [file] = await readdir(join(home, 'log'));
      const types = (await readFile(join(home, 'log', file ?? ''), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(types).toEqual([
        'session.start',
        'tool.call',
        'usage',
        'session.end',
      ]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the lib free of the CLI and of @vouched-dev/schema imports', () => {
    expect(lib).not.toMatch(importOf('@vouched-dev/schema'));
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
