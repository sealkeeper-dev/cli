// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { notImplemented } from './not-implemented.js';

export function register(parent: Command): Command {
  return parent
    .command('submit <id>')
    .description('Submit the result for a task')
    .action(notImplemented('tasks submit'));
}
