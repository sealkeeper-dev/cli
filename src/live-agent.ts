// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  AgentName,
  FingerprintPartState,
  LEVEL_RANK,
  Level,
  OperatorSlug,
  Runtime,
  Sha256Base64url,
} from '@sealkeeper/schema';
import { z } from 'zod';
import { ApiError, createApiClient, resolveApiUrl } from './api.js';
import type { Config } from './config.js';
import { stderr } from './output.js';
import { SCORE_TIMEOUT_MS } from './score.js';

// Where the agent stands on SealKeeper, as init reads it.
// The verified count and the level come live from GET /v1/agents/<id>, the
// same numbers the public profile shows.

// The part of GET /v1/agents/<id> the CLI reads here. level is optional
// on the answer, since a version the scoring job has not reached has
// none. Read loosely, so a field that fails to parse costs
// only that field.
export const LiveAgent = z.object({
  counts: z
    .object({ verifiedTasks: z.int().min(0) })
    .optional()
    .catch(undefined),
  level: Level.optional().catch(undefined),
  // The handle and the operator slug the API builds it from (VOU-174), for
  // the first sign up, and the runtime, for the one time runtime question
  // (VOU-176). A runtime this version does not know reads as absent.
  // Both are printed and the handle goes into the profile URL, so each
  // must have the shape the API builds, or it reads as absent.
  handle: z
    .string()
    .refine((handle) => {
      const [slug, name, ...rest] = handle.split('/');
      return (
        rest.length === 0 &&
        OperatorSlug.safeParse(slug).success &&
        AgentName.safeParse(name).success
      );
    })
    .optional()
    .catch(undefined),
  operator: z
    .object({ slug: OperatorSlug.optional().catch(undefined) })
    .optional()
    .catch(undefined),
  runtime: Runtime.optional().catch(undefined),
  // The agent's current fingerprint as the API keeps it (VB-4), its hash,
  // when it was captured and each part's state, never a part hash. null
  // when the agent has declared none. Absent from an API before it, and
  // when it does not parse, a state this version does not know included.
  // A handshake check reads its hash (handshake.ts).
  fingerprint: z
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
    .catch(undefined),
});
export type LiveAgent = z.infer<typeof LiveAgent>;

// The agent answer, with the same two second limit as the score. null when
// the API does not answer or answers with something else. Never throws.
// A redirect is never followed. It says on stderr where the API moved, as
// every other request does, and then counts as no answer, so init and
// the runtime question of status still print what they can.
export async function readLiveAgent(
  config: Pick<Config, 'agentId' | 'apiUrl'>,
  fetchFn: typeof fetch,
): Promise<LiveAgent | null> {
  // The loose LiveAgent parse, through the client's one request helper.
  try {
    return await shortClient(config, fetchFn).call(
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

// A client with the score's two second limit.
function shortClient(config: Pick<Config, 'apiUrl'>, fetchFn: typeof fetch) {
  return createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: fetchFn,
    timeoutMs: SCORE_TIMEOUT_MS,
  });
}

// How many agents the operator with this slug has, counting at most two,
// from the public directory. 1 means the agent init just registered is the
// operator's first. null when the API does not answer. Never throws.
export async function operatorAgentCount(
  config: Pick<Config, 'apiUrl'>,
  slug: string,
  fetchFn: typeof fetch,
): Promise<number | null> {
  try {
    const { agents } = await shortClient(config, fetchFn).call(
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
