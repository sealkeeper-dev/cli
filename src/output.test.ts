// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import { terminalSafe } from './output.js';

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
