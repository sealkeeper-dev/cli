// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  AgentHandle,
  AgentId,
  CheckName,
  CREDENTIAL_ISSUER,
  Dimension,
  Ed25519PublicKey,
  Jws,
  Sha256Hex,
  TaskState,
  TaskType,
  Version,
} from '@vouched-dev/schema';
import { z } from 'zod';

// The schemas the CLI reads API answers with. @vouched-dev/schema defines
// the same answers strictly, which is right for the API that sends them but
// wrong for a CLI already on people's machines. A strict CLI refuses an
// answer the moment the API adds a field, so every object here is z.object,
// which drops keys it does not know. Requests the CLI sends keep the strict
// schemas from @vouched-dev/schema. Values keep their exact checks, only
// unknown keys are let through.

const Timestamp = z.iso.datetime();
const Count = z.int().min(0);
const Seconds = z.int().min(0);
const Name = z.string().min(1).max(64);
const Operator = z.object({ login: z.string().min(1).max(39) });

export const AgentCounts = z.object({
  events: Count,
  verifiedTasks: Count,
  seedTasks: Count.optional(),
  incidents: Count,
  sessions: Count,
  toolCalls: Count,
});

// GET /v1/agents/:id, the registration answer and the rename answer.
export const AgentResponse = z.object({
  id: AgentId,
  name: Name,
  version: Version,
  operator: Operator,
  createdAt: Timestamp,
  operatedByVouched: z.boolean().optional(),
  handle: AgentHandle.optional(),
  previousName: Name.nullable().optional(),
  counts: AgentCounts.optional(),
  lastSeenAt: Timestamp.nullable().optional(),
});
export type AgentResponse = z.infer<typeof AgentResponse>;

export const EventsBatchResponse = z.object({
  accepted: Count,
  duplicates: Count,
});
export type EventsBatchResponse = z.infer<typeof EventsBatchResponse>;

// Size limits are the API's business when it stores a task. Reading one
// back only needs the shape.
export const VerificationSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hash'), sha256: Sha256Hex }),
  z.object({
    kind: z.literal('schema'),
    jsonSchema: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('counterparty') }),
]);

export const TaskResponse = z.object({
  id: z.uuid(),
  posterAgentId: AgentId,
  claimantAgentId: AgentId.nullable(),
  taskType: TaskType,
  spec: z.record(z.string(), z.unknown()),
  verification: VerificationSpec,
  state: TaskState,
  postedAt: Timestamp,
  claimedAt: Timestamp.nullable(),
  submittedAt: Timestamp.nullable(),
  verifiedAt: Timestamp.nullable(),
  expiresAt: Timestamp,
  submission: z.string().optional(),
});
export type TaskResponse = z.infer<typeof TaskResponse>;

export const ListTasksResponse = z.object({ tasks: z.array(TaskResponse) });

export const RatingResponse = z.object({
  rateeAgentId: AgentId,
  dimension: Dimension,
  value: z.int().min(1).max(5),
  raterScoreAtTime: z.number().min(0).max(1),
});
export type RatingResponse = z.infer<typeof RatingResponse>;

export const ScoreEntry = z.object({
  version: Version,
  dimension: Dimension,
  value: z.number().min(0).max(1).nullable(),
  windowStart: Timestamp.nullable(),
  windowEnd: Timestamp.nullable(),
  computedAt: Timestamp.nullable(),
});

export const ScoreResponse = z.object({
  agentId: AgentId,
  scores: z.array(ScoreEntry),
});
export type ScoreResponse = z.infer<typeof ScoreResponse>;

// The claims inside a SEAL. iss is any text here so seal verify can name a
// wrong issuer instead of calling the SEAL malformed. scores takes any
// dimension name, so a dimension added later does not break an older CLI.
const sealClaims = {
  sub: AgentId,
  iat: Seconds,
  exp: Seconds,
  version: Version,
  scores: z.record(z.string(), z.number().nullable()),
  counts: z.object({ events: Count, verified_tasks: Count }),
};
const expAfterIat = (c: { iat: number; exp: number }) => c.exp > c.iat;

export const SealClaims = z
  .object({ iss: z.string(), ...sealClaims })
  .refine(expAfterIat, 'exp must be after iat');
export type SealClaims = z.infer<typeof SealClaims>;

// The same claims with the issuer pinned to vouched.run.
export const CredentialPayload = z
  .object({ iss: z.literal(CREDENTIAL_ISSUER), ...sealClaims })
  .refine(expAfterIat, 'exp must be after iat');
export type CredentialPayload = z.infer<typeof CredentialPayload>;

// GET /v1/agents/:id/credential. The API adds seal next to credential, both
// the same compact JWS. The CLI takes seal when it is there, else
// credential, and hands on one string as credential.
export const CredentialResponse = z
  .object({
    credential: Jws.optional(),
    seal: z.string().optional(),
    payload: CredentialPayload,
  })
  .refine(
    (r) => r.seal !== undefined || r.credential !== undefined,
    'expected seal or credential',
  )
  .transform((r) => ({
    credential: (r.seal ?? r.credential) as string,
    payload: r.payload,
  }));
export type CredentialResponse = z.infer<typeof CredentialResponse>;

export const WellKnownKey = z.object({
  kid: z.string().min(1).max(128),
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  alg: z.literal('EdDSA'),
  x: Ed25519PublicKey,
});

// /.well-known/vouched.json, the keys SEALs are signed with.
export const WellKnown = z.object({
  keys: z.array(WellKnownKey).min(1).max(16),
});
export type WellKnown = z.infer<typeof WellKnown>;

export const Check = z.object({
  name: CheckName,
  required: z.number().min(0),
  actual: z.number().min(0).nullable(),
  ok: z.boolean(),
});
export type Check = z.infer<typeof Check>;

// GET /v1/check/:login/:name. credential is the agent's SEAL.
export const CheckResponse = z.object({
  ok: z.boolean(),
  id: AgentId,
  handle: AgentHandle,
  checks: z.array(Check).min(1),
  credential: Jws,
});
export type CheckResponse = z.infer<typeof CheckResponse>;

export const AgentRenamedResponse = z.object({
  error: z.object({ code: z.literal('renamed'), message: z.string() }),
  id: AgentId,
  handle: AgentHandle,
});

export const ErrorIssue = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  message: z.string(),
});
export type ErrorIssue = z.infer<typeof ErrorIssue>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(ErrorIssue).optional(),
  }),
});
