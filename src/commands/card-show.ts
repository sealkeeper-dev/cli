// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { type CardDeps, defaultCardDeps, loadCard } from '../card.js';
import { stdout } from '../output.js';

// The card is JSON, so --json changes nothing here.
export function register(
  parent: Command,
  deps: CardDeps = defaultCardDeps,
): Command {
  return parent
    .command('show')
    .description("Print the A2A agent card with the agent's SEAL")
    .option('--url <url>', 'https URL where the agent serves A2A requests')
    .action(async function (
      this: Command,
      options: { url?: string },
    ): Promise<void> {
      const card = await loadCard(this, deps, options.url);
      stdout(JSON.stringify(card, null, 2));
    });
}
