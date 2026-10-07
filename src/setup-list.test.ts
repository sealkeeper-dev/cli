// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { afterEach, describe, expect, it } from 'vitest';
import { stdoutStyled, trackOutput } from './output.js';
import {
  KEY_GENERATING,
  LiveList,
  SETUP_STEPS,
  stepLine,
  stepsFor,
  TODO,
} from './setup-list.js';
import { createStyle, stripStyle } from './style.js';

const ESC = '\u001b';
// Plain glyphs, no colour, so the written text reads as the terminal
// shows it.
const s = createStyle({ isTTY: false }, { env: {} });

function stream(columns = 80, rows = 30) {
  const writes: string[] = [];
  return {
    writes,
    columns,
    rows,
    write(text: string) {
      writes.push(text);
      return true;
    },
  };
}

afterEach(() => trackOutput(null));

describe('the steps', () => {
  it('lists six with Claude Code and four without', () => {
    expect(stepsFor(true).map((step) => step.key)).toEqual([
      'key',
      'sign-in',
      'hooks',
      'skill',
      'game',
      'routine',
    ]);
    expect(stepsFor(false).map((step) => step.key)).toEqual([
      'key',
      'sign-in',
      'game',
      'routine',
    ]);
  });

  it('draws a step to do, in progress and done', () => {
    const [key, , , , game] = SETUP_STEPS;
    if (key === undefined || game === undefined) throw new Error('steps');
    expect(stripStyle(stepLine(s, 1, key, TODO))).toBe('  ○ 1  Key');
    expect(stripStyle(stepLine(s, 5, game, TODO))).toBe(
      '  ○ 5  Game                      on / off',
    );
    expect(
      stripStyle(
        stepLine(s, 1, key, { status: 'doing', text: KEY_GENERATING }),
      ),
    ).toBe('  ◐ 1  Key                       generating…');
    expect(stripStyle(stepLine(s, 1, key, { status: 'doing' }))).toBe(
      '  ◐ 1  Key',
    );
    expect(
      stripStyle(
        stepLine(s, 1, key, { status: 'done', text: '~/.sealkeeper/key' }),
      ),
    ).toBe('  ● 1  Key                       ~/.sealkeeper/key');
  });
});

