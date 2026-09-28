// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { WELL_KNOWN_PATH } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { resolveApiUrl } from '../api.js';
import { paths } from '../config.js';
import { stderr, stdout, wantsJson } from '../output.js';
import type { WellKnown } from '../responses.js';
import {
  checkSeal,
  expiresInText,
  ISSUER_ORIGIN,
  KEYS_OFFLINE_MAX_AGE_MS,
  KeysError,
  keysOrigin,
  loadKeys,
  readKeysFile,
  type SealCheck,
  sealIssuer,
  sealKid,
  sealSummary,
} from '../seal.js';
import { configApiUrl } from './check.js';
import type { SealDeps } from './seal.js';

// Exit codes. 0 a valid SEAL, 1 a broken or expired one, 2 the keys could
// not be loaded, which with --offline means the cache has no usable copy.
const EXIT_BROKEN = 1;
const EXIT_NO_KEYS = 2;

// Needs no key, no init and no account. The keys come from --keys, or from
// the keys document (WELL_KNOWN_PATH) through a cache in the home. A SEAL
// from the production issuer gets it from WELL_KNOWN_URL, the issuer's own
// domain, and a local or staging API's SEAL from that API (keysBaseUrl).
// --offline reads the cache only.
export function register(parent: Command, deps: SealDeps): Command {
  return parent
    .command('verify <seal>')
    .description(
      'Verify a SEAL offline, exit 0 when valid and 1 when broken. Pass - to read it from stdin',
    )
    .option(
      '--keys <file>',
      `a saved copy of ${WELL_KNOWN_PATH}, nothing is fetched`,
    )
    .option(
      '--offline',
      `use the cached keys only, exit 2 when there are none or they are more than ${KEYS_OFFLINE_MAX_AGE_MS / (24 * 3600 * 1000)} days old`,
    )
    .action(async function (
      this: Command,
      input: string,
      options: { keys?: string; offline?: boolean },
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
        // The origin the keys came from, null for keys from a file.
        let origin: string | null = null;
        // --keys wins over --offline, and neither touches the network.
        try {
          if (options.keys !== undefined) {
            wellKnown = await readKeysFile(options.keys);
          } else {
            const apiUrl = resolveApiUrl({ config: await configApiUrl() });
            const iss = sealIssuer(seal);
            origin = keysOrigin(apiUrl, iss);
            wellKnown = await loadKeys({
              apiUrl,
              fetch: deps.fetch,
              paths: paths(),
              nowMs,
              kid,
              iss,
              offline: options.offline === true,
            });
          }
        } catch (error) {
          if (error instanceof KeysError) {
            this.error(error.message, { exitCode: EXIT_NO_KEYS });
          }
          throw error;
        }
        result = await checkSeal(seal, wellKnown, nowMs);
        // A SEAL from production checked by a CLI pointed at a local or
        // staging API meets that API's keys, so say where they came from.
        if (
          result.reason === 'unknown kid' &&
          origin !== null &&
          origin !== ISSUER_ORIGIN
        ) {
          stderr(
            `the keys came from ${origin}, the API this CLI points at, not from ${ISSUER_ORIGIN}`,
          );
        }
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
