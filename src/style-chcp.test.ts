// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import * as childProcess from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { asciiGlyphs } from './style.js';

// execFileSync is replaced, so no test runs chcp or depends on the machine.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => 'Active code page: 65001\r\n'),
  };
});

describe('the console code page (VOU-321)', () => {
  it("reads the code page of this process's console, once", () => {
    expect(asciiGlyphs({ platform: 'win32' })).toBe(false);
    expect(asciiGlyphs({ platform: 'win32' })).toBe(false);
    const calls = vi.mocked(childProcess.execFileSync).mock.calls;
    expect(calls).toHaveLength(1);
    const [file, options] = calls[0] as unknown as [
      string,
      childProcess.ExecFileSyncOptions,
    ];
    expect(file).toBe('chcp.com');
    // An inherited stdin keeps chcp on this console, not a hidden new one.
    expect(options.stdio).toEqual(['inherit', 'pipe', 'ignore']);
  });
});
