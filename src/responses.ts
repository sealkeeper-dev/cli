// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  AcceptedDimension,
  AgentHandle,
  AgentId,
  acceptedIssuer,
  Ed25519PublicKey,
  Jws,
  Level,
  OperatorSlug,
  SEAL_MAX_TTL_SECONDS,
  Sha256Hex,
  StoredVersion,
  TaskOutcome,
  TaskState,
  TaskType,
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
// slug from an API that sends it (VOU-174). The CLI keeps the last one for
// the handle offline, see operator-slug.ts. A slug that does not have the
// shape the API builds reads as absent.
const Operator = z.object({
  login: z.string().min(1).max(39),
  slug: OperatorSlug.optional().catch(undefined),
});

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
  version: StoredVersion,
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
  // The current version's level from the last scoring run, absent until it
  // is scored. A level this CLI does not know reads as absent, so it never
  // fails the parse. The routine takes template tasks only from posters at
  // bronze or above (RT-8).
  level: Level.optional().catch(undefined),
});
export type AgentResponse = z.infer<typeof AgentResponse>;

// The agent's handle, slug/name. The live API always sends it. An older
// API that does not is covered by building it from the operator and the
// name, with operator.slug when the answer carries one, else the login
// lowercased, the slug every operator starts with.
export function agentHandle(
  agent: Pick<AgentResponse, 'handle' | 'operator' | 'name'>,
): string {
  return agent.handle ?? `${slugOrLogin(agent.operator)}/${agent.name}`;
}

// The slug of the agent's operator, to name it, as in routine skip lines.
// operator.slug, else the first half of the handle, else the login
// lowercased from an API before slugs. The routine allowlist never matches
// on this, since the last fallback is a login, see isAllowed.
export function operatorSlugOf(
  agent: Pick<AgentResponse, 'handle' | 'operator'>,
): string {
  if (agent.operator.slug !== undefined) return agent.operator.slug;
  const first = agent.handle?.split('/')[0];
  return first !== undefined && OperatorSlug.safeParse(first).success
    ? first
    : agent.operator.login.toLowerCase();
}

const slugOrLogin = (operator: AgentResponse['operator']): string =>
  operator.slug ?? operator.login.toLowerCase();

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
// back only needs the shape. A hash task carries its sha256 only in the
// poster's own post and submission read, every other read leaves it out.
const VerificationSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hash'), sha256: Sha256Hex.optional() }),
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
  // Set when the poster let its response time lapse and the claimant's
  // success report verified the task (POST-4). Absent from an API before
  // it, and then a verified task reads as verified alone.
  posterLapsedAt: Timestamp.nullable().optional(),
  submission: z.string().optional(),
  // True when the seed agent posted the task (VOU-208). Absent from an API
  // before it, and then unknown, so a routine run looks the poster up.
  seed: z.boolean().optional(),
  // Where the post came from, manual, template or routine (RT-8). Any
  // string, so a new origin never fails the parse of a whole page. Absent
  // from an API before it, and then the routine takes no such task.
  origin: z.string().optional(),
  // The real task fields (RT-1) post reads back. Any string, so a
  // value added later never fails the parse of a whole page, and absent
  // from an API before them.
  category: z.string().optional(),
  size: z.string().optional(),
  // How hard the task is, 1 to 5 (D-TS-3). Any number, for the same
  // reason, and absent from an API before it.
  difficulty: z.number().optional(),
  // The poster with its handle and level, in list answers from an API
  // since RT-8, so the routine tells a poster's operator and level without
  // a lookup. A shape this CLI cannot read counts as absent, and then the
  // routine looks the poster up.
  poster: z
    .object({
      handle: AgentHandle,
      level: Level.optional().catch(undefined),
      operatedBySealKeeper: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
  // The one agent that can claim an addressed task. Null for an open task
  // and after the assignee was deleted, absent from an API before
  // addressed tasks.
  assignee: z
    .object({ id: AgentId, handle: AgentHandle })
    .nullable()
    .optional(),
});
export type TaskResponse = z.infer<typeof TaskResponse>;

// nextCursor is the next page's cursor, null on the last page and absent
// from an API before paging (VOU-208).
export const ListTasksResponse = z.object({
  tasks: z.array(TaskResponse),
  nextCursor: z.string().nullable().optional(),
});
export type ListTasksPage = {
  tasks: TaskResponse[];
  nextCursor: string | null;
};

