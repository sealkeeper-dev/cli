// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import { ChangeVersionRequest } from '@sealkeeper/schema';
import type { ApiClient } from './api.js';
import { type Config, type Paths, paths, writeConfig } from './config.js';
import type { Signer } from './identity.js';

// What a version change means for the record, in the words of the SEAL
// standard, section 5, Version change.
export const inheritLine = (previous: string, next: string): string =>
  `${next} starts from half of ${previous}'s counts, with its level capped one below ${previous}'s, and earns the rest on its own record`;

export type VersionChange = { previous: string; next: string; config: Config };

// Moves the agent's version on SealKeeper with a request signed by its key,
// then writes the new version to config.json, which the card and every
// later event take it from. The SEAL cache names the old version, so it
// goes, and the next card or seal command fetches the new SEAL. previous
// is the version SealKeeper had, which the caller read first.
export async function changeVersion(options: {
  api: ApiClient;
  signer: Signer;
  config: Config;
  previous: string;
  version: string;
  paths?: Paths;
}): Promise<VersionChange> {
  const p = options.paths ?? paths();
  // issuedAt is signed with the version, so the API can refuse an old
  // envelope sent again.
  const request = ChangeVersionRequest.parse({
    version: options.version,
    issuedAt: new Date().toISOString(),
  });
  const agent = await options.api.changeAgentVersion(
    options.config.agentId,
    await options.signer.sign(request),
  );
  const config = await writeConfig(
    { ...options.config, version: agent.version },
    p,
  );
  await rm(p.credential, { force: true });
  return { previous: options.previous, next: agent.version, config };
}
