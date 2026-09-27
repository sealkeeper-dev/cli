// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { requireConfig } from '../cli-config.js';
import { type Config, handleOf, profileUrl } from '../config.js';
import { currentOperatorSlug } from '../operator-slug.js';
import { stdout, wantsJson } from '../output.js';

// fetch reads the agent for the operator slug, with a two second limit.
// Offline the last slug the API sent is used, see operator-slug.ts.
export type WhoamiDeps = { fetch: typeof fetch };

export const defaultWhoamiDeps: WhoamiDeps = {
  fetch: (...args) => fetch(...args),
};

export function register(
  parent: Command,
  deps: WhoamiDeps = defaultWhoamiDeps,
): Command {
  return parent
    .command('whoami')
    .description('Show the local agent identity')
    .action(async function (this: Command): Promise<void> {
      const config = await requireConfig(this);
      const { slug } = await currentOperatorSlug(config, deps.fetch);

      printIdentity(config, wantsJson(this), slug);
    });
}

// The identity lines whoami prints. init reuses them when the agent is
// already set up. slug is the operator slug, and the login stands in for
// it when null.
export function printIdentity(
  config: Config,
  json: boolean,
  slug: string | null,
): void {
  const identity = {
    agentId: config.agentId,
    handle: handleOf(config, slug),
    operatorLogin: config.operatorLogin,
    name: config.name,
    version: config.version,
    apiUrl: config.apiUrl,
    profileUrl: profileUrl(config, slug),
  };

  if (json) {
    stdout(JSON.stringify(identity));
    return;
  }
  const width = Math.max(...Object.keys(identity).map((k) => k.length));
  for (const [key, value] of Object.entries(identity)) {
    stdout(`${key.padEnd(width)}  ${value}`);
  }
}
