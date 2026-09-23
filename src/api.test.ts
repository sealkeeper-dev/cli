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
