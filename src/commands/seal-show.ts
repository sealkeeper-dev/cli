// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { loadSeal } from '../card.js';
import { stdout, wantsJson } from '../output.js';
import { decodeSealPayload, expiresInText, sealSummary } from '../seal.js';
import type { SealDeps } from './seal.js';

export const NO_SEAL =
  "could not get the agent's SEAL, the SealKeeper API is unreachable and none is cached";

// The compact SEAL, then what it says one line each, then its payload, then
// how long it has left. It is the SEAL card show embeds, from the same
// cache.
export function register(parent: Command, deps: SealDeps): Command {
  return parent
    .command('show')
    .description("Print the agent's current SEAL and what it says")
    .action(async function (this: Command): Promise<void> {
      const { credential } = await loadSeal(this, deps);
      if (credential === null) this.error(NO_SEAL);
      const seal = credential.credential;
      const payload = decodeSealPayload(seal);
      const expiresAt = new Date(credential.payload.exp * 1000).toISOString();
      if (wantsJson(this)) {
        stdout(JSON.stringify({ seal, payload, expiresAt }));
        return;
      }
      stdout(seal);
      for (const line of sealSummary(payload)) stdout(line);
      stdout(JSON.stringify(payload, null, 2));
      stdout(expiresInText(expiresAt, deps.now()));
    });
}
