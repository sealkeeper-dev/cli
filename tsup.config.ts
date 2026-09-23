// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

// The version is read here at build time and injected as __VERSION__, so the
// bundle never embeds package.json and its devDependencies. The GitHub OAuth
// client id comes from GITHUB_CLIENT_ID at build time and defaults to empty,
// in which case the CLI needs VOUCHED_GITHUB_CLIENT_ID at runtime.
//
// Two entries. index is the bin. lib is the importable API ("." in the
// package exports). Without splitting each is one self-contained file. The
// banner lands on both, which is harmless for lib since Node skips a leading
// #! line in a module. Types for lib are in types/lib.d.ts.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export const options: Options = {
  entry: { index: 'src/index.ts', lib: 'src/lib.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  splitting: false,
  clean: true,
  noExternal: ['@vouched/schema'],
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __GITHUB_CLIENT_ID__: JSON.stringify(process.env.GITHUB_CLIENT_ID ?? ''),
  },
};

export default defineConfig(options);