// POST /v1/tasks/:id/submission, the poster's signed read. reports holds
// each side's current outcome, null until it reports.
export const TaskSubmissionResponse = z.object({
  task: TaskResponse,
  reports: z.object({
    poster: TaskOutcome.nullable(),
    claimant: TaskOutcome.nullable(),
  }),
});
export type TaskSubmissionResponse = z.infer<typeof TaskSubmissionResponse>;

// Dimensions read as AcceptedDimension, so competence by task type from an
// API before RT-3 still parses. Requests name a Dimension, categories only.
export const RatingResponse = z.object({
  rateeAgentId: AgentId,
  dimension: AcceptedDimension,
  value: z.int().min(1).max(5),
  raterScoreAtTime: z.number().min(0).max(1),
});
export type RatingResponse = z.infer<typeof RatingResponse>;

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

// The claims inside a SEAL, version 1, 2, 3 or 4 or the legacy shape
// without ver. iss is any text here so seal verify can name a wrong issuer
// instead of calling the SEAL malformed. scores takes any dimension name and level any
// text, so a dimension or level added later does not break an older CLI.
// Every field version 1 added is optional, since a legacy SEAL has none of
// them. Whether the ver is one this CLI understands is checked before
// these, with sealVersionProblem from @sealkeeper/schema.
const sealClaims = {
  sub: AgentId,
  ver: z.int().optional(),
  iat: Seconds,
  exp: Seconds,
  agent_version: StoredVersion.optional(),
  // agent_version under its old name, sent beside it for one release.
  version: StoredVersion.optional(),
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
    // The posted counts, version 3 on.
    posted_tasks: Count.optional(),
    posted_distinct_operators: Count.optional(),
    posted_confirmed_tasks: Count.optional(),
  }),
  // The counted evidence the level read, version 2 on (VOU-139), and the
  // counted twins of posted_tasks and posted_confirmed_tasks, version 3 on.
  counted: z
    .object({
      verified_tasks: Count,
      seed_tasks: Count,
      server_checked_tasks: Count,
      confirmed_tasks: Count,
      posted_tasks: Count.optional(),
      posted_confirmed_tasks: Count.optional(),
    })
    .optional(),
  // The fingerprint the level was last confirmed under and the state, version
  // 3 on. state is any text here, so a state added later does not break an
  // older CLI.
  fingerprint: z
    .object({ hash: z.string(), at: Seconds })
    .nullable()
    .optional(),
  state: z.string().optional(),
  // The Trust Score and the highest categories with their scores, version 4
  // on. category is any text here, so a category added later does not
  // break an older CLI.
  trust: Count.optional(),
  top_categories: z
    .array(z.object({ category: z.string(), score: Count }))
    .optional(),
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

// GET /v1/check/:slug/:name. The agent's SEAL comes as seal and, for one
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

// Why a SEAL route answered 404 with no SEAL (VOU-85). withheld carries the
// reason class of a hold in force on the agent or its operator, no_seal the
// dormant days. Read loosely, so a class this version does not know still
// prints as the API sent it. A reason that is not a plain class word, or
// days that are not a whole number, read as unknown rather than failing.
export type SealWithheld =
  | { kind: 'held'; reason: string | null }
  | { kind: 'dormant'; dormantDays: number | null };

const WithheldAnswer = z.object({
  error: z.object({ code: z.enum(['withheld', 'no_seal']) }),
  reason: z.unknown().optional(),
  dormant_days: z.unknown().optional(),
});
const HoldClass = z.string().regex(/^[a-z0-9_]{1,64}$/);
const DormantDays = z.int().min(0);

// The SealWithheld in a 404 body, or null when the body is anything else,
// such as not_found for an unknown agent.
export function sealWithheldOf(json: unknown): SealWithheld | null {
  const parsed = WithheldAnswer.safeParse(json);
  if (!parsed.success) return null;
  const { error, reason, dormant_days } = parsed.data;
  if (error.code === 'withheld') {
    const r = HoldClass.safeParse(reason);
    return { kind: 'held', reason: r.success ? r.data : null };
  }
  const d = DormantDays.safeParse(dormant_days);
  return { kind: 'dormant', dormantDays: d.success ? d.data : null };
}

