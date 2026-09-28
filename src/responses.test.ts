// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  LEGACY_ISSUER_UNTIL,
  LEGACY_ISSUERS,
  publicVerification,
} from '@sealkeeper/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { createApiClient } from './api.js';
import {
  AgentRenamedResponse,
  AgentResponse,
  agentHandle,
  CheckResponse,
  CredentialPayload,
  CredentialResponse,
  ErrorResponse,
  EventsBatchResponse,
  ListTasksResponse,
  operatorSlugOf,
  RatingResponse,
  runBySealKeeper,
  ScoreResponse,
  SealClaims,
  sealWithheldOf,
  TaskResponse,
  WellKnown,
  withheldText,
} from './responses.js';

const ID = 'A'.repeat(43);
const JWS = 'eyJh.eyJi.c2ln';
const AT = '2026-09-24T10:00:00.000Z';

const agent = {
  id: ID,
  name: 'scout',
  version: '0.1.0',
  operator: { login: 'alice' },
  createdAt: AT,
  handle: 'alice/scout',
  counts: {
    events: 1,
    verifiedTasks: 0,
    incidents: 0,
    sessions: 1,
    toolCalls: 0,
  },
};

const task = {
  id: '7c1e0a52-3f7e-4d0b-9a55-2f1c8f0b6a11',
  posterAgentId: ID,
  claimantAgentId: null,
  taskType: 'lint',
  spec: { q: 1 },
  verification: { kind: 'hash', sha256: 'a'.repeat(64) },
  state: 'open',
  postedAt: AT,
  claimedAt: null,
  submittedAt: null,
  verifiedAt: null,
  expiresAt: AT,
};

const payload = {
  iss: 'sealkeeper.run',
  sub: ID,
  iat: 1,
  exp: 2,
  version: '0.1.0',
  scores: { reliability: 0.5 },
  counts: { events: 1, verified_tasks: 0 },
};

// The same SEAL as version 1 of the standard, every field it added.
const payloadV1 = {
  ...payload,
  ver: 1,
  agent_version: '0.1.0',
  level: 'bronze',
  counts: {
    events: 1,
    history_days: 1,
    verified_tasks: 0,
    seed_tasks: 0,
    server_checked_tasks: 0,
    confirmed_tasks: 0,
    distinct_operators: 0,
    safety_incidents_90d: 0,
  },
  operator: { verified: false },
  identity: [
    {
      provider: 'https://login.example.com',
      kind: 'oidc',
      ref: 'r',
      subject_hash: 'h',
      attested_at: 1,
      scope: 'operator',
    },
  ],
  last_active: 1,
  dormant_days: 0,
};

const scoreEntry = {
  version: '0.1.0',
  dimension: 'reliability',
  value: null,
  windowStart: null,
  windowEnd: null,
  computedAt: null,
};

