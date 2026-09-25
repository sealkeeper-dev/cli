// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { terminalSafe } from './output.js';

// Terminal styling for the human output, ANSI escape codes only. Styling is
// on when the stream is a terminal, NO_COLOR is unset, TERM is not dumb and
// --json is not in use. FORCE_COLOR turns it on regardless, which is how
// tests see the styled form. Off, every function hands its text back
// unchanged and box() drops the border, so the plain form is the same words.
// A command decides once per run and stream, with createStyle.
//
// The escape codes are only safe because nothing else can put an ESC in a
// styled line. Every plain string a style function takes, whether it came
// from the source or from the API, GitHub, the config file or another agent,
// goes through terminalSafe first. Only a Styled value, which only this
// module makes, passes through as it is. stdoutStyled and stderrStyled in
// output.ts take nothing else and write it without escaping it again.

const ESC = String.fromCharCode(27);
const ESCAPE_CODE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

// Proves a Styled value was made here. Not exported.
const MINT = Symbol('styled');

// A line or part of a line built only by this module, from escaped text and
// escape codes of its own.
export class Styled {
  readonly #text: string;

  constructor(mint: symbol, text: string) {
    if (mint !== MINT) throw new TypeError('Styled is made only by style.ts');
    this.#text = text;
  }

  get text(): string {
    return this.#text;
  }

  // In a plain template string the codes stay in, and stdout or stderr then
  // shows them as \u001b escapes, which is visible but never unsafe.
  toString(): string {
    return this.#text;
  }
}

// What a style function takes. A string is escaped, a Styled value kept.
export type Part = string | number | Styled;

function styled(text: string): Styled {
  return new Styled(MINT, text);
}

function safe(part: Part): string {
  return part instanceof Styled ? part.text : terminalSafe(String(part));
}

export type StyleStream = { isTTY?: boolean; columns?: number };

export type StyleOptions = {
  json?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type Style = {
  enabled: boolean;
  bold(text: Part): Styled;
  dim(text: Part): Styled;
  gold(text: Part): Styled;
  green(text: Part): Styled;
  cyan(text: Part): Styled;
  grey(text: Part): Styled;
  // A green check mark.
  tick(): Styled;
  // A tagged template. The literal text and every value are escaped unless
  // the value is already Styled, as in s.line`Signed in as ${s.bold(login)}`.
  line(strings: TemplateStringsArray, ...parts: Part[]): Styled;
  // The lines inside a rounded gold border, ready to print. Off, or when the
  // stream is narrower than the box and its two space indent, the lines
  // come back as they are.
  box(lines: Part[]): Styled[];
};

// The one enabled check.
export function styleEnabled(
  stream: StyleStream,
  { json = false, env = process.env }: StyleOptions = {},
): boolean {
  if (json) return false;
  const force = env.FORCE_COLOR?.trim();
  if (force && force !== '0' && force !== 'false') return true;
  if (env.NO_COLOR) return false;
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

// Text as the terminal shows it, without escape codes.
export function stripStyle(text: string | Styled): string {
  return String(text).replace(ESCAPE_CODE, '');
}

// Columns the text takes, counted in code points, so the mark and the box
// characters count as one each.
export function visibleWidth(text: string | Styled): number {
  return [...stripStyle(text)].length;
}

// The indent every line of the init output carries.
export const INDENT = '  ';

// A line two spaces in, or an empty line as it is.
export function indent(line: Part = ''): Styled {
  const text = safe(line);
  return styled(text === '' ? '' : `${INDENT}${text}`);
}

export function createStyle(
  stream: StyleStream,
  options: StyleOptions = {},
): Style {
  const enabled = styleEnabled(stream, options);
  const wrap =
    (open: string, close: string) =>
    (part: Part): Styled => {
      const text = safe(part);
      return styled(
        enabled && text.length > 0
          ? `${ESC}[${open}m${text}${ESC}[${close}m`
          : text,
      );
    };
  const rgb = (r: number, g: number, b: number) =>
    wrap(`38;2;${r};${g};${b}`, '39');
  const gold = rgb(212, 160, 23);
  const green = rgb(80, 180, 110);

  function line(strings: TemplateStringsArray, ...parts: Part[]): Styled {
    let text = '';
    strings.forEach((literal, i) => {
      text += terminalSafe(literal);
      if (i < parts.length) text += safe(parts[i] as Part);
    });
    return styled(text);
  }

  function box(parts: Part[]): Styled[] {
    const lines = parts.map((part) => styled(safe(part)));
    if (!enabled) return lines;
    const inner = Math.max(0, ...lines.map(visibleWidth));
    const width = inner + 4;
    // A terminal that reports no size, or 0 as some ptys do, gets the box.
    const columns = stream.columns;
    if (columns && width + INDENT.length > columns) return lines;
    const pad = (l: Styled) =>
      styled(l.text + ' '.repeat(inner - visibleWidth(l)));
    return [
      gold(`╭${'─'.repeat(width - 2)}╮`),
      ...lines.map((l) => line`${gold('│')} ${pad(l)} ${gold('│')}`),
      gold(`╰${'─'.repeat(width - 2)}╯`),
    ];
  }

  return {
    enabled,
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    gold,
    green,
    cyan: rgb(90, 170, 210),
    grey: rgb(140, 140, 135),
    tick: () => green('✓'),
    line,
    box,
  };
}
