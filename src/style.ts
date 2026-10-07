// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { execFileSync } from 'node:child_process';
import { terminalSafe } from './output.js';

// Terminal styling for the human output, ANSI escape codes only. Styling is
// on when the stream is a terminal, NO_COLOR is unset, TERM is not dumb and
// --json is not in use. FORCE_COLOR turns it on regardless, which is how
// tests see the styled form. Off, every function hands its text back
// unchanged and wordmark() draws nothing, so the plain form is the same
// words. A command decides once per run and stream, with createStyle.
//
// The glyphs, the mark, the tick, the step glyphs, the dot and the spinner
// frames of routine-watch.ts, are ASCII in a Windows console whose code
// page is not UTF-8, see asciiGlyphs. The wordmark has no ASCII form.
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

export type GlyphOptions = {
  platform?: NodeJS.Platform;
  // The output code page of the console, null when it cannot be read.
  codePage?: () => number | null;
};

export type StyleOptions = GlyphOptions & {
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
  // The gold SealKeeper mark in front of a heading.
  mark(): Styled;
  // A green check mark.
  tick(): Styled;
  // A step done, a filled green circle, one in progress, a green half
  // circle, and one still to do, an empty grey circle.
  done(): Styled;
  doing(): Styled;
  todo(): Styled;
  // The middle dot between two parts of a line, as in a title and a count.
  dot(): Styled;
  // A tagged template. The literal text and every value are escaped unless
  // the value is already Styled, as in s.line`Signed in as ${s.bold(login)}`.
  line(strings: TemplateStringsArray, ...parts: Part[]): Styled;
  // The SealKeeper wordmark in block letters, SEAL in green and KEEPER in
  // the text colour, each with its shadow dimmed, one Styled per row. null
  // when styling is off, when the glyphs are ASCII or when the stream is
  // narrower than the wordmark and its two space indent, and the caller
  // draws the name in one line instead.
  wordmark(): Styled[] | null;
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

// The code page that is UTF-8.
const UTF8_CODE_PAGE = 65001;

// The one glyph check. The CLI writes UTF-8, and a Windows console decodes
// it with its code page, so on win32 every glyph is ASCII unless that code
// page is 65001. Any other platform never reads the code page.
export function asciiGlyphs({
  platform = process.platform,
  codePage = consoleCodePage,
}: GlyphOptions = {}): boolean {
  return platform === 'win32' && codePage() !== UTF8_CODE_PAGE;
}

// Short, so a slow or hung chcp never holds up a command.
const CHCP_TIMEOUT_MS = 1_000;

let readCodePage: number | null | undefined;

// The output code page of the console, from chcp, read once per process
// and only when a glyph is drawn on win32. chcp prints it as the last
// number of one line in the language of Windows, as in the English line
// `Active code page: 437`. null when chcp fails, which then reads as not
// UTF-8. stdin is inherited so chcp shares this process's console and reads
// its code page. With no stdio inherited, Node starts it with
// CREATE_NO_WINDOW in a console of its own, which holds the system default
// and not a code page the operator set for the session. windowsHide then
// only hides a console chcp makes when this process has none.
function consoleCodePage(): number | null {
  if (readCodePage === undefined) {
    try {
      const out = execFileSync('chcp.com', {
        encoding: 'latin1',
        timeout: CHCP_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['inherit', 'pipe', 'ignore'],
      });
      const found = /(\d+)\D*$/.exec(out)?.[1];
      readCodePage = found === undefined ? null : Number(found);
    } catch {
      readCodePage = null;
    }
  }
  return readCodePage;
}

// Text as the terminal shows it, without escape codes.
export function stripStyle(text: string | Styled): string {
  return String(text).replace(ESCAPE_CODE, '');
}

// Columns the text takes, counted in code points, so the mark and the
// wordmark glyphs count as one each.
export function visibleWidth(text: string | Styled): number {
  return [...stripStyle(text)].length;
}

// The indent every line of the init output carries.
export const INDENT = '  ';

// The wordmark, 80 columns of block letters with a shadow, from the init
// banner design. SEAL takes the first SEAL_COLUMNS of every row and KEEPER
// the rest. A full block is a letter and every other glyph its shadow.
const WORDMARK = [
  '███████╗███████╗ █████╗ ██╗     ██╗  ██╗███████╗███████╗██████╗ ███████╗██████╗ ',
  '██╔════╝██╔════╝██╔══██╗██║     ██║ ██╔╝██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗',
  '███████╗█████╗  ███████║██║     █████╔╝ █████╗  █████╗  ██████╔╝█████╗  ██████╔╝',
  '╚════██║██╔══╝  ██╔══██║██║     ██╔═██╗ ██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══██╗',
  '███████║███████╗██║  ██║███████╗██║  ██╗███████╗███████╗██║     ███████╗██║  ██║',
  '╚══════╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝',
];
const SEAL_COLUMNS = 32;
const BLOCK = '█';
// Runs of letter and runs of shadow, in order.
const RUNS = new RegExp(`${BLOCK}+|[^${BLOCK}]+`, 'g');
export const WORDMARK_WIDTH = Math.max(...WORDMARK.map(visibleWidth));

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
  // Decided on the first glyph, so a command that draws none never reads
  // the code page.
  let ascii: boolean | undefined;
  const plain = (): boolean => {
    ascii ??= asciiGlyphs(options);
    return ascii;
  };
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

  const dim = wrap('2', '22');
  const grey = rgb(140, 140, 135);

  // The letters of a word in one colour and its shadow in another, the
  // rows of the wordmark are source text, so nothing in them needs
  // escaping.
  function letters(
    text: string,
    letter: (run: string) => Styled,
    shadow: (run: string) => Styled,
  ): string {
    return (text.match(RUNS) ?? [])
      .map((run) => (run.startsWith(BLOCK) ? letter(run) : shadow(run)).text)
      .join('');
  }

  function wordmark(): Styled[] | null {
    if (!enabled || plain()) return null;
    // A terminal that reports no size, or 0 as some ptys do, gets it.
    const columns = stream.columns;
    if (columns && WORDMARK_WIDTH + INDENT.length > columns) return null;
    return WORDMARK.map((row) => {
      const glyphs = [...row];
      const seal = glyphs.slice(0, SEAL_COLUMNS).join('');
      const keeper = glyphs.slice(SEAL_COLUMNS).join('').trimEnd();
      return styled(
        letters(seal, green, (run) => dim(green(run))) +
          letters(keeper, styled, dim),
      );
    });
  }

  return {
    enabled,
    bold: wrap('1', '22'),
    dim,
    gold,
    green,
    cyan: rgb(90, 170, 210),
    grey,
    mark: () => gold(plain() ? '*' : '◉'),
    tick: () => green(plain() ? '+' : '✓'),
    done: () => green(plain() ? '+' : '●'),
    doing: () => green(plain() ? '*' : '◐'),
    todo: () => grey(plain() ? 'o' : '○'),
    dot: () => styled(plain() ? '-' : '·'),
    line,
    wordmark,
  };
}
