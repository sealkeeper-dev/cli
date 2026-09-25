// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirrors the tsup define so tests see the same __VERSION__ as the bundle.
// The client id is always empty here so tests never depend on the build env.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

// HOME points at an empty temp directory, so no test ever reads or migrates
// the real ~/.vouched or ~/.sealkeeper of the machine it runs on. Tests that
// need a home stub SEALKEEPER_HOME or HOME themselves.
const home = mkdtempSync(join(tmpdir(), 'sealkeeper-test-home-'));

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __GITHUB_CLIENT_ID__: JSON.stringify(''),
  },
  test: {
    // SEALKEEPER_INVOCATION is cleared so printed commands take the npx form
    // whatever the shell running the tests has set.
    env: { HOME: home, SEALKEEPER_INVOCATION: '' },
  },
});