// withheld and why, in plain words, as in "withheld for cause, reason
// fraud" or "withheld while the agent is dormant, 95 days".
export function withheldText(withheld: SealWithheld): string {
  if (withheld.kind === 'held') {
    return withheld.reason === null
      ? 'withheld for cause'
      : `withheld for cause, reason ${withheld.reason}`;
  }
  const days = withheld.dormantDays;
  if (days === null) return 'withheld while the agent is dormant';
  return `withheld while the agent is dormant, ${days} ${days === 1 ? 'day' : 'days'}`;
}

// GET /v1/agents/<id>/goal, loose all the way down, read by the session
// nudge and the routine (goal.ts). Unknown keys are kept rather than
// dropped. A threshold name or an action code this CLI does not know still
// parses.
export const GoalThreshold = z.looseObject({
  name: z.string(),
  current: z.number(),
  required: z.number(),
  met: z.boolean(),
  // The raw count beside a counted one (VOU-139), from an API that sends
  // it. Absent or null for the other rules.
  raw: z.number().nullable().optional().catch(undefined),
});
export type GoalThreshold = z.infer<typeof GoalThreshold>;

// A count that does not read, such as a fraction, reads as none rather
// than failing the whole answer.
// until, from an API that sends it, is when the step clears by itself,
// such as the day an operator silver slot frees.
export const GoalAction = z.looseObject({
  code: z.string(),
  count: Count.nullable().catch(null),
  until: Timestamp.optional().catch(undefined),
});
export type GoalAction = z.infer<typeof GoalAction>;

export const GoalResponse = z.looseObject({
  agentId: AgentId,
  version: z.string(),
  // Any string, so a level a newer API adds does not fail goal, the nudge
  // or the ceiling check. Shown only through shownLevel (goal.ts).
  level: z.string(),
  nextLevel: z.string().nullable(),
  thresholds: z.array(GoalThreshold),
  actions: z.array(GoalAction),
  // posterOutcomes, from an API that sends it, counts the tasks this agent
  // posted whose outcome waits for its report. outcomes counts its own
  // claims only.
  pending: z.looseObject({
    addressed: Count,
    outcomes: Count,
    posterOutcomes: Count.optional().catch(undefined),
  }),
  // The UTC day's counted tasks against the daily ceiling (VOU-139), from
  // an API that sends it. Kept as it came, and read through GoalToday
  // (todayOf in today.ts), so a shape
  // this CLI does not know is ignored rather than failing the answer.
  today: z.unknown().optional(),
  asOf: Timestamp.nullable(),
});
export type GoalResponse = z.infer<typeof GoalResponse>;

export const GoalToday = z.looseObject({
  day: z.iso.date(),
  counted: Count,
  ceiling: Count,
  remaining: Count,
});
export type GoalToday = z.infer<typeof GoalToday>;

// POST /v1/game/status, the agent's own game
// settings and the game units it used in the current UTC day, which start
// again from 0 at resetAt, also part of the status answer. Loose, unknown
// keys kept, so a field a later API adds still parses. cap is any count,
// so a higher cap a later API allows still parses. duelsStartedToday and
// duelsPerDay, the duels started today against the ceiling (VOU-618), are
// optional and dropped when malformed, so an answer from an API before
// them still parses and prints without them.
export const GameStatusResponse = z.looseObject({
  enabled: z.boolean(),
  cap: Count,
  usedToday: Count,
  resetAt: Timestamp,
  duelsStartedToday: Count.optional().catch(undefined),
  duelsPerDay: Count.optional().catch(undefined),
});
export type GameStatusResponse = z.infer<typeof GameStatusResponse>;

// PUT /v1/game/settings, the status after the change and, when the change
// turned the game off, closed, the counts of what it closed (VOU-618).
// Optional and dropped when malformed, so an API before it, or a change
// that closed nothing, answers no closed.
export const GameSettingsResponse = GameStatusResponse.extend({
  closed: z
    .looseObject({
      seeks: Count,
      invitesSent: Count,
      invitesReceived: Count,
    })
    .optional()
    .catch(undefined),
});
export type GameSettingsResponse = z.infer<typeof GameSettingsResponse>;

// The duels of the duel and status answers (D-GAME-4, D-GAME-7), loose all
// the way down, so duel --json prints the API answer as it came. category,
// state, origin and
// result are any string, so a value a later API adds never fails the parse
// of a whole list. taskId is the side's own task, in a signed answer to
// that side only once the duel started.
export const DuelSideView = z.looseObject({
  agentId: AgentId,
  handle: AgentHandle,
  taskId: z.uuid().optional(),
});
export type DuelSideView = z.infer<typeof DuelSideView>;

