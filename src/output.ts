// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Command } from 'commander';

// Control characters other than tab and line feed, DEL, the C1 controls and
// the bidi overrides. Text from the API or from other agents' tasks reaches
// the terminal, where these could move the cursor, rewrite the clipboard
// (OSC 52), fake a link or reorder what a person reads.
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// Shows each unsafe character as a \uXXXX escape. JSON.stringify already
// escapes C0 controls, so the rest can only sit inside JSON strings, where
// the escape means the same character and --json output stays valid.
export function terminalSafe(text: string): string {
  return text.replace(
    UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function stdout(text: string): void {
  process.stdout.write(`${terminalSafe(text)}\n`);
}

// The library entries run inside someone else's agent, whose stderr is not
// ours to write to. Work started inside quietly, including async work it
// kicks off, drops the warnings stderr would print. The CLI never uses it.
const quiet = new AsyncLocalStorage<true>();

export function quietly<T>(fn: () => T): T {
  return quiet.run(true, fn);
}

export function stderr(text: string): void {
  if (quiet.getStore()) return;
  process.stderr.write(`${terminalSafe(text)}\n`);
}

// --json is declared on the root program and on every leaf command, so it
// works before or after the command name. Any command reads it through its
// own options merged with those of its ancestors.
export function wantsJson(command: Command): boolean {
  return command.optsWithGlobals().json === true;
}
