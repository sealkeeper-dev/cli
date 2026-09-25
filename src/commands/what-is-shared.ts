// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { stdout } from '../output.js';
import { describeTaxonomy } from '../taxonomy.js';

// Prints the full What leaves this machine block. init prints a short
// version and points here.
export function register(parent: Command): Command {
  return parent
    .command('what-is-shared')
    .description('Print what leaves this machine')
    .action(() => {
      stdout(describeTaxonomy());
    });
}