// Every schema the CLI reads an API answer with, a valid answer, and the
// path of a nested object inside it that must also take an unknown key.
const cases: [string, z.ZodType, Record<string, unknown>, string[]][] = [
  ['AgentResponse', AgentResponse, agent, ['counts']],
  ['registration answer', AgentResponse, agent, ['operator']],
  [
    'EventsBatchResponse',
    EventsBatchResponse,
    { accepted: 1, duplicates: 0 },
    [],
  ],
  [
    'CredentialResponse',
    CredentialResponse,
    { credential: JWS, payload },
    ['payload'],
  ],
  ['CredentialPayload', CredentialPayload, payload, ['counts']],
  ['SealClaims', SealClaims, payload, ['counts']],
  ['SealClaims version 1', SealClaims, payloadV1, ['operator']],
  ['CredentialPayload version 1', CredentialPayload, payloadV1, ['counts']],
  [
    'WellKnown',
    WellKnown,
    {
      keys: [{ kid: 'k1', kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', x: ID }],
    },
    [],
  ],
  ['TaskResponse', TaskResponse, task, ['verification']],
  ['ListTasksResponse', ListTasksResponse, { tasks: [task] }, []],
  [
    'ListTasksResponse with seed and nextCursor',
    ListTasksResponse,
    { tasks: [{ ...task, seed: true }], nextCursor: 'abc' },
    [],
  ],
  [
    'RatingResponse',
    RatingResponse,
    {
      rateeAgentId: ID,
      dimension: 'safety',
      value: 4,
      raterScoreAtTime: 0.8,
    },
    [],
  ],
  ['ScoreResponse', ScoreResponse, { agentId: ID, scores: [scoreEntry] }, []],
  [
    'CheckResponse',
    CheckResponse,
    {
      ok: true,
      id: ID,
      handle: 'alice/scout',
      checks: [{ name: 'minVerified', required: 1, actual: 1, ok: true }],
      credential: JWS,
    },
    [],
  ],
  [
    'AgentRenamedResponse',
    AgentRenamedResponse,
    {
      error: { code: 'renamed', message: 'moved' },
      id: ID,
      handle: 'alice/scout',
    },
    ['error'],
  ],
  [
    'ErrorResponse',
    ErrorResponse,
    { error: { code: 'not_found', message: 'no' } },
    ['error'],
  ],
];

function withExtra(
  value: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  const copy = structuredClone(value);
  let target: Record<string, unknown> = copy;
  for (const key of path) target = target[key] as Record<string, unknown>;
  target.addedLater = { any: 'thing' };
  return { ...copy, addedLater: 'by a newer API' };
}

describe('response schemas parse loosely', () => {
  it.each(cases)('%s accepts the plain answer', (_, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each(cases)('%s accepts unknown keys', (_, schema, value, path) => {
    const result = schema.safeParse(withExtra(value, path));
    expect(result.success).toBe(true);
  });

  it.each(cases)('%s still rejects a missing field', (_, schema, value) => {
    const [first] = Object.keys(value);
    const { [first as string]: _dropped, ...rest } = value;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it('SealClaims keeps seed_tasks when present and takes a SEAL without it', () => {
    const counts = { events: 1, verified_tasks: 2, seed_tasks: 2 };
    expect(SealClaims.parse({ ...payload, counts }).counts).toEqual(counts);
    expect(SealClaims.parse(payload).counts).toEqual(payload.counts);
    expect(
      SealClaims.safeParse({
        ...payload,
        counts: { ...counts, seed_tasks: -1 },
      }).success,
    ).toBe(false);
  });

  it('TaskResponse reads seed when the API sends it and as unknown when it does not (VOU-208)', () => {
    expect(TaskResponse.parse(task).seed).toBeUndefined();
    expect(TaskResponse.parse({ ...task, seed: true }).seed).toBe(true);
    expect(TaskResponse.parse({ ...task, seed: false }).seed).toBe(false);
    expect(ListTasksResponse.parse({ tasks: [] }).nextCursor).toBeUndefined();
    // posterOperator was never sent, and is no longer read.
    expect(
      TaskResponse.parse({ ...task, posterOperator: { login: 'alice' } }),
    ).not.toHaveProperty('posterOperator');
  });

  it('TaskResponse takes the redacted schema the API shows for a schema task', () => {
    // A json_shape seed schema, as stored and as GET /v1/tasks shows it.
    const verification = publicVerification({
      kind: 'schema',
      jsonSchema: {
        type: 'object',
        properties: {
          guest: { type: 'string', const: 'Amara' },
          nights: { type: 'integer', const: 3 },
          breakfast: { type: 'boolean', const: true },
        },
        required: ['guest', 'nights', 'breakfast'],
        additionalProperties: false,
      },
    });
    const parsed = TaskResponse.parse({
      ...task,
      taskType: 'json_shape',
      verification,
    });
    expect(parsed.verification).toEqual({
      kind: 'schema',
      jsonSchema: {
        type: 'object',
        properties: {
          guest: { type: 'string' },
          nights: { type: 'integer' },
          breakfast: { type: 'boolean' },
        },
        required: ['guest', 'nights', 'breakfast'],
        additionalProperties: false,
      },
    });
  });

  it('TaskResponse takes a hash task with the digest only the poster sees, or without it', () => {
    const shown = publicVerification({ kind: 'hash', sha256: 'a'.repeat(64) });
    expect(
      TaskResponse.parse({ ...task, verification: shown }).verification,
    ).toEqual({ kind: 'hash' });
    expect(TaskResponse.parse(task).verification).toEqual(task.verification);
    expect(
      TaskResponse.safeParse({
        ...task,
        verification: { kind: 'hash', sha256: 'nope' },
      }).success,
    ).toBe(false);
  });

  it('CredentialResponse prefers seal over credential', () => {
    const seal = 'eyJz.eyJz.c2Vh';
    expect(
      CredentialResponse.parse({ credential: JWS, seal, payload }).credential,
    ).toBe(seal);
    expect(CredentialResponse.parse({ seal, payload }).credential).toBe(seal);
    expect(CredentialResponse.parse({ credential: JWS, payload })).toEqual({
      seal: JWS,
      credential: JWS,
      payload,
    });
    expect(CredentialResponse.safeParse({ payload }).success).toBe(false);
  });

  // The fields the API added with the SEAL routes. CLI 0.3.0 must
  // read every answer that carries them.
  describe('fields added with the SEAL routes', () => {
    const counts = { events: 1, verified_tasks: 2, seed_tasks: 2 };

    it('the SEAL answer with seal beside credential and seed_tasks', () => {
      const seal = 'eyJz.eyJz.c2Vh';
      const got = CredentialResponse.parse({
        credential: seal,
        seal,
        payload: { ...payload, counts },
      });
      expect(got).toEqual({
        seal,
        credential: seal,
        payload: { ...payload, counts },
      });
    });

    it('the check answer with seal beside credential', () => {
      const got = CheckResponse.parse({
        ok: true,
        id: ID,
        handle: 'alice/scout',
        checks: [{ name: 'minVerified', required: 1, actual: 1, ok: true }],
        credential: JWS,
        seal: JWS,
      });
      expect(got.credential).toBe(JWS);
      expect(got.seal).toBe(JWS);
    });

    it('the check answer with seal only, once credential is dropped', () => {
      const got = CheckResponse.parse({
        ok: true,
        id: ID,
        handle: 'alice/scout',
        checks: [{ name: 'minVerified', required: 1, actual: 1, ok: true }],
        seal: JWS,
      });
      expect(got.credential).toBe(JWS);
      expect(got.seal).toBe(JWS);
      expect(
        CheckResponse.safeParse({
          ok: true,
          id: ID,
          handle: 'alice/scout',
          checks: [{ name: 'minVerified', required: 1, actual: 1, ok: true }],
        }).success,
      ).toBe(false);
    });

    it('the check answer with a check name and level added later', () => {
      const got = CheckResponse.parse({
        ok: false,
        id: ID,
        handle: 'alice/scout',
        checks: [
          { name: 'minTenure', required: 30, actual: null, ok: false },
          {
            name: 'minLevel',
            required: 'platinum',
            actual: 'gold',
            ok: false,
          },
        ],
        seal: JWS,
      });
      expect(got.checks.map((c) => c.name)).toEqual(['minTenure', 'minLevel']);
      expect(got.checks[1]?.required).toBe('platinum');
    });

    it('GET by id with counts.seedTasks', () => {
      const got = AgentResponse.parse({
        ...agent,
        counts: { ...agent.counts, seedTasks: 0 },
      });
      expect(got.counts?.seedTasks).toBe(0);
    });

    it('a SEAL payload with seed_tasks', () => {
      expect(CredentialPayload.parse({ ...payload, counts }).counts).toEqual(
        counts,
      );
    });

    it('a version 1 SEAL payload, keeping every field', () => {
      expect(SealClaims.parse(payloadV1)).toEqual(payloadV1);
    });

    it('a version 1 SEAL with a level, kind or scope it does not know yet', () => {
      const later = {
        ...payloadV1,
        level: 'platinum',
        identity: [
          { ...payloadV1.identity[0], kind: 'passkey', scope: 'team' },
        ],
      };
      expect(SealClaims.parse(later).level).toBe('platinum');
    });

    it('a SEAL with agent_version only, once version is dropped', () => {
      const { version: _v, ...rest } = payloadV1;
      expect(SealClaims.safeParse(rest).success).toBe(true);
      const { agent_version: _a, ...neither } = rest;
      expect(SealClaims.safeParse(neither).success).toBe(false);
    });

    it('a minLevel check with levels for required and actual', () => {
      const got = CheckResponse.parse({
        ok: false,
        id: ID,
        handle: 'alice/scout',
        checks: [
          { name: 'minLevel', required: 'silver', actual: 'bronze', ok: false },
        ],
        credential: JWS,
      });
      expect(got.checks[0]?.actual).toBe('bronze');
    });
  });

  it('the API client takes an answer with keys it does not know', async () => {
    const api = createApiClient({
      apiUrl: 'https://api.test',
      fetch: (async () =>
        Response.json({
          ...agent,
          badge: 'https://sealkeeper.run/badge.svg',
        })) as unknown as typeof fetch,
    });
    const got = await api.getAgent(ID);
    expect(got.id).toBe(ID);
    expect(got).not.toHaveProperty('badge');
  });

  it('the API client uses seal from the credential answer', async () => {
    const api = createApiClient({
      apiUrl: 'https://api.test',
      fetch: (async () =>
        Response.json({
          credential: JWS,
          seal: 'eyJz.eyJz.c2Vh',
          payload: { ...payload, badge: 'new' },
        })) as unknown as typeof fetch,
    });
    expect((await api.getCredential(ID)).credential).toBe('eyJz.eyJz.c2Vh');
  });

  it('the API client asks for the SEAL at /seal', async () => {
    const urls: string[] = [];
    const api = createApiClient({
      apiUrl: 'https://api.test',
      fetch: (async (url: string) => {
        urls.push(url);
        return Response.json({ seal: JWS, payload });
      }) as unknown as typeof fetch,
    });
    const got = await api.getCredential(ID);
    expect(urls).toEqual([`https://api.test/v1/agents/${ID}/seal`]);
    expect(got.seal).toBe(JWS);
    expect(got.credential).toBe(JWS);
  });
});

describe('CredentialPayload issuer', () => {
  const legacy = LEGACY_ISSUERS[0];
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts the old issuer until LEGACY_ISSUER_UNTIL, then not', () => {
    vi.useFakeTimers();
    vi.setSystemTime((LEGACY_ISSUER_UNTIL - 1) * 1000);
    expect(
      CredentialPayload.safeParse({ ...payload, iss: legacy }).success,
    ).toBe(true);
    vi.setSystemTime(LEGACY_ISSUER_UNTIL * 1000);
    expect(
      CredentialPayload.safeParse({ ...payload, iss: legacy }).success,
    ).toBe(false);
    expect(CredentialPayload.safeParse(payload).success).toBe(true);
  });

  it('never accepts another issuer', () => {
    expect(
      CredentialPayload.safeParse({ ...payload, iss: 'evil.example' }).success,
    ).toBe(false);
  });
});

describe('runBySealKeeper', () => {
  it('reads operatedBySealKeeper and prefers it over the old name', () => {
    expect(runBySealKeeper({ operatedBySealKeeper: true })).toBe(true);
    expect(
      runBySealKeeper({ operatedBySealKeeper: false, operatedByVouched: true }),
    ).toBe(false);
    expect(
      runBySealKeeper({ operatedBySealKeeper: true, operatedByVouched: false }),
    ).toBe(true);
  });

  it('falls back to operatedByVouched from an older API', () => {
    expect(runBySealKeeper({ operatedByVouched: true })).toBe(true);
    expect(runBySealKeeper({ operatedByVouched: false })).toBe(false);
    expect(runBySealKeeper({})).toBe(false);
  });

  it('keeps both names when AgentResponse parses an answer', () => {
    const both = AgentResponse.parse({
      ...agent,
      operatedBySealKeeper: true,
      operatedByVouched: true,
    });
    expect(both.operatedBySealKeeper).toBe(true);
    expect(runBySealKeeper(both)).toBe(true);
  });
});

describe('agentHandle and operatorSlugOf (VOU-196)', () => {
  const name = 'scout';
  it('takes the handle the API sends', () => {
    expect(
      agentHandle({
        handle: 'alice-dev/scout',
        operator: { login: 'Alice', slug: 'alice-dev' },
        name,
      }),
    ).toBe('alice-dev/scout');
  });

  it('builds the handle from operator.slug when an older API sends none', () => {
    expect(
      agentHandle({ operator: { login: 'Alice', slug: 'alice-dev' }, name }),
    ).toBe('alice-dev/scout');
  });

  it('builds it from the login lowercased when there is no slug either', () => {
    expect(agentHandle({ operator: { login: 'Alice' }, name })).toBe(
      'alice/scout',
    );
  });

  it('reads the slug from operator.slug, then the handle, then the login', () => {
    expect(
      operatorSlugOf({
        handle: 'other/scout',
        operator: { login: 'Alice', slug: 'alice-dev' },
      }),
    ).toBe('alice-dev');
    expect(
      operatorSlugOf({
        handle: 'alice-dev/scout',
        operator: { login: 'Alice' },
      }),
    ).toBe('alice-dev');
    expect(operatorSlugOf({ operator: { login: 'Alice' } })).toBe('alice');
  });

  it('drops a slug that does not have the slug shape, as an answer parses', () => {
    const parsed = AgentResponse.parse({
      ...agent,
      operator: { login: 'Alice', slug: 'Not A Slug' },
    });
    expect(parsed.operator.slug).toBeUndefined();
    expect(operatorSlugOf({ operator: parsed.operator })).toBe('alice');
  });
});

describe('sealWithheldOf', () => {
  it('reads the hold class and the dormant days loosely', () => {
    const held = (reason: unknown) => ({
      error: { code: 'withheld', message: 'm' },
      id: 'x',
      reason,
      extra: true,
    });
    expect(sealWithheldOf(held('safety'))).toEqual({
      kind: 'held',
      reason: 'safety',
    });
    expect(sealWithheldOf(held('new_class'))).toEqual({
      kind: 'held',
      reason: 'new_class',
    });
    for (const reason of [undefined, 3, 'Fraud', 'a b', 'x'.repeat(65)]) {
      expect(sealWithheldOf(held(reason))).toEqual({
        kind: 'held',
        reason: null,
      });
    }
    const noSeal = (dormant_days: unknown) => ({
      error: { code: 'no_seal', message: 'm' },
      dormant_days,
    });
    expect(sealWithheldOf(noSeal(1))).toEqual({
      kind: 'dormant',
      dormantDays: 1,
    });
    for (const days of [null, -1, 1.5, '9']) {
      expect(sealWithheldOf(noSeal(days))).toEqual({
        kind: 'dormant',
        dormantDays: null,
      });
    }
    for (const body of [
      { error: { code: 'not_found', message: 'm' } },
      undefined,
      'withheld',
    ]) {
      expect(sealWithheldOf(body)).toBeNull();
    }
  });

  it('says withheld and why in plain words', () => {
    expect(withheldText({ kind: 'held', reason: 'fraud' })).toBe(
      'withheld for cause, reason fraud',
    );
    expect(withheldText({ kind: 'held', reason: null })).toBe(
      'withheld for cause',
    );
    expect(withheldText({ kind: 'dormant', dormantDays: 1 })).toBe(
      'withheld while the agent is dormant, 1 day',
    );
    expect(withheldText({ kind: 'dormant', dormantDays: 120 })).toBe(
      'withheld while the agent is dormant, 120 days',
    );
    expect(withheldText({ kind: 'dormant', dormantDays: null })).toBe(
      'withheld while the agent is dormant',
    );
  });
});
