// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Parity between `sealkeeper seal verify` and the strict parser the API and the
// web use, parseSealPayload from @sealkeeper/schema, for version 1 SEALs.
// Each fixture is signed with a test key and checked both ways. Where the
// strict parser says ok the CLI must say valid, and where it says malformed
// the CLI must say malformed too. Below that, the SEAL conformance cases
// every verifier runs.
import {
  base64urlEncode,
  type VerifiedCredentialPayload as CredentialPayload,
  generateKeypair,
  parseSealPayload,
  type SealBrokenReason,
  type SealPayload,
  sign,
} from '@sealkeeper/schema';
import {
  type HandshakeConformance,
  handshakeConformanceCases,
  type SealConformance,
  sealConformanceCases,
} from '@sealkeeper/schema/conformance';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkHandshakeLine } from './handshake.js';
import { checkSeal, sealSummary } from './seal.js';

const KID = 'sealkeeper-parity-1';
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NOW_SEC = NOW / 1000;
const HOUR = 3600;
const SUB = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';

const base: CredentialPayload = {
  iss: 'sealkeeper.run',
  sub: SUB,
  ver: 1,
  iat: NOW_SEC - HOUR,
  exp: NOW_SEC + 23 * HOUR,
  agent_version: '1.0.0',
  version: '1.0.0',
  level: 'bronze',
  scores: { reliability: 0.9, safety: null },
  counts: {
    events: 12,
    history_days: 3,
    verified_tasks: 26,
    seed_tasks: 25,
    server_checked_tasks: 1,
    confirmed_tasks: 0,
    distinct_operators: 1,
    safety_incidents_90d: 0,
  },
  operator: { verified: true },
  identity: [
    {
      provider: 'https://id.example.com',
      kind: 'oidc',
      ref: 'att-1',
      subject_hash: 'a'.repeat(43),
      attested_at: NOW_SEC - 10 * HOUR,
      scope: 'operator',
    },
  ],
  last_active: NOW_SEC - 2 * 86_400,
  dormant_days: 2,
};

const without = (key: string) => {
  const copy: Record<string, unknown> = { ...base };
  delete copy[key];
  return copy;
};

const FIXTURES: [string, unknown][] = [
  ['the full version 1 payload', base],
  ['no identity references', { ...base, identity: [] }],
  ['never active', { ...base, last_active: null, dormant_days: null }],
  ['an extra top level key', { ...base, badge: 'gold' }],
  // Intended. Platinum is reserved on the schema's LADDER and is not a level
  // under ver 1, 2 or 3 (standard, section 9) until a ver bump issues it.
  ['a level that is not in the standard', { ...base, level: 'platinum' }],
  [
    'a score for a dimension that does not exist',
    {
      ...base,
      scores: { ...base.scores, charisma: 1 },
    },
  ],
  // Competence rolled up to category in RT-3. A SEAL issued before carries
  // a task type key, and both verifiers still take it.
  [
    'competence by category',
    { ...base, scores: { ...base.scores, 'competence:data': 0.8 } },
  ],
  [
    'competence by task type, issued before categories',
    { ...base, scores: { ...base.scores, 'competence:csv_normalise': 0.8 } },
  ],
  // D-UI-12. math can be chosen, and a SEAL issued before still names
  // conversation or other, which are no longer offered.
  [
    'competence in math',
    { ...base, scores: { ...base.scores, 'competence:math': 0.7 } },
  ],
  [
    'competence in conversation and other, issued before math',
    {
      ...base,
      scores: {
        ...base.scores,
        'competence:conversation': 0.8,
        'competence:other': 0.6,
      },
    },
  ],
  [
    'a count missing',
    {
      ...base,
      counts: { ...base.counts, history_days: undefined },
    },
  ],
  ['an extra count', { ...base, counts: { ...base.counts, stars: 3 } }],
  ['version and agent_version differ', { ...base, version: '0.9.0' }],
  ['no version beside agent_version', without('version')],
  ['no agent_version', without('agent_version')],
  ['no level', without('level')],
  ['no operator', without('operator')],
  [
    'an extra key in operator',
    {
      ...base,
      operator: { verified: true, org: 'x' },
    },
  ],
  ['no identity', without('identity')],
  ['no last_active', without('last_active')],
  ['no dormant_days', without('dormant_days')],
  [
    'an identity kind that is neither a name nor a URL',
    {
      ...base,
      identity: [{ ...base.identity[0], kind: 'passkey' }],
    },
  ],
  [
    'an identity scope that is not operator or agent',
    {
      ...base,
      identity: [{ ...base.identity[0], scope: 'team' }],
    },
  ],
  [
    'an identity subject hash of the wrong length',
    {
      ...base,
      identity: [{ ...base.identity[0], subject_hash: 'abc' }],
    },
  ],
  [
    'an extra key in an identity reference',
    {
      ...base,
      identity: [{ ...base.identity[0], name: 'Alice' }],
    },
  ],
  ['exp before iat', { ...base, exp: base.iat - 1 }],
  ['a negative dormant_days', { ...base, dormant_days: -1 }],
  ['a sub that is not an agent id', { ...base, sub: 'nope' }],
];