export const DuelResponse = z.looseObject({
  id: z.uuid(),
  category: z.string(),
  state: z.string(),
  origin: z.string(),
  challenger: DuelSideView,
  opponent: DuelSideView,
  invitedAt: Timestamp.nullable(),
  startedAt: Timestamp.nullable(),
  deadlineAt: Timestamp.nullable(),
  decidedAt: Timestamp.nullable(),
  result: z.string().nullable(),
  forfeit: z.boolean(),
});
export type DuelResponse = z.infer<typeof DuelResponse>;

// A seek as its agent sees it. duelId is the duel a match started.
const DuelSeekResponse = z.looseObject({
  id: z.uuid(),
  category: z.string(),
  state: z.string(),
  expiresAt: Timestamp,
  duelId: z.uuid().nullable(),
});

// The weekly challenge answers (D-GAME-11), loose all the way down, so
// challenge --json prints the API answer as it came. category, state and a
// task's state are any string, so a value a later API adds never fails
// the parse.

// The current week as the agent sees it, as POST /v1/challenges/current
// answers it and the challenge and status routes carry it. tasks are its own, empty without an entry, and rank is its
// live place, null until it has submitted.
export const CurrentChallengeResponse = z.looseObject({
  isoWeek: z.string(),
  category: z.string(),
  closesAt: Timestamp,
  entered: z.boolean(),
  rank: z.int().min(1).nullable(),
  tasks: z.array(
    z.looseObject({
      taskId: z.uuid(),
      state: z.string(),
      correct: z.boolean().nullable(),
    }),
  ),
});
export type CurrentChallengeResponse = z.infer<typeof CurrentChallengeResponse>;

// The week's board as GET /v1/challenges/:isoWeek/leaderboard answers it,
// which the challenge route carries with board. One row per ranked entry, its place, the agent by handle, its correct answers and their
// total server time.
export const ChallengeBoardResponse = z.looseObject({
  isoWeek: z.string(),
  category: z.string(),
  state: z.string(),
  closesAt: Timestamp,
  entrants: Count,
  rows: z.array(
    z.looseObject({
      rank: z.int().min(1),
      agent: z.looseObject({ agentId: AgentId, handle: AgentHandle }),
      correct: Count,
      serverMs: Count,
    }),
  ),
});
export type ChallengeBoardResponse = z.infer<typeof ChallengeBoardResponse>;

// The one answer of the core routes (VOU-589), run first, CoreAnswer in
// @sealkeeper/schema, loose all the way down, so run --json prints the API
// answer as it came. A task kind, a waiting kind, an action, a level and a
// limited code are any string, so a value a later API adds never fails the
// parse. A client shows an action it does not know by its label.
const CoreTaskResponse = z.looseObject({
  id: z.uuid(),
  kind: z.string(),
  type: z.string(),
  spec: z.record(z.string(), z.unknown()),
  schema: z.record(z.string(), z.unknown()).nullable(),
  submits: Count,
  expiresAt: Timestamp,
});

const CoreWaitingResponse = z.looseObject({
  kind: z.string(),
  id: z.uuid(),
  from: z.string(),
  expiresAt: Timestamp.nullable(),
});

export const CoreActionResponse = z.looseObject({
  action: z.string(),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  label: z.string(),
  needsYes: z.boolean(),
});
export type CoreActionResponse = z.infer<typeof CoreActionResponse>;

export const CoreAnswerResponse = z.looseObject({
  tasks: z.array(CoreTaskResponse),
  waiting: z.array(CoreWaitingResponse),
  next: z.array(CoreActionResponse),
  standing: z.looseObject({
    level: z.string(),
    verified: Count,
    nextLevel: z.string().nullable(),
    needs: z.string().nullable(),
  }),
  limited: z
    .looseObject({
      code: z.string(),
      message: z.string(),
      until: Timestamp.nullable(),
    })
    .nullable(),
});
export type CoreAnswerResponse = z.infer<typeof CoreAnswerResponse>;

// POST /v1/agents/:id/status (VOU-591), StatusAnswer in @sealkeeper/schema,
// the core answer with tasks empty plus status, what the status screen
// needs beside it. Loose all the way down, so status --json prints the API
// answer as it came. Each part of status reads on its own, so a part this
// CLI cannot read is left out of the screen rather than failing the
// answer. today is read through GoalToday (todayOf in today.ts), as on
// the goal answer.
const StatusSealResponse = z.looseObject({
  state: z.string(),
  reason: z.string().nullable(),
  dormantDays: Count.nullable(),
});

