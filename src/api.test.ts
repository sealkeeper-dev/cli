// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, resolveApiUrl } from './api.js';

const AGENT_ID = 'A'.repeat(43);
const AGENT = {
  id: AGENT_ID,
  name: 'scout',
  version: '0.1.0',
  operator: { login: 'carelmeyer' },
  createdAt: '2026-09-23T10:00:00.000Z',
};

function respond(response: Response | (() => never)) {
  return vi.fn(async () =>
    typeof response === 'function' ? response() : response,
  ) as unknown as typeof fetch;
}

describe('resolveApiUrl', () => {
  it('prefers the flag, then the env var, then config, then the default', () => {
    const env = { SEALKEEPER_API_URL: 'http://env' };
    expect(
      resolveApiUrl({ flag: 'http://flag', config: 'http://c' }, env),
    ).toBe('http://flag');
    expect(resolveApiUrl({ config: 'http://c' }, env)).toBe('http://env');
    expect(resolveApiUrl({ config: 'http://c' }, {})).toBe('http://c');
    expect(resolveApiUrl({}, {})).toBe('https://api.sealkeeper.run');
  });
});

describe('registerAgent', () => {
  it('posts the envelope to /v1/agents and returns the agent', async () => {
    const fetchFn = respond(Response.json(AGENT, { status: 201 }));
    const api = createApiClient({ apiUrl: 'http://api.test/', fetch: fetchFn });
    expect(await api.registerAgent('a.b.c')).toEqual(AGENT);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/v1/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ envelope: 'a.b.c' }),
      }),
    );
  });

  it('accepts 200 for an agent that already exists', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(Response.json(AGENT, { status: 200 })),
    });
    expect((await api.registerAgent('a.b.c')).id).toBe(AGENT_ID);
  });

  it('throws ApiError with the code and message from the error body', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(
        Response.json(
          { error: { code: 'account_too_new', message: 'too new' } },
          { status: 403 },
        ),
      ),
    });
    const error = await api.registerAgent('a.b.c').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'account_too_new',
      message: 'too new',
    });
  });

  it('rejects a success body that does not match AgentResponse', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(Response.json({ id: 'nope' }, { status: 201 })),
    });
    await expect(api.registerAgent('a.b.c')).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects an error body that does not match ErrorResponse', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(new Response('<html>', { status: 502 })),
    });
    await expect(api.registerAgent('a.b.c')).rejects.toMatchObject({
      status: 502,
      code: 'bad_response',
    });
  });

  it('turns a network failure into network_error', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(() => {
        throw new TypeError('fetch failed');
      }),
    });
    await expect(api.registerAgent('a.b.c')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message:
        'could not reach the SealKeeper API at http://api.test: fetch failed',
    });
  });
});