describe('seal verify parity with the strict parser for version 1', () => {
  let keys: { keys: [Record<string, string>] };
  let privateKey: Uint8Array;

  beforeAll(async () => {
    const pair = await generateKeypair();
    privateKey = pair.privateKey;
    keys = {
      keys: [
        {
          kid: KID,
          kty: 'OKP',
          crv: 'Ed25519',
          alg: 'EdDSA',
          x: base64urlEncode(pair.publicKey),
        },
      ],
    };
  });

  it.each(FIXTURES)('%s', async (_, payload) => {
    const strict = parseSealPayload(
      JSON.parse(JSON.stringify(payload)),
      NOW_SEC,
    );
    const jws = await sign(payload as object, privateKey, KID);
    const cli = await checkSeal(jws, keys as never, NOW);
    if (strict.ok) {
      expect(cli).toMatchObject({ valid: true, reason: null });
    } else {
      expect(strict.reason).toBe('malformed');
      expect(cli).toMatchObject({ valid: false, reason: 'malformed' });
    }
  });

  it('calls a score out of range and a life over 24 hours malformed', async () => {
    for (const payload of [
      { ...base, scores: { reliability: 1.5 } },
      { ...base, exp: base.iat + 24 * HOUR + 1 },
    ]) {
      const jws = await sign(payload, privateKey, KID);
      expect(await checkSeal(jws, keys as never, NOW)).toMatchObject({
        valid: false,
        reason: 'malformed',
      });
    }
  });

  it('covers both answers', () => {
    const verdicts = FIXTURES.map(
      ([, payload]) =>
        parseSealPayload(JSON.parse(JSON.stringify(payload)), NOW_SEC).ok,
    );
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});

// The SEAL conformance cases from @sealkeeper/schema. The API's verifySeal
// and the website's checkSeal run the same cases and must give the same
// answers. The CLI spells each reason with spaces and adds how
// long ago a SEAL expired, so it is mapped to the API's name here.
const API_NAME: Record<string, SealBrokenReason> = {
  malformed: 'malformed',
  'unknown kid': 'unknown_kid',
  'bad signature': 'bad_signature',
  'wrong issuer': 'wrong_issuer',
  'unsupported version': 'unsupported_version',
  'not yet valid': 'not_yet_valid',
  'wrong agent': 'wrong_agent',
};
const apiName = (reason: string) =>
  reason.startsWith('expired ') ? 'expired' : API_NAME[reason];

describe('seal verify against the SEAL conformance cases', () => {
  let suite: SealConformance;
  beforeAll(async () => {
    suite = await sealConformanceCases();
  });

  it('gives the expected answer for every case', async () => {
    const answers = await Promise.all(
      suite.cases.map(async (c) => {
        const r = await checkSeal(
          c.jws,
          suite.wellKnown as never,
          (c.nowSeconds ?? suite.nowSeconds) * 1000,
          c.agent,
        );
        return [c.name, r.valid ? 'valid' : apiName(r.reason ?? '')];
      }),
    );
    expect(answers).toEqual(suite.cases.map((c) => [c.name, c.expected]));
  });

  it('prints each counted value a SEAL carries beside its count, the posted ones of version 3 too', async () => {
    const counts = async (name: string) => {
      const c = suite.cases.find((x) => x.name === name);
      if (!c) throw new Error(`no case ${name}`);
      const r = await checkSeal(
        c.jws,
        suite.wellKnown as never,
        suite.nowSeconds * 1000,
      );
      expect(r.valid).toBe(true);
      return sealSummary(r.payload).filter((line) => /tasks /.test(line));
    };
    expect(
      await counts('version 3 with posted counts, fingerprint and state'),
    ).toEqual([
      'verified tasks 26, 17 counted',
      'seed tasks 25, 17 counted',
      'server checked tasks 1, 0 counted',
      'confirmed tasks 0, 0 counted',
      'posted tasks 4, 3 counted',
      'posted confirmed tasks 1, 1 counted',
    ]);
    expect(await counts('version 2 with counted evidence')).toEqual([
      'verified tasks 26, 17 counted',
      'seed tasks 25, 17 counted',
      'server checked tasks 1, 0 counted',
      'confirmed tasks 0, 0 counted',
    ]);
    expect(await counts('a valid SEAL')).toEqual([
      'verified tasks 26',
      'seed tasks 25',
      'server checked tasks 1',
      'confirmed tasks 0',
    ]);
  });

  it('says a SEAL issued ahead of the clock is not yet valid', async () => {
    const future = suite.cases.find((c) => c.expected === 'not_yet_valid');
    if (!future) throw new Error('no not_yet_valid case');
    const nowMs = suite.nowSeconds * 1000;
    const r = await checkSeal(future.jws, suite.wellKnown as never, nowMs);
    expect(r).toMatchObject({ valid: false, reason: 'not yet valid' });
    expect(r.payload).not.toBeNull();
    const later = await checkSeal(
      future.jws,
      suite.wellKnown as never,
      nowMs + 3600 * 1000,
    );
    expect(later.valid).toBe(true);
  });

  it('names a foreign issuer wrong issuer, whatever the payload shape', async () => {
    const foreign = suite.cases.filter((c) => c.expected === 'wrong_issuer');
    expect(foreign.length).toBeGreaterThanOrEqual(2);
    for (const c of foreign) {
      const r = await checkSeal(
        c.jws,
        suite.wellKnown as never,
        (c.nowSeconds ?? suite.nowSeconds) * 1000,
      );
      expect(r).toMatchObject({ valid: false, reason: 'wrong issuer' });
    }
  });
});

// The handshake conformance cases (VB-6), each beside the suite's version 3
// SEAL, through checkSeal and then checkHandshakeLine, what seal verify
// --handshake runs. The API and the web run the same cases.
describe('seal verify --handshake against the handshake conformance cases', () => {
  let hs: HandshakeConformance;
  beforeAll(async () => {
    hs = await handshakeConformanceCases();
  });

  it('gives the expected answer for every case', async () => {
    const answers = await Promise.all(
      hs.cases.map(async (c) => {
        const nowMs = (c.nowSeconds ?? hs.nowSeconds) * 1000;
        const seal = await checkSeal(hs.seal, hs.wellKnown as never, nowMs);
        if (!seal.valid) throw new Error(`SEAL ${seal.reason}`);
        const { out } = await checkHandshakeLine({
          handshake: c.jws,
          seal: seal.payload as SealPayload,
          nowMs,
          ...(c.nonce === undefined ? {} : { nonce: c.nonce }),
          ...(c.aud === undefined ? {} : { aud: c.aud }),
          record: async () => {
            throw new Error('read the record for a version 3 SEAL');
          },
        });
        return [c.name, out.json.valid ? out.json.result : out.json.reason];
      }),
    );
    expect(answers).toEqual(hs.cases.map((c) => [c.name, c.expected]));
  });
});
