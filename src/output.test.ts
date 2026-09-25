// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  promptStyled,
  stderrStyled,
  stdout,
  stdoutStyled,
  terminalSafe,
} from './output.js';
import { createStyle } from './style.js';

const ESC = String.fromCharCode(27);

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

describe('styled writers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(stream: NodeJS.WriteStream): { text: string } {
    const seen = { text: '' };
    vi.spyOn(stream, 'write').mockImplementation((chunk) => {
      seen.text += String(chunk);
      return true;
    });
    return seen;
  }

  it('keep the colour codes of a styled line when styling is on', () => {
    const s = createStyle({ isTTY: true }, { env: {} });
    const line = s.line`Signed in as ${s.bold('carelmeyer')}`;
    const out = capture(process.stdout);
    const err = capture(process.stderr);
    stdoutStyled(line);
    stderrStyled(line);
    promptStyled(line);
    const expected = `Signed in as ${ESC}[1mcarelmeyer${ESC}[22m`;
    expect(out.text).toBe(`${expected}\n`);
    expect(err.text).toBe(`${expected}\n${expected}`);
  });

  it('write untrusted text inside a styled line escaped, never raw', () => {
    const s = createStyle({ isTTY: true }, { env: {} });
    const login = `x${ESC}]52;c;aGk=\u0007‮`;
    const out = capture(process.stdout);
    stdoutStyled(s.line`Signed in as ${s.bold(login)} ${login}`);
    expect(out.text).toBe(
      `Signed in as ${ESC}[1mx\\u001b]52;c;aGk=\\u0007\\u202e${ESC}[22m x\\u001b]52;c;aGk=\\u0007\\u202e\n`,
    );
  });

  it('write no escape codes at all in plain mode', () => {
    const s = createStyle({ isTTY: false }, { env: {} });
    const out = capture(process.stdout);
    stdoutStyled(s.line`${s.tick()} Signed in as ${s.bold(`x${ESC}[31m`)}`);
    expect(out.text).toBe('✓ Signed in as x\\u001b[31m\n');
    expect(out.text).not.toContain(ESC);
  });

  it('leave the plain writers escaping a styled string passed as text', () => {
    const s = createStyle({ isTTY: true }, { env: {} });
    const out = capture(process.stdout);
    stdout(String(s.bold('x')));
    expect(out.text).toBe('\\u001b[1mx\\u001b[22m\n');
  });
});
