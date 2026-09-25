// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  AgentHandle,
  AgentId,
  acceptedIssuer,
  Dimension,
  Ed25519PublicKey,
  Jws,
  SEAL_MAX_TTL_SECONDS,
  Sha256Hex,
  TaskState,
  TaskType,
  Version,
} from '@sealkeeper/schema';
import { z } from 'zod';

// The schemas the CLI reads API answers with. @sealkeeper/schema defines
// the same answers strictly, which is right for the API that sends them but
// wrong for a CLI already on people's machines. A strict CLI refuses an
// answer the moment the API adds a field, so every object here is z.object,
// which drops keys it does not know. Requests the CLI sends keep the strict
// schemas from @sealkeeper/schema. Values keep their exact checks, only
// unknown keys are let through.

const Timestamp = z.iso.datetime();
const Count = z.int().min(0);
const Seconds = z.int().min(0);
const Name = z.string().min(1).max(64);
const Operator = z.object({ login: z.string().min(1).max(39) });

const AgentCounts = z.object({
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
  operatedBySealKeeper: z.boolean().optional(),
  // The old name, still sent by the API beside the new one. Read when the
  // new one is missing, which an API from before VOU-118 does.
  operatedByVouched: z.boolean().optional(),
  handle: AgentHandle.optional(),
  previousName: Name.nullable().optional(),
  counts: AgentCounts.optional(),
  lastSeenAt: Timestamp.nullable().optional(),
});
export type AgentResponse = z.infer<typeof AgentResponse>;

// True for an agent SealKeeper runs itself, such as the seed agent. Prefers
// the new field and falls back to the old one.
export function runBySealKeeper(
  agent: Pick<AgentResponse, 'operatedBySealKeeper' | 'operatedByVouched'>,
): boolean {
  return agent.operatedBySealKeeper ?? agent.operatedByVouched ?? false;
}

export const EventsBatchResponse = z.object({
  accepted: Count,
  duplicates: Count,
});
export type EventsBatchResponse = z.infer<typeof EventsBatchResponse>;

