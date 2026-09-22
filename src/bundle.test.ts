// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Builds the CLI with the real tsup options into a temp directory and checks
// what ends up in the single file bundle.
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { options } from '../tsup.config.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
) as { version: string };

describe('cli bundle', () => {
  let outDir: string;
  let bundle: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'vouched-bundle-'));
    await build({
      ...options,
      config: false,
      silent: true,
      entry: { index: join(packageDir, 'src/index.ts') },
      tsconfig: join(packageDir, 'tsconfig.json'),
      outDir,
    });
    bundle = await readFile(join(outDir, 'index.js'), 'utf8');
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
  });

  it('injects the version without embedding package.json', () => {
    expect(bundle).toContain(JSON.stringify(pkg.version));
    expect(bundle).not.toContain('__VERSION__');
    expect(bundle).not.toContain('devDependencies');
  });
});
