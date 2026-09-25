// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { Level } from '@sealkeeper/schema';
import { z } from 'zod';
import { isRedirect, redirectError, resolveApiUrl } from './api.js';
import { type Config, isSecureApiUrl } from './config.js';
import { stderr } from './output.js';
import { SCORE_TIMEOUT_MS } from './score.js';

// Where the agent stands on SealKeeper, as status, prove and init read it.
// The verified count and the level come live from GET /v1/agents/<id>, the
// same numbers the public profile shows.

// The part of GET /v1/agents/<id> the CLI reads here. level and standing
// are optional on the answer, since a version the scoring job has not
// reached has neither. Read loosely, so a field that fails to parse costs
// only that field.
export const LiveAgent = z.object({
  counts: z
    .object({ verifiedTasks: z.int().min(0) })
    .optional()
    .catch(undefined),
  level: Level.optional().catch(undefined),
  standing: z
    .object({
      dormant_days: z.int().min(0).nullable(),
      // The scoring window's evidence counts, as of the last run. prove
      // reads the ones silver needs.
      counts: z
        .object({
          server_checked_tasks: z.int().min(0),
          confirmed_tasks: z.int().min(0),
          distinct_operators: z.int().min(0),
        })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type LiveAgent = z.infer<typeof LiveAgent>;

// The agent answer, with the same two second limit as the score. null when
// the API does not answer or answers with something else. Never throws.
// A redirect is never followed. It says on stderr where the API moved, as
// every other request does, and then counts as no answer, so status, init
// and prove still print what they can.
export async function readLiveAgent(
  config: Pick<Config, 'agentId' | 'apiUrl'>,
  fetchFn: typeof fetch,
): Promise<LiveAgent | null> {
  const apiUrl = resolveApiUrl({ config: config.apiUrl }).replace(/\/+$/, '');
  // Its own request rather than the API client, for the loose parse, with
  // the same rules as every other request.
  if (!isSecureApiUrl(apiUrl)) return null;
  const path = `/v1/agents/${encodeURIComponent(config.agentId)}`;
  try {
    const res = await fetchFn(`${apiUrl}${path}`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
    });
    if (isRedirect(res.status)) {
      stderr(redirectError(apiUrl, path, res).message);
      return null;
    }
    if (res.status !== 200) return null;
    const parsed = LiveAgent.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// True for bronze, silver and gold.
export function atBronzeOrAbove(level: Level | null | undefined): boolean {
  return level === 'bronze' || level === 'silver' || level === 'gold';
}
