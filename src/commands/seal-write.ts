// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadSeal } from '../card.js';
import { writeFileAtomic } from '../config.js';
import { stdout, wantsJson } from '../output.js';
import type { SealDeps } from './seal.js';
import { NO_SEAL } from './seal-show.js';

export const SEAL_FILE = 'seal.txt';

// Public, like the card, so whatever serves it can read it.
const SEAL_FILE_MODE = 0o644;

// seal.txt goes where card write puts agent-card.json by default, the
// current directory, so the two can be served side by side.
export function register(parent: Command, deps: SealDeps): Command {
  return parent
    .command('write')
    .description("Write the agent's SEAL to seal.txt")
    .option('--dir <dir>', 'directory to write seal.txt in', '.')
    .action(async function (
      this: Command,
      options: { dir: string },
    ): Promise<void> {
      const { credential } = await loadSeal(this, deps);
      if (credential === null) this.error(NO_SEAL);
      const target = join(resolve(options.dir), SEAL_FILE);
      try {
        await writeFileAtomic(
          target,
          `${credential.credential}\n`,
          SEAL_FILE_MODE,
        );
      } catch (error) {
        this.error(`could not write ${target}: ${(error as Error).message}`);
      }
      stdout(wantsJson(this) ? JSON.stringify({ path: target }) : target);
    });
}
