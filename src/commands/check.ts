// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { CheckResponse } from '@vouched-dev/schema';
import type { Command } from 'commander';
import { ApiError, resolveApiUrl } from '../api.js';
import { describeCheck, fetchCheck } from '../check.js';
import { readConfig } from '../config.js';
import { stdout, wantsJson } from '../output.js';

export type CheckCommandDeps = { fetch?: typeof fetch };

// Exit codes. 0 every check passed, 1 at least one failed, 2 the check
// could not run (bad handle or flag, unknown agent, network).
export const EXIT_FAIL = 1;
export const EXIT_ERROR = 2;

type Flags = {
  minVerified?: string;
  maxIncidents?: string;
  minReliability?: string;
  minSafety?: string;
};

// The API URL of a local config when there is one, so a dev setup checks
// against its own API. A missing or unreadable config is not an error here.
async function configApiUrl(): Promise<string | null> {
  try {
    return (await readConfig())?.apiUrl ?? null;
  } catch {
    return null;
  }
}

export function register(
  parent: Command,
  deps: CheckCommandDeps = {},
): Command {
  return parent
    .command('check <handle>')
    .description(
      "Check another agent's track record before delegating to it, exit 0 on pass and 1 on fail",
    )
    .option('--min-verified <n>', 'verified tasks needed, default 1')
    .option('--max-incidents <n>', 'incidents allowed, default 0')
    .option('--min-reliability <x>', 'reliability needed, 0 to 1')
    .option('--min-safety <x>', 'safety needed, 0 to 1')
    .action(async function (this: Command, handle: string): Promise<void> {
      const flags = this.opts<Flags>();
      let result: CheckResponse;
      try {
        result = await fetchCheck(
          handle,
          {
            minVerified: flags.minVerified,
            maxIncidents: flags.maxIncidents,
            minReliability: flags.minReliability,
            minSafety: flags.minSafety,
          },
          {
            apiUrl: resolveApiUrl({ config: await configApiUrl() }),
            fetch: deps.fetch,
          },
        );
      } catch (error) {
        if (error instanceof ApiError) {
          this.error(error.message, { exitCode: EXIT_ERROR });
        }
        throw error;
      }

      if (wantsJson(this)) {
        stdout(JSON.stringify(result));
      } else {
        for (const check of result.checks) stdout(describeCheck(check));
        stdout(`${result.ok ? 'PASS' : 'FAIL'} ${result.handle}`);
      }
      if (!result.ok) process.exitCode = EXIT_FAIL;
    });
}
