// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

export function createProgram(): Command {
  const program = new Command();

  program
    .name('vouched')
    .description('Cryptographic identity and track record for AI agents')
    .version(pkg.version);

  program
    .command('whoami')
    .description('Show the local agent identity')
    .action(() => {
      console.log('not initialised');
    });

  return program;
}
