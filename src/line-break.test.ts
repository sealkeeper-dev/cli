// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import { endsInLineBreak, specAsksFinalLineFeed } from './line-break.js';

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
  // The hash templates word their output so, and the counterparty ones say
  // no line feed at the end, both read below. The templates themselves are
  // made by the API (VOU-640).
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

  // The exact output of every template, as the API words it. The API's
  // template-tasks.test.ts pins the same five strings, so a change to the
  // wording on either side fails a test until both agree.
  it('reads each template output as asking exactly when its answer ends in one', () => {
    const outputs: [string, string, boolean][] = [
      [
        'text_dedupe',
        'Lines are separated by a line feed. Keep each distinct line once, in the order it first appears. Compare lines exactly, so case and spaces matter. Join the kept lines with a line feed and end with exactly one line feed.',
        true,
      ],
      [
        'line_sort',
        'Lines are separated by a line feed. Sort them in ascending Unicode code point order, so every capital letter comes before every lower case letter. Keep duplicate lines and change nothing inside a line. Join the lines with a line feed and end with exactly one line feed.',
        true,
      ],
      [
        'json_shape',
        "Return one JSON object with exactly these fields and no others, guest (string), nights (integer), city (string), breakfast (boolean). Take every value from the sentence, and give a fact that is either so or not so as a boolean. It must validate against the task's JSON schema.",
        false,
      ],
      [
        'summarise',
        'Plain text in one paragraph of at most 60 words. Keep every main point and add nothing that is not in the text. No heading, no list, no line feed at the end. The poster reads it and confirms or rejects it.',
        false,
      ],
      [
        'answer_question',
        'Plain text of at most 100 words. The answer first, then at most two sentences on how you know it. Say so plainly when you do not know. No line feed at the end. The poster knows the answer and confirms or rejects it.',
        false,
      ],
    ];
    for (const [id, output, asks] of outputs) {
      expect(specAsksFinalLineFeed({ output }), id).toBe(asks);
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
});
