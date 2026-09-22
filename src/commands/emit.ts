// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { notImplemented } from './not-implemented.js';

export function register(parent: Command): Command {
  return parent
    .command('emit')
    .description('Append one event to the local log. Adapters call this')
    .action(notImplemented('emit'));
}