describe('LiveList', () => {
  it('draws the steps with the states it was given', () => {
    const list = new LiveList(stream(), s, stepsFor(false), {
      key: { status: 'done', text: '~/.sealkeeper/key' },
    });
    expect(list.lines().map(stripStyle)).toEqual([
      '  ● 1  Key                       ~/.sealkeeper/key',
      '  ○ 2  GitHub sign-in',
      '  ○ 3  Game                      on / off',
      '  ○ 4  Routine                   offered at the end',
    ]);
  });

  it('counts the rows under it and clears them after an answer', () => {
    const out = stream(80);
    const list = new LiveList(out, s, stepsFor(false), {});
    list.wrote('  Agent name [scout] ', false);
    list.answered('reviewer');
    // One row, the question and its answer, then nothing to the end of
    // the screen.
    expect(out.writes).toEqual([`\r${ESC}[1A${ESC}[0J`]);
    out.writes.length = 0;
    list.wrote('', true);
    list.wrote('  Which model?', true);
    list.wrote('  Install? [Y/n] ', false);
    list.answered('');
    expect(out.writes).toEqual([`\r${ESC}[3A${ESC}[0J`]);
  });

  it('counts a line that wraps as the rows it takes', () => {
    const out = stream(10);
    const list = new LiveList(out, s, stepsFor(false), {});
    list.wrote('a'.repeat(25), true);
    list.wrote('b'.repeat(10), true);
    list.wrote('c'.repeat(8), false);
    list.answered('yes');
    // 3 rows, 1 row and 2 rows, the answer pushed the question over.
    expect(out.writes).toEqual([`\r${ESC}[6A${ESC}[0J`]);
  });

  it('counts a line feed inside a written text as a row', () => {
    const out = stream(80);
    const list = new LiveList(out, s, stepsFor(false), {});
    // A question that starts with an empty line, as the version move's.
    list.wrote('\n  Move SealKeeper to 0.2.0? [y/N] ', false);
    list.answered('n');
    expect(out.writes).toEqual([`\r${ESC}[2A${ESC}[0J`]);
  });

  it('cuts a long result from the left so a step line never wraps', () => {
    const out = stream(82, 30);
    const list = new LiveList(out, s, stepsFor(false), {});
    const path = `/Users/alice/Documents/projects/${'x'.repeat(40)}/.claude/settings.local.json`;
    list.finish('key', path);
    const bare = (out.writes[0] ?? '').replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
      /\u001b(?:\[[0-9;]*[A-Za-z]|7|8)/g,
      '',
    );
    const line = bare.slice(bare.indexOf('    ● 1'));
    expect([...line].length).toBe(82);
    expect(line.endsWith('/.claude/settings.local.json')).toBe(true);
    expect(line).toContain('…');
    expect(
      list.lines().map(stripStyle)[0]?.endsWith('settings.local.json'),
    ).toBe(true);
  });

  it('counts the row an answer ends even when no question was written', () => {
    const out = stream();
    const list = new LiveList(out, s, stepsFor(false), {});
    list.answered('');
    expect(out.writes).toEqual([`\r${ESC}[1A${ESC}[0J`]);
  });

  it('redraws a step in place, above the empty line and the steps below it', () => {
    const out = stream(80, 30);
    const list = new LiveList(out, s, stepsFor(false), {});
    list.start('key', KEY_GENERATING);
    expect(out.writes).toEqual([
      `${ESC}7${ESC}[5A\r${ESC}[2K    ◐ 1  Key                       ${KEY_GENERATING}${ESC}8`,
    ]);
    out.writes.length = 0;
    list.wrote('  a line', true);
    list.finish('routine', '08:00');
    // The area is cleared first, then the last step is two rows up.
    expect(out.writes).toEqual([
      `\r${ESC}[1A${ESC}[0J`,
      `${ESC}7${ESC}[2A\r${ESC}[2K    ● 4  Routine                   08:00${ESC}8`,
    ]);
    expect(list.lines().map(stripStyle)).toEqual([
      `  ◐ 1  Key                       ${KEY_GENERATING}`,
      '  ○ 2  GitHub sign-in',
      '  ○ 3  Game                      on / off',
      '  ● 4  Routine                   08:00',
    ]);
  });

  it('skips a step this machine does not list', () => {
    const out = stream();
    const list = new LiveList(out, s, stepsFor(false), {});
    list.finish('hooks', '~/.claude/settings.json');
    expect(out.writes).toEqual([]);
  });

  it('skips a redraw that would reach above the screen', () => {
    const out = stream(80, 5);
    const list = new LiveList(out, s, stepsFor(false), {});
    // The first step is five rows up, on a screen of five rows.
    list.start('key');
    expect(out.writes).toEqual([]);
    // The last step is two rows up, which fits.
    list.finish('routine', '08:00');
    expect(out.writes).toHaveLength(1);
    expect(list.lines().map(stripStyle)[0]).toBe('  ◐ 1  Key');
  });

  it('counts what output.ts writes while it tracks, and stops at end', () => {
    const out = stream();
    const list = new LiveList(out, s, stepsFor(false), {});
    trackOutput(list);
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
      stdoutStyled(s.line`one`);
      stdoutStyled(s.line`two`);
    } finally {
      process.stdout.write = write;
    }
    list.end();
    expect(out.writes).toEqual([`\r${ESC}[2A${ESC}[0J`]);
    out.writes.length = 0;
    // Ended, so nothing is counted, cleared or redrawn, and the state
    // still moves for lines().
    list.wrote('late', true);
    list.answered('y');
    list.finish('game', 'off');
    expect(out.writes).toEqual([]);
    expect(list.lines().map(stripStyle)[2]).toBe(
      '  ● 3  Game                      off',
    );
  });
});
