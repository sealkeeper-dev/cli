// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createInterface } from 'node:readline';

// Where a yes or no answer comes from. isTTY says whether a person could be
// typing. readLine resolves with one line, or null when the input closes
// first. Tests pass their own.
export type Input = {
  isTTY: boolean;
  readLine(): Promise<string | null>;
};

export function streamInput(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
): Input {
  return {
    isTTY: stream.isTTY === true,
    readLine: () =>
      new Promise((resolve) => {
        const rl = createInterface({ input: stream, terminal: false });
        let done = false;
        rl.once('line', (line) => {
          done = true;
          rl.close();
          resolve(line);
        });
        rl.once('close', () => {
          if (!done) resolve(null);
        });
      }),
  };
}

// y or yes in any case. Anything else, including an empty line, is no.
// Escape sequences, such as arrow keys, are taken out first.
export function isYes(answer: string | null): boolean {
  return /^y(es)?$/i.test(cleanAnswer(answer ?? ''));
}

// Escape sequences a terminal sends for keys that are not text, such as the
// arrow keys. CSI is ESC [ with parameters and one final byte, SS3 is ESC O
// and one byte, and any other ESC takes the byte after it. 0x9b is the one
// byte CSI.
const ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001bO[\s\S]?|\u001b[\s\S]?|\u009b[0-?]*[ -/]*[@-~]/g;
// The same sequences in the caret form a terminal echoes them in, ^[[B for
// the down arrow, for an answer pasted back from the screen.
const CARET_SEQUENCE = /\^\[(?:\[[0-?]*[ -/]*[@-~]|O.)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

// The answer with escape sequences and other control characters taken out
// and the spaces around it trimmed. Arrow keys pressed before y leave y.
export function cleanAnswer(answer: string): string {
  return answer
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CARET_SEQUENCE, '')
    .replace(CONTROL, '')
    .trim();
}

// y or yes, n or no, in any case. An empty answer is the default. A closed
// input is no. Anything else is unclear, so the question can be asked again.
export function readYesNo(
  answer: string | null,
  defaultAnswer: 'yes' | 'no',
): 'yes' | 'no' | 'unclear' {
  if (answer === null) return 'no';
  const clean = cleanAnswer(answer);
  if (clean === '') return defaultAnswer;
  if (/^y(es)?$/i.test(clean)) return 'yes';
  if (/^no?$/i.test(clean)) return 'no';
  return 'unclear';
}
