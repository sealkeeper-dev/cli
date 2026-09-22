// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from './program.js';

describe('vouched cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is named vouched and has a version', () => {
    const program = createProgram();
    expect(program.name()).toBe('vouched');
    expect(program.version()).toBe('0.0.1');
  });

  it('whoami prints not initialised', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['whoami'], { from: 'user' });
    expect(log).toHaveBeenCalledWith('not initialised');
  });
});
