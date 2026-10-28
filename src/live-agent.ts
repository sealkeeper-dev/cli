// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  AgentNameShape,
  FingerprintPartState,
  LEVEL_RANK,
  Level,
  OperatorSlug,
  Runtime,
  Sha256Base64url,
} from '@sealkeeper/schema';
import { z } from 'zod';
import { ApiError, createApiClient, savedApiUrl } from './api.js';
import type { Config } from './config.js';
import { stderr } from './output.js';
import { LiveSealState } from './responses.js';
import { SCORE_TIMEOUT_MS } from './score.js';

// Where the agent stands on SealKeeper, as init reads it.
// The verified count and the level come live from GET /v1/agents/<id>, the
// same numbers the public profile shows.

// A fingerprint as the agent answer carries it, read loosely. Absent when it
// is missing or does not parse, a part state this version does not know
// included.
const LiveFingerprint = z
  .object({
    hash: Sha256Base64url,
    at: z.iso.datetime(),
    parts: z.object({
      model_set: FingerprintPartState,
      prompt: FingerprintPartState,
      tools: FingerprintPartState,
      framework: FingerprintPartState,
    }),
  })
  .nullable()
  .optional()
  .catch(undefined);

// The part of GET /v1/agents/<id> the CLI reads here. level is optional on the
// answer, since an agent may have none yet. Read loosely, so a field that fails
// to parse costs only that field.
export const LiveAgent = z.object({
  counts: z
    .object({ verifiedTasks: z.int().min(0) })
    .optional()
    .catch(undefined),
  level: Level.optional().catch(undefined),
  // The handle and the operator slug it is built from, for the first sign up,
  // and the runtime, for the one time runtime question. A runtime this version
  // does not know reads as absent. Both are printed and the handle goes into
  // the profile URL, so each must have the shape AgentHandle and OperatorSlug
  // give, or it reads as absent.
  handle: z
    .string()
    .refine((handle) => {
      const [slug, name, ...rest] = handle.split('/');
      return (
        rest.length === 0 &&
        OperatorSlug.safeParse(slug).success &&
        AgentNameShape.safeParse(name).success
      );
    })
    .optional()
    .catch(undefined),
  operator: z
    .object({ slug: OperatorSlug.optional().catch(undefined) })
    .optional()
    .catch(undefined),
  runtime: Runtime.optional().catch(undefined),
  // What the next level still needs, one sentence the API writes, for the
  // Next list. Absent from an older API or before the first scoring run,
  // null at the top.
  standing: z
    .object({ needs: z.string().nullable().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  // The agent's current fingerprint of its own sessions as the API keeps it,
  // its hash, when it was captured and each part's state, never a part hash.
  // null when the agent has declared none. A handshake check of a SEAL with
  // no fingerprint reads its hash (handshake.ts). The answer the CLI reads
  // leaves it out, so it reads as absent.
  fingerprint: LiveFingerprint,
  // The fingerprint of the agent's routine runs, kept apart from the one of
  // its own sessions above, in the same shape, and left out in the same way.
  // A routine handshake check of a SEAL with no routine fingerprint reads its
  // hash.
  routineFingerprint: LiveFingerprint,
  // Where the agent's SEAL stands as the API keeps it, for the SEAL line of
  // status. Absent from an older API or when it does not parse.
  sealState: LiveSealState.optional().catch(undefined),
});
export type LiveAgent = z.infer<typeof LiveAgent>;

// The agent answer, with the same two second limit as the score. null when
// the API does not answer or answers with something else. Never throws.
// A redirect is never followed. It says on stderr where the API moved, as
// every other request does, and then counts as no answer, so init and
// the runtime question of status still print what they can.
// apiUrl, when given, is the API to read in place of the config's.
export async function readLiveAgent(
  config: Pick<Config, 'agentId' | 'apiUrl'>,
  fetchFn: typeof fetch,
  apiUrl?: string,
): Promise<LiveAgent | null> {
  // The loose LiveAgent parse, through the client's one request helper.
  try {
    return await shortClient(config, fetchFn, apiUrl).call(
      `/v1/agents/${encodeURIComponent(config.agentId)}`,
      LiveAgent,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'redirect') {
      stderr(error.message);
    }
    return null;
  }
}

// A client with the score's two second limit, for apiUrl when given, else
// for the config's API.
function shortClient(
  config: Pick<Config, 'apiUrl'>,
  fetchFn: typeof fetch,
  apiUrl?: string,
) {
  return createApiClient({
    apiUrl: apiUrl ?? savedApiUrl(config.apiUrl),
    fetch: fetchFn,
    timeoutMs: SCORE_TIMEOUT_MS,
  });
}

// How many agents the operator with this slug has, counting at most two,
// from the public directory. 1 means the agent init just registered is the
// operator's first. null when the API does not answer. Never throws.
// apiUrl, when given, is the API to read in place of the config's.
export async function operatorAgentCount(
  config: Pick<Config, 'apiUrl'>,
  slug: string,
  fetchFn: typeof fetch,
  apiUrl?: string,
): Promise<number | null> {
  try {
    const { agents } = await shortClient(config, fetchFn, apiUrl).call(
      `/v1/agents?operator=${encodeURIComponent(slug)}&limit=2`,
      z.object({ agents: z.array(z.unknown()) }),
    );
    return agents.length;
  } catch {
    return null;
  }
}

// True for bronze and every level above it, by rank.
export function atBronzeOrAbove(level: Level | null | undefined): boolean {
  return (
    level !== null &&
    level !== undefined &&
    LEVEL_RANK[level] >= LEVEL_RANK.bronze
  );
}
