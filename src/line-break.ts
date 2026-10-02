// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

// What submit checks about how a hash answer ends (VOU-181). It
// imports nothing, so the API's seed tests can load it by path and check
// that every seed spec whose answer ends in a line feed says so.

// The failed submits a claim allows before it ends (VOU-181). The API
// enforces it as TASK_MAX_FAILED_SUBMITS, this copy is only for messages.
export const MAX_FAILED_SUBMITS = 3;

export function endsInLineBreak(submission: string): boolean {
  return submission.endsWith('\n');
}

// Whether the spec asks the answer to end in a line feed, as the seed
// csv_normalise and text_dedupe tasks and the text_dedupe and line_sort
// templates do with "end with exactly one line feed". Every string in the
// spec but its input is read, so the phrase counts wherever a poster put
// it. A spec that says not to end with one does not count.
const FINAL_LINE_FEED =
  /\bend(?:s|ing)?\s+with\s+(?:exactly\s+)?(?:one|a|a\s+single|single)\s+(?:final\s+|trailing\s+)?(?:line\s*feed|newline|new\s+line|line\s+break)\b/gi;
const NEGATED = /\b(?:not|never|no|without)\s+$|n't\s+$/i;

export function specAsksFinalLineFeed(spec: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'input' || typeof value !== 'string') continue;
    for (const match of value.matchAll(FINAL_LINE_FEED)) {
      if (!NEGATED.test(value.slice(0, match.index))) return true;
    }
  }
  return false;
}
