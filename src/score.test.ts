// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Paths, paths } from './config.js';
import { getScore, SCORE_TTL_MS } from './score.js';

const AGENT_ID = 'A'.repeat(43);
const API_URL = 'http://api.test';
const T0 = new Date('2026-09-23T10:00:00.000Z');

function scoreBody(value: number | null, agentId = AGENT_ID) {
  return {
    agentId,
    scores: [
      {
        version: '1.0.0',
        dimension: 'reliability',
        value,
        windowStart: '2026-09-01T00:00:00.000Z',
        windowEnd: '2026-09-23T00:00:00.000Z',
        computedAt: '2026-09-23T00:00:00.000Z',
      },
    ],
  };
}

function serve(body: unknown, status = 200) {
  return vi.fn(async () =>
    Response.json(body, { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const failing = vi.fn(async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('getScore', () => {
  let home: string;
  let p: Paths;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vouched-score-'));
    p = paths(home);
    failing.mockClear();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const opts = (fetchFn: typeof fetch, now: Date) => ({
    agentId: AGENT_ID,
    apiUrl: API_URL,
    fetch: fetchFn,
    now,
    paths: p,
  });

  it('returns null when there is no cache and the API fails', async () => {
    expect(await getScore(opts(failing, T0))).toBeNull();
    expect(failing).toHaveBeenCalledOnce();
  });

  it('fetches, caches and then serves the cache while it is fresh', async () => {
    const fetchFn = serve(scoreBody(0.8));
    const first = await getScore(opts(fetchFn, T0));
    expect(first?.score).toEqual(scoreBody(0.8));
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_URL}/v1/agents/${AGENT_ID}/score`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(await readFile(p.score, 'utf8'))).toEqual({
      v: 1,
      fetchedAt: T0.toISOString(),
      score: scoreBody(0.8),
    });

    const later = new Date(T0.getTime() + SCORE_TTL_MS - 1);
    const second = await getScore(opts(failing, later));
    expect(second?.score).toEqual(scoreBody(0.8));
    expect(failing).not.toHaveBeenCalled();
  });

  it('refetches once the cache is fifteen minutes old', async () => {
    await getScore(opts(serve(scoreBody(0.5)), T0));
    const later = new Date(T0.getTime() + SCORE_TTL_MS);
    const fetchFn = serve(scoreBody(0.9));
    const result = await getScore(opts(fetchFn, later));
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result?.score.scores[0]?.value).toBe(0.9);
    expect(result?.fetchedAt).toBe(later.toISOString());
  });

  it('refetches when fetchedAt is in the future', async () => {
    const future = new Date(T0.getTime() + 3 * 24 * 60 * 60 * 1000);
    await getScore(opts(serve(scoreBody(0.5)), future));
    const fetchFn = serve(scoreBody(0.9));
    const result = await getScore(opts(fetchFn, T0));
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result?.score.scores[0]?.value).toBe(0.9);
    expect(result?.fetchedAt).toBe(T0.toISOString());
  });

  it('serves the stale cache when the API fails', async () => {
    await getScore(opts(serve(scoreBody(0.5)), T0));
    const later = new Date(T0.getTime() + SCORE_TTL_MS * 4);
    const result = await getScore(opts(failing, later));
    expect(failing).toHaveBeenCalledOnce();
    expect(result).toEqual({
      v: 1,
      fetchedAt: T0.toISOString(),
      score: scoreBody(0.5),
    });
  });

  it('serves the stale cache on an error status or a bad body', async () => {
    await getScore(opts(serve(scoreBody(0.5)), T0));
    const later = new Date(T0.getTime() + SCORE_TTL_MS * 4);
    const notFound = serve({ error: { code: 'not_found', message: 'x' } }, 404);
    expect((await getScore(opts(notFound, later)))?.fetchedAt).toBe(
      T0.toISOString(),
    );
    const bad = serve({ nope: true });
    expect((await getScore(opts(bad, later)))?.fetchedAt).toBe(
      T0.toISOString(),
    );
  });

  it('ignores a corrupt cache or one for another agent', async () => {
    await writeFile(p.score, '{ nope');
    expect(await getScore(opts(failing, T0))).toBeNull();
    await writeFile(
      p.score,
      JSON.stringify({
        v: 1,
        fetchedAt: T0.toISOString(),
        score: scoreBody(0.5, 'B'.repeat(43)),
      }),
    );
    expect(await getScore(opts(failing, T0))).toBeNull();
  });
});
