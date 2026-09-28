// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { requireConfig } from '../cli-config.js';
import { type Config, handleOf, profileUrl } from '../config.js';
import { fingerprintText } from '../live-agent.js';
import { currentOperatorSlug } from '../operator-slug.js';
import { stdout, wantsJson } from '../output.js';

// fetch reads the agent for the operator slug and the current fingerprint,
// with a two second limit. Offline the last slug the API sent is used, see
// operator-slug.ts, and the fingerprint reads -.
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
      const { slug, live } = await currentOperatorSlug(config, deps.fetch);
      const json = wantsJson(this);

      // The fingerprint the API keeps for the agent (VB-4), each part's
      // state, as status and the profile show it. --json carries it as the
      // API sent it, null when the agent has declared none, and leaves it
      // out when the API did not answer or sent none.
      const fingerprint = live?.fingerprint;
      if (json) {
        stdout(
          JSON.stringify({
            ...identityOf(config, slug),
            ...(fingerprint === undefined ? {} : { fingerprint }),
          }),
        );
        return;
      }
      printIdentity(config, false, slug, fingerprintText(fingerprint));
    });
}

// The identity lines whoami prints. init reuses them when the agent is
// already set up. slug is the operator slug, and the login stands in for
// it when null. fingerprint is the fingerprint row whoami adds, left out
// when not given.
export function printIdentity(
  config: Config,
  json: boolean,
  slug: string | null,
  fingerprint?: string,
): void {
  const identity: Record<string, string> = identityOf(config, slug);

  if (json) {
    stdout(JSON.stringify(identity));
    return;
  }
  const rows = {
    ...identity,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
  const width = Math.max(...Object.keys(rows).map((k) => k.length));
  for (const [key, value] of Object.entries(rows)) {
    stdout(`${key.padEnd(width)}  ${value}`);
  }
}

// The identity whoami prints, and init prints with --json on a repeat run.
export function identityOf(config: Config, slug: string | null) {
  return {
    agentId: config.agentId,
    handle: handleOf(config, slug),
    operatorLogin: config.operatorLogin,
    name: config.name,
    version: config.version,
    apiUrl: config.apiUrl,
    profileUrl: profileUrl(config, slug),
  };
}
