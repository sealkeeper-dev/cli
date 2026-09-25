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
export function isYes(answer: string | null): boolean {
  return /^y(es)?$/i.test(answer?.trim() ?? '');
}
