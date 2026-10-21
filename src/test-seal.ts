// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// For tests. A SealKeeper signing key, its published keys and a current
// SEAL it signed, so code that verifies a SEAL can be tested end to end.
import { readFileSync } from 'node:fs';
import {
  base64urlEncode,
  generateKeypair,
  sign,
  WELL_KNOWN_PATH,
} from '@sealkeeper/schema';

const KID = 'sealkeeper-test-1';

export type SealFixture = {
  wellKnown: { keys: Record<string, string>[] };
  // A current SEAL for sub, signed with the published key.
  seal(sub: string): Promise<string>;
  // A current Service SEAL for sub, the v7-service-valid reader fixture's
  // payload with its times moved to now, signed with the published key.
  serviceSeal(sub: string): Promise<string>;
  // The keys for a request to the well-known path, else null.
  keysFor(url: string): Response | null;
};

export async function sealFixture(): Promise<SealFixture> {
  const key = await generateKeypair();
  const wellKnown = {
    keys: [
      {
        kid: KID,
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        x: base64urlEncode(key.publicKey),
      },
    ],
  };
  return {
    wellKnown,
    seal: (sub) => {
      const now = Math.floor(Date.now() / 1000);
      return sign(
        {
          iss: 'sealkeeper.run',
          sub,
          ver: 1,
          iat: now,
          exp: now + 86_400,
          agent_version: '1.0.0',
          version: '1.0.0',
          level: 'bronze',
          scores: { reliability: 0.9, safety: null },
          counts: {
            events: 12,
            history_days: 3,
            verified_tasks: 7,
            seed_tasks: 7,
            server_checked_tasks: 0,
            confirmed_tasks: 0,
            distinct_operators: 1,
            safety_incidents_90d: 0,
          },
          operator: { verified: false },
          identity: [],
          last_active: now,
          dormant_days: 0,
        },
        key.privateKey,
        KID,
      );
    },
    serviceSeal: (sub) => {
      const index = JSON.parse(
        readFileSync(
          new URL('../fixtures/index.json', import.meta.url),
          'utf8',
        ),
      ) as {
        cases: { name: string; expected: { pinned?: { payload: object } } }[];
      };
      const service = index.cases.find((c) => c.name === 'v7-service-valid')
        ?.expected.pinned?.payload;
      const now = Math.floor(Date.now() / 1000);
      return sign(
        { ...service, sub, iat: now, exp: now + 86_400, last_active: now },
        key.privateKey,
        KID,
      );
    },
    keysFor: (url) =>
      new URL(url).pathname === WELL_KNOWN_PATH
        ? Response.json(wellKnown)
        : null,
  };
}
