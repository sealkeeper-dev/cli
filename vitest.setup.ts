// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { vi } from 'vitest';

// init and status warn on stderr when the Node running them lacks the
// October 2026 security fixes. Tests read stderr, so the Node of the machine
// running them must not change what they print. Every test sees a patched
// Node unless it passes a version itself, as src/node-version.test.ts does.
vi.mock('./src/node-version.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./src/node-version.js')>();
  return {
    ...real,
    warnUnpatchedNode: (version = '24.22.1') => real.warnUnpatchedNode(version),
  };
});
