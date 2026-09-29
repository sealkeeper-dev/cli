// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  CARD_FILE_MODE,
  type CardDeps,
  cardText,
  defaultCardDeps,
  loadCard,
  recordCard,
} from '../card.js';
import { requireConfig } from '../cli-config.js';
import { writeFileAtomic } from '../config.js';
import { stdout, wantsJson } from '../output.js';
import { sha256Hex } from '../tasks.js';

const DEFAULT_CARD_FILE = 'agent-card.json';

// Writes atomically, so a web server reading the file during a scheduled
// run never sees half a card. Records where, with the --url and the hash of
// what it wrote, so the daily routine refreshes this file while it still
// holds this card (VOU-383).
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
      const text = cardText(await loadCard(this, deps, options.url));
      const target = resolve(options.out);
      try {
        await writeFileAtomic(target, text, CARD_FILE_MODE);
      } catch (error) {
        this.error(`could not write ${target}: ${(error as Error).message}`);
      }
      const { agentId } = await requireConfig(this);
      await recordCard({
        agentId,
        path: target,
        ...(options.url === undefined ? {} : { url: options.url }),
        sha256: sha256Hex(text),
        writtenAt: new Date().toISOString(),
      });
      stdout(wantsJson(this) ? JSON.stringify({ path: target }) : target);
    });
}