// Size limits are the API's business when it stores a task. Reading one
// back only needs the shape.
const VerificationSpec = z.discriminatedUnion('kind', [
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
  // The poster's operator, when the API sends it. prove skips tasks posted
  // by the operator's own agents, which never count.
  posterOperator: Operator.optional(),
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

const ScoreEntry = z.object({
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

// One identity attestation reference in a SEAL, loose. Text fields stay
// text, so a kind or scope added later does not break an older CLI.
const IdentityClaim = z.object({
  provider: z.string(),
  kind: z.string(),
  ref: z.string(),
  subject_hash: z.string(),
  attested_at: Seconds,
  scope: z.string(),
});
export type IdentityClaim = z.infer<typeof IdentityClaim>;

// The claims inside a SEAL, version 1 or the legacy shape without ver. iss
// is any text here so seal verify can name a wrong issuer instead of
// calling the SEAL malformed. scores takes any dimension name and level any
// text, so a dimension or level added later does not break an older CLI.
// Every field version 1 added is optional, since a legacy SEAL has none of
// them. Whether the ver is one this CLI understands is checked before
// these, with sealVersionProblem from @sealkeeper/schema.
const sealClaims = {
  sub: AgentId,
  ver: z.int().optional(),
  iat: Seconds,
  exp: Seconds,
  agent_version: Version.optional(),
  // agent_version under its old name, sent beside it for one release.
  version: Version.optional(),
  level: z.string().optional(),
  // Each score 0 to 1 or null, as the standard says.
  scores: z.record(z.string(), z.number().min(0).max(1).nullable()),
  // seed_tasks is optional, since a SEAL issued before it was added has
  // none. The other five arrived with version 1.
  counts: z.object({
    events: Count,
    verified_tasks: Count,
    seed_tasks: Count.optional(),
    history_days: Count.optional(),
    server_checked_tasks: Count.optional(),
    confirmed_tasks: Count.optional(),
    distinct_operators: Count.optional(),
    safety_incidents_90d: Count.optional(),
  }),
  operator: z.object({ verified: z.boolean() }).optional(),
  identity: z.array(IdentityClaim).optional(),
  last_active: Seconds.nullable().optional(),
  dormant_days: Count.nullable().optional(),
};
// exp after iat and at most 24 hours after it, standard section 2.
const expAfterIat = (c: { iat: number; exp: number }) =>
  c.exp > c.iat && c.exp - c.iat <= SEAL_MAX_TTL_SECONDS;
const hasAgentVersion = (c: { agent_version?: string; version?: string }) =>
  c.agent_version !== undefined || c.version !== undefined;

export const SealClaims = z
  .object({ iss: z.string(), ...sealClaims })
  .refine(expAfterIat, 'exp must be after iat and within 24 hours of it')
  .refine(hasAgentVersion, 'expected agent_version or version');
export type SealClaims = z.infer<typeof SealClaims>;

// The same claims with the issuer checked. It accepts what acceptedIssuer
// accepts at the time of the read, so sealkeeper.run always and the old
// issuer only until LEGACY_ISSUER_UNTIL. The rest stays loose.
export const CredentialPayload = z
  .object({
    iss: z
      .string()
      .refine((iss) => acceptedIssuer(iss, Date.now() / 1000), 'wrong issuer'),
    ...sealClaims,
  })
  .refine(expAfterIat, 'exp must be after iat and within 24 hours of it')
  .refine(hasAgentVersion, 'expected agent_version or version');
export type CredentialPayload = z.infer<typeof CredentialPayload>;

// GET /v1/agents/:id/seal, and /credential, its old path. Both answers
// carry the same compact JWS as seal and as credential for one release,
// then credential goes. The CLI takes seal when it is there, else
// credential, and hands on the one string under both names, so code that
// reads either keeps working through the change.
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
  .transform((r) => {
    const jws = (r.seal ?? r.credential) as string;
    return { seal: jws, credential: jws, payload: r.payload };
  });
export type CredentialResponse = z.infer<typeof CredentialResponse>;

const WellKnownKey = z.object({
  kid: z.string().min(1).max(128),
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  alg: z.literal('EdDSA'),
  x: Ed25519PublicKey,
});

// The keys document at WELL_KNOWN_PATH, the keys SEALs are signed with.
export const WellKnown = z.object({
  keys: z.array(WellKnownKey).min(1).max(16),
});
export type WellKnown = z.infer<typeof WellKnown>;

// One check of GET /v1/check, read loosely like every other answer. name,
// required and actual take any text, so a check or a level the API adds
// later does not break this version. The names today are minVerified,
// maxIncidents, minReliability, minSafety and minLevel, and minLevel is the
// one whose required and actual are levels (none, bronze, silver, gold).
export type Check = {
  name: string;
  required: number | string;
  actual: number | string | null;
  ok: boolean;
};
export const Check: z.ZodType<Check> = z.object({
  name: z.string().min(1),
  required: z.union([z.number().min(0), z.string()]),
  actual: z.union([z.number().min(0), z.string()]).nullable(),
  ok: z.boolean(),
});

// GET /v1/check/:login/:name. The agent's SEAL comes as seal and, for one
// release, as credential too. Either is enough, and the answer
// hands the one string on under both names, like CredentialResponse. After
// 90 dormant days the API withholds the SEAL. Both are then null and a
// failing check named seal, actual withheld, says why, so ok is false.
export type CheckResponse = {
  ok: boolean;
  id: string;
  handle: string;
  checks: Check[];
  seal: string | null;
  credential: string | null;
};
const withheld = (checks: Check[]) =>
  checks.some((c) => c.name === 'seal' && c.actual === 'withheld' && !c.ok);
export const CheckResponse: z.ZodType<CheckResponse, unknown> = z
  .object({
    ok: z.boolean(),
    id: AgentId,
    handle: AgentHandle,
    checks: z.array(Check).min(1),
    seal: Jws.nullable().optional(),
    credential: Jws.nullable().optional(),
  })
  .refine(
    (r) => (r.seal ?? r.credential ?? null) !== null || withheld(r.checks),
    'expected seal or credential',
  )
  .refine(
    (r) => (r.seal ?? r.credential ?? null) !== null || !r.ok,
    'an answer without a SEAL never passes',
  )
  .transform(({ seal, credential, ...rest }) => {
    const jws = seal ?? credential ?? null;
    return { ...rest, seal: jws, credential: jws };
  });

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
