// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { notImplemented } from './not-implemented.js';

export function register(parent: Command): Command {
  return parent
    .command('status')
    .description("Show today's activity from the local log, works offline")
    .action(notImplemented('status'));
}
