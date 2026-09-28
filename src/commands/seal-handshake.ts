// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  base64urlDecode,
  HANDSHAKE_MAX_AGE_SECONDS,
  HANDSHAKE_NONCE_MAX,
  HANDSHAKE_SKEW_SECONDS,
  HandshakeNonce,
  utf8Decode,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { makeHandshake } from '../handshake.js';
import { KeyError, loadKey, NO_KEY } from '../identity.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import type { SealDeps } from './seal.js';

export const NO_FINGERPRINT = `no fingerprint yet, run ${cli('sync')} to compute one`;

// Prints a handshake, the agent's current fingerprint hash signed with its
// key, for a verifier to check beside the SEAL with seal verify
// --handshake. Without a nonce it is good for as long as a SEAL lives,
// HANDSHAKE_MAX_AGE_SECONDS, and with one for HANDSHAKE_SKEW_SECONDS, the
// live challenge.
// The fingerprint is the one sync or prove last wrote, never recomputed.
// Exits 1 with one line when there is none.
export function register(parent: Command, deps: SealDeps): Command {
  return parent
    .command('handshake')
    .description(
      `Sign the agent's current fingerprint for a verifier, good for ${HANDSHAKE_MAX_AGE_SECONDS / 3600} hours, or ${HANDSHAKE_SKEW_SECONDS / 60} minutes with --nonce`,
    )
    .option(
      '--nonce <text>',
      `a nonce the verifier gave you, 1 to ${HANDSHAKE_NONCE_MAX} printable ASCII characters`,
    )
    .action(async function (
      this: Command,
      options: { nonce?: string },
    ): Promise<void> {
      if (
        options.nonce !== undefined &&
        !HandshakeNonce.safeParse(options.nonce).success
      ) {
        this.error(
          `--nonce must be 1 to ${HANDSHAKE_NONCE_MAX} printable ASCII characters`,
        );
      }
      let handshake: string | null;
      try {
        if ((await loadKey()) === null) this.error(NO_KEY);
        handshake = await makeHandshake(deps.now(), options.nonce);
      } catch (error) {
        if (error instanceof KeyError) this.error(error.message);
        throw error;
      }
      if (handshake === null) this.error(NO_FINGERPRINT);
      if (wantsJson(this)) {
        const payload = JSON.parse(
          utf8Decode(base64urlDecode(handshake.split('.')[1] ?? '')),
        );
        stdout(JSON.stringify({ handshake, payload }));
        return;
      }
      stdout(handshake);
    });
}
