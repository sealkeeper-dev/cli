// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { type Config, ConfigError, profileUrl, readConfig } from '../config.js';
import { stdout, wantsJson } from '../output.js';

export const NOT_INITIALISED = 'not initialised, run vouched init';

export function register(parent: Command): Command {
  return parent
    .command('whoami')
    .description('Show the local agent identity')
    .action(async function (this: Command): Promise<void> {
      let config: Awaited<ReturnType<typeof readConfig>>;
      try {
        config = await readConfig();
      } catch (error) {
        if (error instanceof ConfigError) this.error(error.message);
        throw error;
      }
      if (config === null) this.error(NOT_INITIALISED);

      printIdentity(config, wantsJson(this));
    });
}

// The identity lines whoami prints. init reuses them when the agent is
// already set up.
export function printIdentity(config: Config, json: boolean): void {
  const identity = {
    agentId: config.agentId,
    operatorLogin: config.operatorLogin,
    name: config.name,
    version: config.version,
    apiUrl: config.apiUrl,
    profileUrl: profileUrl(config.agentId),
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
