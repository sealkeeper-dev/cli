// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createApiClient } from './api.js';
import {
  AgentRenamedResponse,
  AgentResponse,
  CheckResponse,
  CredentialPayload,
  CredentialResponse,
  ErrorResponse,
  EventsBatchResponse,
  ListTasksResponse,
  RatingResponse,
  ScoreResponse,
  SealClaims,
  TaskResponse,
  WellKnown,
} from './responses.js';

const ID = 'A'.repeat(43);
const JWS = 'eyJh.eyJi.c2ln';
const AT = '2026-09-24T10:00:00.000Z';

const agent = {
  id: ID,
  name: 'scout',
  version: '0.1.0',
  operator: { login: 'carelmeyer' },
  createdAt: AT,
  handle: 'carelmeyer/scout',
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
  iss: 'vouched.run',
  sub: ID,
  iat: 1,
  exp: 2,
  version: '0.1.0',
  scores: { reliability: 0.5 },
  counts: { events: 1, verified_tasks: 0 },
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
      handle: 'carelmeyer/scout',
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
      handle: 'carelmeyer/scout',
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

  it('CredentialResponse prefers seal over credential', () => {
    const seal = 'eyJz.eyJz.c2Vh';
    expect(
      CredentialResponse.parse({ credential: JWS, seal, payload }).credential,
    ).toBe(seal);
    expect(CredentialResponse.parse({ seal, payload }).credential).toBe(seal);
    expect(CredentialResponse.parse({ credential: JWS, payload })).toEqual({
      credential: JWS,
      payload,
    });
    expect(CredentialResponse.safeParse({ payload }).success).toBe(false);
  });

  it('the API client takes an answer with keys it does not know', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: (async () =>
        Response.json({
          ...agent,
          badge: 'https://vouched.run/badge.svg',
        })) as unknown as typeof fetch,
    });
    const got = await api.getAgent(ID);
    expect(got.id).toBe(ID);
    expect(got).not.toHaveProperty('badge');
  });

  it('the API client uses seal from the credential answer', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: (async () =>
        Response.json({
          credential: JWS,
          seal: 'eyJz.eyJz.c2Vh',
          payload: { ...payload, badge: 'new' },
        })) as unknown as typeof fetch,
    });
    expect((await api.getCredential(ID)).credential).toBe('eyJz.eyJz.c2Vh');
  });
});
