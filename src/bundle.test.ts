// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Builds the CLI with the real tsup options into a temp directory and checks
// what ends up in the bundles, the bin (index.js), the importable API
// (lib.js), the Mastra adapter (mastra.js) and the OpenClaw plugin entry
// (openclaw.js). The lib and the adapters are then imported and used like
// an agent would, and the bin is run the way a user would run it.
//
// Every package is bundled, so the published package has no runtime
// dependencies. The build goes to a folder outside the package with no
// node_modules above it, so a bundle that still imports a package fails to
// load here as it would for a user.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isBuiltin } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLI_VERSION_HEADER } from '@sealkeeper/schema';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { options } from '../tsup.config.js';
import { paths } from './config.js';
import { createKey } from './identity.js';
import { copyPaths, writeCopy } from './routine-copy.js';
import { STATUS_TIMEOUT_MS } from './status-answer.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
) as {
  version: string;
  bin: Record<string, string>;
  exports: Record<string, { types: string; default: string }>;
  files: string[];
  openclaw: { extensions: string[] };
  devDependencies: Record<string, string>;
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

// Modules no bundle may import at runtime. @sealkeeper/schema is inlined,
// and its /db entry, Drizzle and the Postgres driver belong to the API.
const FORBIDDEN = [
  '@sealkeeper/schema',
  '@sealkeeper/schema/db',
  'drizzle-orm',
  'drizzle-kit',
  'pg',
  'postgres',
];

// Every module specifier a bundle imports or requires, in the forms esbuild
// writes, __require included. After bundling everything these must all be
// node builtins.
const SPECIFIER_PATTERNS = [
  /\bimport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\b(?:__)?require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function specifiersOf(code: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

// The packages inlined into a bundle and the folders they came from, read
// from the source path comments esbuild writes above each inlined module,
// such as a line holding only a comment with
// node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js
// in the workspace or node_modules/zod/v4/core/core.js after npm ci. Two
// folders for one package mean two copies of it in the bundle.
function bundledPackages(code: string): Map<string, Set<string>> {
  const packages = new Map<string, Set<string>>();
  for (const [, path] of code.matchAll(/^\/\/ (\S*node_modules\/\S+)$/gm)) {
    if (!path) continue;
    const at = path.lastIndexOf('node_modules/') + 'node_modules/'.length;
    const parts = path.slice(at).split('/');
    const name = parts[0]?.startsWith('@')
      ? `${parts[0]}/${parts[1]}`
      : (parts[0] ?? '');
    const folders = packages.get(name) ?? new Set<string>();
    folders.add(path.slice(0, at) + name);
    packages.set(name, folders);
  }
  return packages;
}

// The three packages that were runtime dependencies up to CLI 0.4.7.
const BUNDLED = ['@noble/ed25519', 'commander', 'zod'];

describe('bundle scanners', () => {
  const q = (m: string) => `"${m}"`;
  const FROM = 'from';
  const IMPORT = 'im' + 'port';
  const REQUIRE = 're' + 'quire';

  it('find every import form', () => {
    const code = [
      `${IMPORT} { z } ${FROM} ${q('zod')};`,
      `${IMPORT} * as fs ${FROM} ${q('fs')};`,
      `${'ex' + 'port'} { a } ${FROM} ${q('commander')};`,
      `${IMPORT} ${q('side')};`,
      `await ${IMPORT}(${q('dyn')});`,
      `var x = __${REQUIRE}(${q('@noble/ed25519')});`,
    ].join('\n');
    expect(specifiersOf(code)).toEqual([
      '@noble/ed25519',
      'commander',
      'dyn',
      'fs',
      'side',
      'zod',
    ]);
  });

  it('find inlined packages and duplicate copies', () => {
    const code = [
      '// ../../node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js',
      'var a = 1;',
      '// ../../node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/classic/schemas.js',
      '// node_modules/@noble/ed25519/index.js',
      '// node_modules/@sealkeeper/schema/node_modules/zod/v4/core/core.js',
      '// src/index.ts',
    ].join('\n');
    const found = bundledPackages(code);
    expect([...found.keys()].sort()).toEqual(['@noble/ed25519', 'zod']);
    expect(found.get('zod')?.size).toBe(2);
    expect(found.get('@noble/ed25519')?.size).toBe(1);
  });
});

describe('import guards', () => {
  // Built from parts so the isolation test, which reads this file's own
  // imports, does not take the samples for real ones.
  const q = (m: string, quote = '"') => `${quote}${m}${quote}`;
  const FROM = 'from';
  const IMPORT = 'im' + 'port';
  const REQUIRE = 're' + 'quire';

  it('match the real module names in every form', () => {
    expect(`${IMPORT} { x } ${FROM} ${q('@sealkeeper/schema/db')};`).toMatch(
      importOf('@sealkeeper/schema/db'),
    );
    expect(`${IMPORT}{x}${FROM}${q('@sealkeeper/schema', "'")}`).toMatch(
      importOf('@sealkeeper/schema'),
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
    expect(`${FROM} ${q('@sealkeeper/schemas')}`).not.toMatch(
      importOf('@sealkeeper/schema'),
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
    // Outside the package, with no node_modules to fall back on, so the
    // bundles load only when they are self-contained.
    outDir = await mkdtemp(join(tmpdir(), 'sealkeeper-bundle-test-'));
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

  it('inlines @sealkeeper/schema', () => {
    expect(bundle).toContain('EdDSA');
    expect(bundle).not.toMatch(importOf('@sealkeeper/schema'));
  });

  it('imports nothing but node builtins', () => {
    const bundles = { index: bundle, lib, mastra, openclaw };
    for (const [name, code] of Object.entries(bundles)) {
      const bare = specifiersOf(code).filter(
        (specifier) => !isBuiltin(specifier),
      );
      expect(bare, `${name}.js imports`).toEqual([]);
      for (const module of BUNDLED) {
        expect(code).not.toMatch(importOf(module));
      }
    }
  });

  it('inlines @noble/ed25519, commander and zod into the bin, once each', () => {
    const inlined = bundledPackages(bundle);
    for (const module of BUNDLED) {
      expect(pkg.devDependencies[module], module).toBeDefined();
      expect(inlined.get(module)?.size, module).toBe(1);
    }
    for (const code of [lib, mastra, openclaw]) {
      for (const [module, folders] of bundledPackages(code)) {
        expect(folders.size, module).toBe(1);
      }
    }
  });

  it('does not pull in the database layer', () => {
    for (const code of [bundle, lib, mastra, openclaw]) {
      expect(code).not.toContain('drizzle');
      for (const module of FORBIDDEN) {
        expect(code).not.toMatch(importOf(module));
      }
    }
  });

  // The template solver and generators stay on the server (VOU-640), so
  // the public package hands nobody a script that solves a template task.
  // solveTemplate is the solver's own name, the rule is the wording only a
  // generator writes into a spec, and kestrel is in a generator's word list.
  it('ships no template solver or generator', () => {
    for (const code of [bundle, lib, mastra, openclaw]) {
      expect(code).not.toContain('solveTemplate');
      expect(code).not.toContain('templateJsonSchema');
      expect(code).not.toContain(
        'Remove duplicate lines from the text in input.',
      );
      expect(code).not.toContain('kestrel');
    }
  });

  it('builds the entries the package points at', () => {
    expect(options.entry).toEqual({
      index: 'src/index.ts',
      lib: 'src/lib.ts',
      mastra: 'src/mastra.ts',
      openclaw: 'src/openclaw.ts',
    });
    expect(pkg.bin.sealkeeper).toBe('dist/index.js');
    expect(pkg.exports['.']).toEqual({
      types: './types/lib.d.ts',
      default: './dist/lib.js',
    });
    expect(pkg.exports['./mastra']).toEqual({
      types: './types/mastra.d.ts',
      default: './dist/mastra.js',
    });
    expect(pkg.exports['./openclaw']).toEqual({
      types: './types/openclaw.d.ts',
      default: './dist/openclaw.js',
    });
  });

  it('keeps the adapter free of Mastra, the CLI and @sealkeeper/schema imports', () => {
    expect(mastra).not.toMatch(/from ['"]@mastra\//);
    expect(mastra).not.toMatch(importOf('@sealkeeper/schema'));
    expect(mastra).not.toMatch(/from ['"]commander['"]/);
    expect(bundledPackages(mastra).has('commander')).toBe(false);
    // A routine run syncs at its end through the gate (VOU-627), and the
    // adapter itself starts no sync.
    expect(mastra).toContain('gatedSync');
    expect(mastra).not.toContain('kickBackgroundSync');
    expect(mastra).toMatch(/export\s*\{[^}]*\bwithSealKeeper\b/);
    expect(mastra).toMatch(/export\s*\{[^}]*\bsealKeeperSession\b/);
    expect(mastra).toMatch(/export\s*\{[^}]*\broutine\b/);
  });

  // routine(agent) carries the routine's loop (VOU-601), never the code
  // that installs a job, copies the CLI, installs Claude Code files or
  // starts a process. The OpenClaw plugin entry carries no routine at all.
  // The nudge carries the skill's text (VOU-602), so the modules that hold
  // that text are in the bundles, and only their install functions are
  // checked to be left out.
  it('keeps the install code and child processes out of the library bundles', () => {
    const INSTALL = [
      'commands/routine',
      'routine-scheduler',
      'routine-copy',
      'routine-agent',
      'routine-openclaw',
      'claude-code-install',
    ];
    const INSTALL_FUNCTIONS = [
      'installHooks',
      'uninstallHooks',
      'installCommands',
      'installManagedFile',
      'refreshCommands',
      'uninstallCommands',
      'installSkill',
      'uninstallSkill',
    ];
    const sources = (code: string) =>
      new Set([...code.matchAll(/^\/\/ src\/(\S+)\.ts$/gm)].map((m) => m[1]));
    for (const [name, code] of Object.entries({ lib, mastra, openclaw })) {
      const found = sources(code);
      for (const file of INSTALL) {
        expect(found.has(file), `${name}.js has ${file}`).toBe(false);
      }
      for (const fn of INSTALL_FUNCTIONS) {
        expect(code, `${name}.js has ${fn}`).not.toMatch(
          new RegExp(`function ${fn}\\d*\\(`),
        );
      }
      expect(specifiersOf(code), name).not.toContain('child_process');
      expect(specifiersOf(code), name).not.toContain('node:child_process');
    }
    expect(sources(mastra).has('routine-run')).toBe(true);
    expect(sources(openclaw).has('routine-run')).toBe(false);
  });

  // VOU-627. The adapter writes no event, only a routine run does.
  it('the built adapter passes a tool through and records nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sealkeeper-mastra-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    try {
      const mod = (await import(
        pathToFileURL(join(outDir, 'mastra.js')).href
      )) as typeof import('./mastra.js');
      const session = mod.sealKeeperSession('bundle-session');
      const tools = mod.withSealKeeper({
        echo: { id: 'echo', execute: async (x: number) => x + 1 },
      });
      expect(await tools.echo.execute(1)).toBe(2);
      await session.onStepFinish({
        usage: { promptTokens: 10, completionTokens: 5 },
        response: { modelId: 'gpt-4o', timestamp: new Date() },
      });
      await session.end();
      await expect(readdir(join(home, 'log'))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the OpenClaw entry free of OpenClaw, the CLI and @sealkeeper/schema imports', () => {
    expect(openclaw).not.toMatch(/from ['"]openclaw/);
    expect(openclaw).not.toMatch(importOf('@sealkeeper/schema'));
    expect(openclaw).not.toMatch(/from ['"]commander['"]/);
    expect(bundledPackages(openclaw).has('commander')).toBe(false);
    // It writes no event, so it starts no sync (VOU-627).
    expect(openclaw).not.toContain('kickBackgroundSync');
    expect(openclaw).toMatch(/export\s*\{[^}]*\bsealKeeperPlugin\b/);
    expect(openclaw).toMatch(/export\s*\{[^}]*\bdefault\b/);
  });

  it('ships an OpenClaw plugin package that matches the built entry', async () => {
    // What openclaw plugins install npm:sealkeeper reads: the manifest at
    // the package root and openclaw.extensions in package.json.
    const manifest = JSON.parse(
      readFileSync(join(packageDir, 'openclaw.plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(pkg.files).toContain('openclaw.plugin.json');
    expect(pkg.openclaw.extensions).toEqual([
      pkg.exports['./openclaw']?.default,
    ]);
    const mod = (await import(
      pathToFileURL(join(outDir, 'openclaw.js')).href
    )) as typeof import('./openclaw.js');
    expect(manifest).toMatchObject({
      id: mod.default.id,
      name: mod.default.name,
      description: mod.default.description,
      activation: { onStartup: true },
      configSchema: { type: 'object', additionalProperties: false },
    });
  });

  // VOU-627. The plugin writes no event, only a routine run does.
  it('the built OpenClaw entry records nothing, whatever OpenClaw fires', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sealkeeper-openclaw-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
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
      await expect(readdir(join(home, 'log'))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the lib free of the CLI and of @sealkeeper/schema imports', () => {
    expect(lib).not.toMatch(importOf('@sealkeeper/schema'));
    expect(lib).not.toMatch(/from ['"]commander['"]/);
    expect(bundledPackages(lib).has('commander')).toBe(false);
    expect(lib).toMatch(/export\s*\{[^}]*\bemit\b/);
  });

  it('the built lib appends a validated event to the log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sealkeeper-lib-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
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

  // VOU-453. The daily job runs a copy of this bin, so the copy says which
  // CLI sends each request, with the version the build injected.
  it("the routine's copy of the bin sends its version to the API", async () => {
    const home = await mkdtemp(join(tmpdir(), 'sealkeeper-bin-'));
    const versions: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      const version = req.headers[CLI_VERSION_HEADER.toLowerCase()];
      versions.push(Array.isArray(version) ? version.join() : version);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const { port } = server.address() as AddressInfo;
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify({
          agentId: 'A'.repeat(43),
          operatorLogin: 'alice',
          name: 'scout',
          version: '1.0.0',
          registeredAt: '2026-09-23T08:00:00Z',
        }),
      );
      // status signs its read, so it needs the key.
      await createKey({}, paths(home));
      await writeCopy(join(outDir, 'index.js'), paths(home), pkg.version);
      const code = await new Promise<number | null>((done) => {
        const child = spawn(
          process.execPath,
          [copyPaths(paths(home)).script, 'status'],
          {
            env: {
              ...process.env,
              SEALKEEPER_HOME: home,
              SEALKEEPER_API_URL: `http://127.0.0.1:${port}`,
            },
            stdio: 'ignore',
          },
        );
        child.on('close', done);
      });
      expect(code).toBe(0);
      expect(versions.length).toBeGreaterThan(0);
      expect(new Set(versions)).toEqual(new Set([pkg.version]));
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  // A fetch that times out can leave a connect attempt open inside undici
  // for about ten seconds when the network drops packets. The bin must not
  // wait for it. 10.255.255.1 is not routed, so the connect never answers.
  it('status exits soon after its timeout when the network drops packets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sealkeeper-bin-'));
    try {
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify({
          agentId: 'A'.repeat(43),
          operatorLogin: 'alice',
          name: 'scout',
          version: '1.0.0',
          registeredAt: '2026-09-23T08:00:00Z',
        }),
      );
      await createKey({}, paths(home));
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
              SEALKEEPER_HOME: home,
              SEALKEEPER_API_URL: 'http://10.255.255.1',
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
      // Not a terminal, so the agent's form, with only the local part.
      expect(JSON.parse(out).source.from).toBe('none');
      expect(ms).toBeLessThan(STATUS_TIMEOUT_MS + 1_500);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
