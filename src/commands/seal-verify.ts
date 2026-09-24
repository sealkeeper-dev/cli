// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { resolveApiUrl } from '../api.js';
import { paths } from '../config.js';
import { stdout, wantsJson } from '../output.js';
import type { WellKnown } from '../responses.js';
import {
  checkSeal,
  expiresInText,
  KeysError,
  loadKeys,
  readKeysFile,
  type SealCheck,
  sealKid,
  sealSummary,
} from '../seal.js';
import { configApiUrl } from './check.js';
import type { SealDeps } from './seal.js';

// Exit codes. 0 a valid SEAL, 1 a broken or expired one, 2 the keys could
// not be loaded.
export const EXIT_BROKEN = 1;
export const EXIT_NO_KEYS = 2;

// Needs no key, no init and no account. The keys come from --keys, or from
// the API's /.well-known/vouched.json through a cache in VOUCHED_HOME.
export function register(parent: Command, deps: SealDeps): Command {
  return parent
    .command('verify <seal>')
    .description(
      'Verify a SEAL offline, exit 0 when valid and 1 when broken. Pass - to read it from stdin',
    )
    .option(
      '--keys <file>',
      'a saved copy of /.well-known/vouched.json, nothing is fetched',
    )
    .action(async function (
      this: Command,
      input: string,
      options: { keys?: string },
    ): Promise<void> {
      const seal = (input === '-' ? await deps.readStdin() : input).trim();
      const nowMs = deps.now();

      // A SEAL that is not even a JWS is broken without any keys.
      const kid = sealKid(seal);
      let result: SealCheck;
      if (kid === null) {
        result = await checkSeal(seal, { keys: [] }, nowMs);
      } else {
        let wellKnown: WellKnown;
        try {
          wellKnown =
            options.keys !== undefined
              ? await readKeysFile(options.keys)
              : await loadKeys({
                  apiUrl: resolveApiUrl({ config: await configApiUrl() }),
                  fetch: deps.fetch,
                  paths: paths(),
                  nowMs,
                  kid,
                });
        } catch (error) {
          if (error instanceof KeysError) {
            this.error(error.message, { exitCode: EXIT_NO_KEYS });
          }
          throw error;
        }
        result = await checkSeal(seal, wellKnown, nowMs);
      }

      if (wantsJson(this)) {
        stdout(JSON.stringify(result));
      } else {
        stdout(result.valid ? 'valid SEAL' : `broken SEAL: ${result.reason}`);
        // What it says only for a valid SEAL. A broken one shows the raw
        // payload and nothing that reads like a claim.
        if (result.valid) {
          for (const line of sealSummary(result.payload)) stdout(line);
        }
        if (result.payload !== null) {
          stdout(JSON.stringify(result.payload, null, 2));
        }
        if (result.valid && result.expiresAt !== null) {
          stdout(expiresInText(result.expiresAt, nowMs));
        }
      }
      if (!result.valid) process.exitCode = EXIT_BROKEN;
    });
}
