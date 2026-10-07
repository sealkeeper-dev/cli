// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import {
  asciiGlyphs,
  createStyle,
  indent,
  Styled,
  stripStyle,
  styleEnabled,
  visibleWidth,
  WORDMARK_WIDTH,
} from './style.js';

const TTY = { isTTY: true, columns: 120 };
const PIPE = { isTTY: false };
const ESC = String.fromCharCode(27);

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

  it('draws the wordmark, SEAL in green and KEEPER plain, each shadow dim', () => {
    const s = createStyle(TTY, { env: {} });
    const rows = s.wordmark();
    expect(rows).toHaveLength(6);
    const plain = (rows ?? []).map(stripStyle);
    expect(plain[0]).toBe(
      '███████╗███████╗ █████╗ ██╗     ██╗  ██╗███████╗███████╗██████╗ ███████╗██████╗',
    );
    expect(plain[5]).toBe(
      '╚══════╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝',
    );
    expect(Math.max(...plain.map((row) => [...row].length))).toBe(
      WORDMARK_WIDTH,
    );
    const green = `${ESC}[38;2;80;180;110m`;
    const first = (rows ?? [])[0]?.text ?? '';
    // SEAL, a letter then its shadow, dim inside the green.
    expect(
      first.startsWith(`${green}███████${ESC}[39m${ESC}[2m${green}╗`),
    ).toBe(true);
    // KEEPER carries no colour, only the dim shadow.
    const keeper = first.slice(first.indexOf('     ') + 5);
    expect(keeper).not.toContain(green);
    expect(keeper).toContain(`${ESC}[2m╗`);
  });

  it('draws no wordmark when the terminal is narrower than it and its indent', () => {
    const narrow = createStyle(
      { isTTY: true, columns: WORDMARK_WIDTH + 1 },
      { env: {} },
    );
    expect(narrow.wordmark()).toBeNull();
    const wide = createStyle(
      { isTTY: true, columns: WORDMARK_WIDTH + 2 },
      { env: {} },
    );
    expect(wide.wordmark()).toHaveLength(6);
  });

  it('draws the wordmark when the terminal reports no width', () => {
    const zero = createStyle({ isTTY: true, columns: 0 }, { env: {} });
    expect(zero.wordmark()).toHaveLength(6);
    const none = createStyle({ isTTY: true }, { env: {} });
    expect(none.wordmark()).toHaveLength(6);
  });

  it('draws no wordmark when off', () => {
    expect(createStyle(PIPE, { env: {} }).wordmark()).toBeNull();
    expect(createStyle(TTY, { env: { NO_COLOR: '1' } }).wordmark()).toBeNull();
  });

  it('draws the step glyphs and the dot', () => {
    const s = createStyle(TTY, { env: {} });
    expect(stripStyle(s.done())).toBe('●');
    expect(stripStyle(s.todo())).toBe('○');
    expect(s.dot().text).toBe('·');
    expect(s.done().text).toContain(`${ESC}[38;2;80;180;110m`);
    expect(s.todo().text).toContain(`${ESC}[38;2;140;140;135m`);
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
          s.gold(raw),
        ];
        for (const l of lines) {
          expect(l.text).not.toContain(ESC);
          expect(l.text).not.toContain('‮');
          expect(l.text).toContain(escaped);
        }
      },
    );

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

  describe('glyphs (VOU-321)', () => {
    // A code page reader that counts how often it is asked.
    const reader = (page: number | null) => {
      const calls = { n: 0 };
      return {
        calls,
        codePage: () => {
          calls.n += 1;
          return page;
        },
      };
    };

    it('are ASCII on win32 unless the code page is 65001', () => {
      expect(asciiGlyphs({ platform: 'win32', codePage: () => 437 })).toBe(
        true,
      );
      expect(asciiGlyphs({ platform: 'win32', codePage: () => 850 })).toBe(
        true,
      );
      expect(asciiGlyphs({ platform: 'win32', codePage: () => null })).toBe(
        true,
      );
      expect(asciiGlyphs({ platform: 'win32', codePage: () => 65001 })).toBe(
        false,
      );
    });

    it('never read the code page off win32', () => {
      for (const platform of ['darwin', 'linux'] as const) {
        const { calls, codePage } = reader(437);
        expect(asciiGlyphs({ platform, codePage })).toBe(false);
        const s = createStyle(TTY, { env: {}, platform, codePage });
        expect(stripStyle(s.tick())).toBe('✓');
        expect(calls.n).toBe(0);
      }
    });

    it('draw the glyphs in ASCII and no wordmark on code page 437, styled or not', () => {
      const { calls, codePage } = reader(437);
      const s = createStyle(TTY, { env: {}, platform: 'win32', codePage });
      s.bold('x');
      // Nothing drawn yet, so nothing read.
      expect(calls.n).toBe(0);
      expect(stripStyle(s.mark())).toBe('*');
      expect(stripStyle(s.tick())).toBe('+');
      expect(stripStyle(s.done())).toBe('+');
      expect(stripStyle(s.todo())).toBe('o');
      expect(s.dot().text).toBe('-');
      expect(s.wordmark()).toBeNull();
      // Read once for the style, however many glyphs it draws.
      expect(calls.n).toBe(1);
      const plain = createStyle(PIPE, { env: {}, platform: 'win32', codePage });
      expect(plain.tick().text).toBe('+');
      expect(plain.mark().text).toBe('*');
      expect(plain.todo().text).toBe('o');
    });

    it('stay UTF-8 on win32 with code page 65001', () => {
      const s = createStyle(TTY, {
        env: {},
        platform: 'win32',
        codePage: () => 65001,
      });
      expect(stripStyle(s.mark())).toBe('◉');
      expect(stripStyle(s.tick())).toBe('✓');
      expect(stripStyle(s.todo())).toBe('○');
      expect(s.wordmark()).toHaveLength(6);
    });
  });
});