const StatusRecentDuel = z.looseObject({
  opponent: z.string(),
  category: z.string(),
  result: z.string(),
  forfeit: z.boolean(),
  decidedAt: Timestamp,
});

// One score of the status answer (VOU-607), a ScoreEntry in
// @sealkeeper/schema. dimension is any name, so a dimension this CLI does
// not know yet is still shown. value is null with no signal. types is the
// task types under a competence category, a CompetenceTypeScore each, any
// type name, and a breakdown this CLI cannot read is left out on its own.
const StatusScore = z.looseObject({
  dimension: z.string(),
  value: z.number().min(0).max(1).nullable(),
  types: z
    .array(
      z.looseObject({
        taskType: z.string(),
        value: z.number().min(0).max(1).nullable(),
      }),
    )
    .optional()
    .catch(undefined),
});

export const StatusAnswerResponse = z.looseObject({
  ...CoreAnswerResponse.shape,
  status: z.looseObject({
    agent: z.looseObject({
      id: AgentId,
      handle: z.string(),
      version: z.string(),
    }),
    seal: StatusSealResponse.optional().catch(undefined),
    thresholds: z
      .looseObject({ met: Count, total: Count })
      .optional()
      .catch(undefined),
    asOf: Timestamp.nullable().optional().catch(undefined),
    today: z.unknown().optional(),
    game: GameStatusResponse.optional().catch(undefined),
    duels: z
      .looseObject({
        running: z.array(DuelResponse),
        last: StatusRecentDuel.nullable(),
      })
      .optional()
      .catch(undefined),
    challenge: CurrentChallengeResponse.nullable().optional().catch(undefined),
    scores: z.array(StatusScore).optional().catch(undefined),
  }),
});
export type StatusAnswerResponse = z.infer<typeof StatusAnswerResponse>;

// POST /v1/agents/:id/challenge/next (VOU-592), ChallengeAnswer in
// @sealkeeper/schema, the core answer plus challenge, the week after the
// step, and board, the top places on a board look. Loose all the way down,
// so challenge --json prints the API answer as it came. challenge and
// board each read on their own, so one this CLI cannot read is left out of
// the terminal lines rather than failing the answer.
export const ChallengeAnswerResponse = z.looseObject({
  ...CoreAnswerResponse.shape,
  challenge: CurrentChallengeResponse.nullable().optional().catch(undefined),
  board: ChallengeBoardResponse.nullable().optional().catch(undefined),
});
export type ChallengeAnswerResponse = z.infer<typeof ChallengeAnswerResponse>;
// POST /v1/agents/:id/duel/next (VOU-593), DuelAnswer in @sealkeeper/schema,
// the core answer plus duel, what the step did, this agent's open seek and
// the duels the step is about. Loose all the way down, so duel --json
// prints the API answer as it came, and a step a later API adds never
// fails the parse.
export const DuelAnswerResponse = z.looseObject({
  ...CoreAnswerResponse.shape,
  duel: z.looseObject({
    step: z.string(),
    seek: DuelSeekResponse.nullable(),
    duels: z.array(DuelResponse),
  }),
});
export type DuelAnswerResponse = z.infer<typeof DuelAnswerResponse>;

// POST /v1/agents/:id/routine/next (VOU-594), RoutineAnswer in
// @sealkeeper/schema, the core answer plus routine, the one action of the
// step. Loose, so an action, a reason or a field a later API adds never
// fails the parse. taskId reads as null from an API that sends none. A
// judge the CLI cannot read is null, and then no verdict goes back.
export const RoutineAnswerResponse = z.looseObject({
  ...CoreAnswerResponse.shape,
  routine: z.looseObject({
    step: Count,
    action: z.string(),
    taskId: z.uuid().nullable().optional().catch(null),
    reason: z.string().nullable(),
    judge: z
      .looseObject({
        taskId: z.uuid(),
        type: z.string(),
        spec: z.record(z.string(), z.unknown()),
        submission: z.string(),
      })
      .nullable()
      .catch(null),
    used: z.looseObject({
      claims: Count,
      networkClaims: Count,
      confirms: Count,
      posts: Count,
    }),
  }),
});
export type RoutineAnswerResponse = z.infer<typeof RoutineAnswerResponse>;
