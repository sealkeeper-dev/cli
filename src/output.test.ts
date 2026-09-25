// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { describe, expect, it, vi } from 'vitest';
import { quietly, stderr, terminalSafe } from './output.js';

describe('terminalSafe', () => {
  it('escapes terminal controls and bidi overrides, keeping tab and line feed', () => {
    expect(terminalSafe('a\tb\nc')).toBe('a\tb\nc');
    expect(terminalSafe('\u001b]52;c;aGk=\u0007')).toBe(
      '\\u001b]52;c;aGk=\\u0007',
    );
    expect(terminalSafe('x\u009by\r\u007f')).toBe('x\\u009by\\u000d\\u007f');
    expect(terminalSafe('abc‮def')).toBe('abc\\u202edef');
  });

  it('keeps JSON valid and meaning the same', () => {
    const value = { message: 'hi\u009b‮\u0007' };
    const json = terminalSafe(JSON.stringify(value));
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe('quietly', () => {
  it('drops stderr inside the scope, including work it starts, and only there', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      let later: Promise<void> = Promise.resolve();
      quietly(() => {
        stderr('now');
        later = new Promise<void>((resolve) => setTimeout(resolve, 1)).then(
          () => stderr('later'),
        );
      });
      await later;
      expect(write).not.toHaveBeenCalled();
      stderr('outside');
      expect(write).toHaveBeenCalledWith('outside\n');
    } finally {
      write.mockRestore();
    }
  });
});
