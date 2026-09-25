// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { stdout } from '../output.js';
import { describeTaxonomy } from '../taxonomy.js';

// Prints the What leaves this machine block that init ends with, so it can
// be read again at any time. Hidden from help, named in the README.
export function register(parent: Command): Command {
  return parent
    .command('what-is-shared')
    .description('Print what leaves this machine')
    .action(() => {
      stdout(describeTaxonomy());
    });
}
