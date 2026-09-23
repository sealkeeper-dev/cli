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
    const env = { VOUCHED_API_URL: 'http://env' };
    expect(
      resolveApiUrl({ flag: 'http://flag', config: 'http://c' }, env),
    ).toBe('http://flag');
    expect(resolveApiUrl({ config: 'http://c' }, env)).toBe('http://env');
    expect(resolveApiUrl({ config: 'http://c' }, {})).toBe('http://c');
    expect(resolveApiUrl({}, {})).toBe('https://api.vouched.run');
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
        'could not reach the Vouched API at http://api.test: fetch failed',
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
