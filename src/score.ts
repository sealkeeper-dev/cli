// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import { ScoreResponse } from '@sealkeeper/schema';
import { z } from 'zod';
import { createApiClient } from './api.js';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';

// A small cache of the agent's scores from GET /v1/agents/<id>/score, kept in
// score.json so status can show them offline. Scores change when the scoring
// job runs, so fifteen minutes old is fresh enough.

export const SCORE_CACHE_VERSION = 1;
export const SCORE_TTL_MS = 15 * 60 * 1000;
export const SCORE_TIMEOUT_MS = 2_000;

const ScoreCache = z.strictObject({
  v: z.literal(SCORE_CACHE_VERSION),
  fetchedAt: z.iso.datetime({ offset: true }),
  score: ScoreResponse,
});
export type ScoreCache = z.infer<typeof ScoreCache>;

export type ScoreOptions = {
  agentId: string;
  apiUrl: string;
  fetch?: typeof fetch;
  now?: Date;
  paths?: Paths;
};

// A fresh cache is returned as is. Otherwise it asks the API, with a two
// second timeout, and caches the answer. When that fails for any reason it
// returns the stale cache if there is one, else null. It never throws.
export async function getScore(
  options: ScoreOptions,
): Promise<ScoreCache | null> {
  const p = options.paths ?? paths();
  const now = options.now ?? new Date();
  const cached = await readScoreCache(p, options.agentId);
  // A fetchedAt in the future means the clock was wrong when it was written,
  // so that cache is treated as stale rather than fresh until then.
  const age = cached ? now.getTime() - Date.parse(cached.fetchedAt) : -1;
  if (cached && age >= 0 && age < SCORE_TTL_MS) return cached;

  try {
    const api = createApiClient({
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      timeoutMs: SCORE_TIMEOUT_MS,
    });
    const score = await api.getScore(options.agentId);
    if (score.agentId !== options.agentId) return cached;
    const fresh: ScoreCache = {
      v: SCORE_CACHE_VERSION,
      fetchedAt: now.toISOString(),
      score,
    };
    await writeScoreCache(fresh, p).catch(() => undefined);
    return fresh;
  } catch {
    return cached;
  }
}

// null when there is no cache, it does not parse, or it belongs to another
// agent.
async function readScoreCache(
  p: Paths,
  agentId: string,
): Promise<ScoreCache | null> {
  try {
    const result = ScoreCache.safeParse(
      JSON.parse(await readFile(p.score, 'utf8')),
    );
    if (!result.success) return null;
    return result.data.score.agentId === agentId ? result.data : null;
  } catch {
    return null;
  }
}

async function writeScoreCache(cache: ScoreCache, p: Paths): Promise<void> {
  await ensureHome(p);
  await writeFileAtomic(p.score, `${JSON.stringify(cache)}\n`);
}
