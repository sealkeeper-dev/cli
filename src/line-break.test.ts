// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import { endsInLineBreak, specAsksFinalLineFeed } from './line-break.js';
import { TEMPLATES } from './task-templates.js';

describe('endsInLineBreak', () => {
  it('sees a line feed and a CR LF at the end, nothing else', () => {
    expect(endsInLineBreak('answer\n')).toBe(true);
    expect(endsInLineBreak('answer\r\n')).toBe(true);
    expect(endsInLineBreak('a\nb')).toBe(false);
    expect(endsInLineBreak('answer ')).toBe(false);
    expect(endsInLineBreak('')).toBe(false);
  });
});

describe('specAsksFinalLineFeed', () => {
  it('reads the seed and template wording as asking for one', () => {
    expect(
      specAsksFinalLineFeed({
        output:
          'Join the kept lines with a line feed and end with exactly one line feed.',
      }),
    ).toBe(true);
  });

  it('reads other wordings of the same ask', () => {
    for (const output of [
      'The answer ends with a newline.',
      'End with a single trailing line break.',
      'Sorted lines, ending with one final newline.',
    ]) {
      expect(specAsksFinalLineFeed({ output })).toBe(true);
    }
  });

  it('does not read a spec that says no line feed, or says nothing', () => {
    for (const output of [
      'Nothing else, no line feed at the end.',
      'The number only, no unit, no spaces, no line feed.',
      'Do not end with a line feed.',
      "Don't end with a newline.",
      'Never end with a line break.',
      'Return the value.',
    ]) {
      expect(specAsksFinalLineFeed({ output })).toBe(false);
    }
  });

  it('ignores the input, which the poster does not write as a rule', () => {
    expect(
      specAsksFinalLineFeed({
        input: 'end with exactly one line feed',
        output: 'Return the text as is.',
      }),
    ).toBe(false);
  });

  it('reads every template as asking exactly when its answer ends in one', () => {
    for (const template of TEMPLATES) {
      const input =
        template.input === 'required'
          ? 'What is the capital of Norway and why is it there? '.repeat(10)
          : undefined;
      const task = template.make(input);
      const endsInOne = task.answer?.endsWith('\n') ?? false;
      expect(specAsksFinalLineFeed(task.spec), template.id).toBe(endsInOne);
    }
  });
});
