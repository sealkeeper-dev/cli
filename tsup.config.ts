// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  splitting: false,
  clean: true,
  noExternal: ['@vouched/schema'],
  banner: { js: '#!/usr/bin/env node' },
});
