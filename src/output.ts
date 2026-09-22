// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';

export function stdout(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function stderr(text: string): void {
  process.stderr.write(`${text}\n`);
}

// The global --json flag is declared on the root program. Any command reads it
// through its own options merged with those of its ancestors.
export function wantsJson(command: Command): boolean {
  return command.optsWithGlobals().json === true;
}
