// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { requireConfig } from '../cli-config.js';
import { type Config, handleOf, profileUrl } from '../config.js';
import { stdout, wantsJson } from '../output.js';

export function register(parent: Command): Command {
  return parent
    .command('whoami')
    .description('Show the local agent identity')
    .action(async function (this: Command): Promise<void> {
      const config = await requireConfig(this);

      printIdentity(config, wantsJson(this));
    });
}

// The identity lines whoami prints. init reuses them when the agent is
// already set up.
export function printIdentity(config: Config, json: boolean): void {
  const identity = {
    agentId: config.agentId,
    handle: handleOf(config),
    operatorLogin: config.operatorLogin,
    name: config.name,
    version: config.version,
    apiUrl: config.apiUrl,
    profileUrl: profileUrl(config),
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
