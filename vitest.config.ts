// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirrors the tsup define so tests see the same __VERSION__ as the bundle.
// The client id is always empty here so tests never depend on the build env.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __GITHUB_CLIENT_ID__: JSON.stringify(''),
  },
});
