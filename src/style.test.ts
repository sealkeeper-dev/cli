// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import {
  createStyle,
  indent,
  Styled,
  stripStyle,
  styleEnabled,
  visibleWidth,
} from './style.js';

const TTY = { isTTY: true, columns: 120 };
const PIPE = { isTTY: false };
const ESC = String.fromCharCode(27);
// The text of each styled line, as it would be written.
const texts = (lines: Styled[]) => lines.map((l) => l.text);

describe('style', () => {
  it('is off when the stream is not a terminal', () => {
    expect(styleEnabled(PIPE, { env: {} })).toBe(false);
    const s = createStyle(PIPE, { env: {} });
    expect(s.bold('x').text).toBe('x');
    expect(s.gold('x').text).toBe('x');
    expect(s.tick().text).toBe('✓');
  });

  it('is on in a terminal', () => {
    expect(styleEnabled(TTY, { env: {} })).toBe(true);
    expect(createStyle(TTY, { env: {} }).bold('x').text).toBe(
      `${ESC}[1mx${ESC}[22m`,
    );
  });

  it('is off with NO_COLOR', () => {
    expect(styleEnabled(TTY, { env: { NO_COLOR: '1' } })).toBe(false);
    expect(createStyle(TTY, { env: { NO_COLOR: '1' } }).cyan('x').text).toBe(
      'x',
    );
  });

  it('is off when TERM is dumb', () => {
    expect(styleEnabled(TTY, { env: { TERM: 'dumb' } })).toBe(false);
  });

  it('is off with --json, even with FORCE_COLOR', () => {
    expect(styleEnabled(TTY, { json: true, env: {} })).toBe(false);
    expect(styleEnabled(TTY, { json: true, env: { FORCE_COLOR: '1' } })).toBe(
      false,
    );
  });

  it('is on with FORCE_COLOR=1 without a terminal', () => {
    expect(styleEnabled(PIPE, { env: { FORCE_COLOR: '1' } })).toBe(true);
    expect(styleEnabled(PIPE, { env: { FORCE_COLOR: '0' } })).toBe(false);
    expect(
      createStyle(PIPE, { env: { FORCE_COLOR: '1' } }).gold('x').text,
    ).toContain(`${ESC}[38;2;212;160;23m`);
  });

  it('measures width without escape codes', () => {
    const s = createStyle(TTY, { env: {} });
    const styled = s.line`${s.gold('◉')} ${s.bold('SealKeeper')}`;
    expect(styled.text.length).toBeGreaterThan(12);
    expect(stripStyle(styled)).toBe('◉ SealKeeper');
    expect(visibleWidth(styled)).toBe(12);
  });

  it('draws a box as wide as the longest visible line', () => {
    const s = createStyle(TTY, { env: {} });
    const lines = s.box([s.bold('abc'), '', 'abcdef']);
    expect(lines.map(stripStyle)).toEqual([
      '╭────────╮',
      '│ abc    │',
      '│        │',
      '│ abcdef │',
      '╰────────╯',
    ]);
  });

  it('drops the border when the terminal is narrower than the box', () => {
    const s = createStyle({ isTTY: true, columns: 10 }, { env: {} });
    expect(texts(s.box(['abc', 'abcdef']))).toEqual(['abc', 'abcdef']);
    const wide = createStyle({ isTTY: true, columns: 12 }, { env: {} });
    expect(wide.box(['abc', 'abcdef'])).toHaveLength(4);
  });

  it('keeps the border when the terminal reports no width', () => {
    const zero = createStyle({ isTTY: true, columns: 0 }, { env: {} });
    expect(zero.box(['abc'])).toHaveLength(3);
  });

  it('prints the lines without a border when off', () => {
    expect(texts(createStyle(PIPE, { env: {} }).box(['a', '', 'b']))).toEqual([
      'a',
      '',
      'b',
    ]);
  });

  describe('untrusted text', () => {
    // A login or handle as a hostile server or config file could send it.
    const hostile = [
      ['an ESC colour sequence', `evil${ESC}[31mred`, 'evil\\u001b[31mred'],
      [
        'an OSC 52 clipboard write',
        `x${ESC}]52;c;aGk=\u0007y`,
        'x\\u001b]52;c;aGk=\\u0007y',
      ],
      ['a bidi override', 'abc‮def', 'abc\\u202edef'],
      ['a C1 CSI', 'a\u009b2Jb', 'a\\u009b2Jb'],
    ] as const;

    it.each(hostile)(
      'escapes %s inside a styled line and keeps the colour codes',
      (_, raw, escaped) => {
        const s = createStyle(TTY, { env: {} });
        const line = s.line`Signed in as ${s.bold(raw)} at ${s.cyan(raw)} ${raw}`;
        expect(line.text).toBe(
          `Signed in as ${ESC}[1m${escaped}${ESC}[22m at ${ESC}[38;2;90;170;210m${escaped}${ESC}[39m ${escaped}`,
        );
        // Every ESC left is one of ours, the start of a colour code.
        const escs = line.text.split(ESC).length - 1;
        const codes =
          line.text.match(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')) ?? [];
        expect(escs).toBe(codes.length);
        expect(line.text).not.toContain(raw);
      },
    );

    it.each(hostile)(
      'escapes %s in plain mode, which has no escape codes at all',
      (_, raw, escaped) => {
        const s = createStyle(PIPE, { env: {} });
        const lines = [
          s.line`Registered ${s.bold(raw)}`,
          indent(raw),
          ...s.box([raw, s.gold(raw)]),
        ];
        for (const l of lines) {
          expect(l.text).not.toContain(ESC);
          expect(l.text).not.toContain('‮');
          expect(l.text).toContain(escaped);
        }
      },
    );

    it('escapes raw text in a box and still draws the border', () => {
      const s = createStyle(TTY, { env: {} });
      const lines = s.box([`${ESC}]52;c;aGk=\u0007`]);
      expect(lines).toHaveLength(3);
      expect(stripStyle(lines[1] as Styled)).toBe(
        '│ \\u001b]52;c;aGk=\\u0007 │',
      );
    });

    it('treats a string holding our own codes as raw text', () => {
      const s = createStyle(TTY, { env: {} });
      const forged = String(s.bold('x'));
      expect(s.line`${forged}`.text).toBe('\\u001b[1mx\\u001b[22m');
    });

    it('can only be made by style.ts', () => {
      expect(() => new Styled(Symbol('styled'), `${ESC}[31m`)).toThrow(
        TypeError,
      );
    });
  });
});
