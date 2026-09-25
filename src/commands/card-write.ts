// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { type CardDeps, defaultCardDeps, loadCard } from '../card.js';
import { writeFileAtomic } from '../config.js';
import { stdout, wantsJson } from '../output.js';

const DEFAULT_CARD_FILE = 'agent-card.json';

// The card is public, so the file is world readable for whatever serves it.
const CARD_FILE_MODE = 0o644;

// Writes atomically, so a web server reading the file during a scheduled
// run never sees half a card.
export function register(
  parent: Command,
  deps: CardDeps = defaultCardDeps,
): Command {
  return parent
    .command('write')
    .description("Write agent-card.json with the agent's SEAL")
    .option('--out <path>', 'where to write the card', DEFAULT_CARD_FILE)
    .option('--url <url>', 'https URL where the agent serves A2A requests')
    .action(async function (
      this: Command,
      options: { out: string; url?: string },
    ): Promise<void> {
      const card = await loadCard(this, deps, options.url);
      const target = resolve(options.out);
      try {
        await writeFileAtomic(
          target,
          `${JSON.stringify(card, null, 2)}\n`,
          CARD_FILE_MODE,
        );
      } catch (error) {
        this.error(`could not write ${target}: ${(error as Error).message}`);
      }
      stdout(wantsJson(this) ? JSON.stringify({ path: target }) : target);
    });
}