describe('postEvents', () => {
  it('posts the envelopes to /v1/events and returns the totals', async () => {
    const fetchFn = respond(Response.json({ accepted: 2, duplicates: 1 }));
    const api = createApiClient({ apiUrl: 'http://api.test', fetch: fetchFn });
    expect(await api.postEvents(['a.b.c', 'd.e.f'])).toEqual({
      accepted: 2,
      duplicates: 1,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/v1/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ envelopes: ['a.b.c', 'd.e.f'] }),
      }),
    );
  });

  it('carries the issues and Retry-After of an error', async () => {
    const issues = [
      { path: ['envelopes', 3], code: 'invalid_signature', message: 'no' },
    ];
    const rejected = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(
        Response.json(
          { error: { code: 'invalid_signature', message: 'no', issues } },
          { status: 401 },
        ),
      ),
    });
    const error = await rejected.postEvents(['a.b.c']).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, issues, retryAfterSec: null });

    const limited = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(
        Response.json(
          { error: { code: 'rate_limited', message: 'slow down' } },
          { status: 429, headers: { 'Retry-After': '7' } },
        ),
      ),
    });
    await expect(limited.postEvents(['a.b.c'])).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSec: 7,
    });
  });

  it('rejects a 200 whose body is not the batch response', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(Response.json({ ok: true })),
    });
    await expect(api.postEvents(['a.b.c'])).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('getScore', () => {
  it('gets /v1/agents/<id>/score and parses the scores', async () => {
    const body = { agentId: AGENT_ID, scores: [] };
    const fetchFn = respond(Response.json(body));
    const api = createApiClient({ apiUrl: 'http://api.test', fetch: fetchFn });
    expect(await api.getScore(AGENT_ID)).toEqual(body);
    expect(fetchFn).toHaveBeenCalledWith(
      `http://api.test/v1/agents/${AGENT_ID}/score`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws ApiError on a 404 or a bad body', async () => {
    const missing = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(
        Response.json(
          { error: { code: 'not_found', message: 'no agent' } },
          { status: 404 },
        ),
      ),
    });
    await expect(missing.getScore(AGENT_ID)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    const bad = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(Response.json({ scores: 'x' })),
    });
    await expect(bad.getScore(AGENT_ID)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('task routes', () => {
  const TASK_ID = '0b9c3a52-5d1e-4a8e-9b1f-2f4c6d8e0a11';
  const TASK = {
    id: TASK_ID,
    posterAgentId: AGENT_ID,
    claimantAgentId: null,
    taskType: 'summarise',
    spec: { words: 100 },
    verification: { kind: 'counterparty' },
    state: 'open',
    postedAt: '2026-09-23T10:00:00.000Z',
    claimedAt: null,
    submittedAt: null,
    verifiedAt: null,
    expiresAt: '2026-09-24T10:00:00.000Z',
  };

  it('lists tasks with the query in the URL', async () => {
    const fetchFn = respond(Response.json({ tasks: [TASK] }));
    const api = createApiClient({ apiUrl: 'http://api.test', fetch: fetchFn });
    expect(await api.listTasks({ taskType: 'summarise' })).toEqual([TASK]);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/v1/tasks?state=open&limit=50&taskType=summarise',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('posts a task and accepts 201 and 200', async () => {
    for (const status of [201, 200]) {
      const fetchFn = respond(Response.json(TASK, { status }));
      const api = createApiClient({
        apiUrl: 'http://api.test',
        fetch: fetchFn,
      });
      expect((await api.postTask('a.b.c')).id).toBe(TASK_ID);
      expect(fetchFn).toHaveBeenCalledWith(
        'http://api.test/v1/tasks',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ envelope: 'a.b.c' }),
        }),
      );
    }
  });

  it.each([
    ['claimTask', '/claim'],
    ['submitTask', '/submit'],
    ['postOutcome', '/outcome'],
  ] as const)('%s posts to the task path', async (method, suffix) => {
    const fetchFn = respond(Response.json(TASK));
    const api = createApiClient({ apiUrl: 'http://api.test', fetch: fetchFn });
    expect((await api[method](TASK_ID, 'a.b.c')).id).toBe(TASK_ID);
    expect(fetchFn).toHaveBeenCalledWith(
      `http://api.test/v1/tasks/${TASK_ID}${suffix}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws ApiError with the issues of a failed submit', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(
        Response.json(
          {
            error: {
              code: 'verification_failed',
              message: 'Submission does not match the schema',
              issues: [
                {
                  path: ['submission'],
                  code: 'schema_mismatch',
                  message: 'Submission does not match the schema',
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    });
    const error = await api.submitTask(TASK_ID, 'a.b.c').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('verification_failed');
    expect(error.issues[0].code).toBe('schema_mismatch');
  });

  it('rejects a task body that does not match the schema', async () => {
    const api = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(Response.json({ id: 'nope' })),
    });
    const error = await api.getTask(TASK_ID).catch((e) => e);
    expect(error.code).toBe('bad_response');
  });
});

describe('postRating', () => {
  const RATING = {
    rateeAgentId: AGENT_ID,
    dimension: 'reliability',
    value: 4,
    raterScoreAtTime: 0.75,
  };

  it('posts the envelope to /v1/ratings and returns the stored rating', async () => {
    const fetchFn = respond(Response.json(RATING));
    const api = createApiClient({ apiUrl: 'http://api.test', fetch: fetchFn });
    expect(await api.postRating('a.b.c')).toEqual(RATING);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://api.test/v1/ratings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ envelope: 'a.b.c' }),
      }),
    );
  });

  it('throws ApiError with the code of a refusal or a bad body', async () => {
    const closed = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(
        Response.json(
          {
            error: {
              code: 'ratings_closed',
              message: 'Ratings are not open yet',
            },
          },
          { status: 403 },
        ),
      ),
    });
    await expect(closed.postRating('a.b.c')).rejects.toMatchObject({
      status: 403,
      code: 'ratings_closed',
    });
    const bad = createApiClient({
      apiUrl: 'http://api.test',
      fetch: respond(Response.json({ ...RATING, value: 9 })),
    });
    const error = await bad.postRating('a.b.c').catch((e) => e);
    expect(error.code).toBe('bad_response');
  });
});
