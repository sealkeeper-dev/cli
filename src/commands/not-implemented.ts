// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';

export const NOT_IMPLEMENTED_EXIT_CODE = 2;

// Action for a launch command whose issue has not landed yet. Commander writes
// the message to stderr and exits with code 2.
export function notImplemented(label: string) {
  return function (this: Command): void {
    this.error(`${label} is not implemented yet`, {
      exitCode: NOT_IMPLEMENTED_EXIT_CODE,
      code: 'vouched.notImplemented',
    });
  };
}
