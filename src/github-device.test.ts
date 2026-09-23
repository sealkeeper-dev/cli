// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_DENIED,
  ACCESS_TOKEN_URL,
  CODE_EXPIRED,
  DEVICE_CODE_URL,
  DEVICE_GRANT_TYPE,
  DeviceFlowError,
  deviceFlow,
  githubClientId,
} from './github-device.js';

const TOKEN = 'gho_device_flow_test_token';

type Call = { url: string; init: RequestInit };

// Answers the device code request once, then hands out the token responses
// in order.
function fakeGithub(tokenResponses: unknown[], interval = 5) {
  const calls: Call[] = [];
  const queue = [...tokenResponses];
  const fetchFn = vi.fn(async (input: string | URL | Request, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === DEVICE_CODE_URL) {
      return Response.json({
        device_code: 'dev-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval,
      });
    }
    if (url === ACCESS_TOKEN_URL) {
      const next = queue.shift();
      if (next === undefined) throw new Error('no more token responses');
      return Response.json(next);
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function run(tokenResponses: unknown[], interval = 5) {
  const github = fakeGithub(tokenResponses, interval);
  const sleeps: number[] = [];
  const lines: string[] = [];
  const promise = deviceFlow({
    clientId: 'client-abc',
    fetch: github.fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    out: (line) => lines.push(line),
  });
  return { promise, sleeps, lines, calls: github.calls };
}

describe('deviceFlow', () => {
  it('prints the code and URL, polls past pending and returns the token', async () => {
    const { promise, sleeps, lines, calls } = run([
      { error: 'authorization_pending' },
      { access_token: TOKEN, token_type: 'bearer', scope: '' },
    ]);
    expect(await promise).toBe(TOKEN);
    expect(lines).toEqual([
      'Open https://github.com/login/device',
      'Enter code ABCD-1234',
    ]);
    expect(sleeps).toEqual([5000, 5000]);

    const [start, poll] = calls;
    expect(start?.url).toBe(DEVICE_CODE_URL);
    expect(start?.init.method).toBe('POST');
    expect(start?.init.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const startBody = new URLSearchParams(String(start?.init.body));
    expect(Object.fromEntries(startBody)).toEqual({ client_id: 'client-abc' });

    const pollBody = new URLSearchParams(String(poll?.init.body));
    expect(Object.fromEntries(pollBody)).toEqual({
      client_id: 'client-abc',
      device_code: 'dev-123',
      grant_type: DEVICE_GRANT_TYPE,
    });
  });

  it('adds five seconds to the interval on slow_down', async () => {
    const { promise, sleeps } = run([
      { error: 'slow_down', interval: 10 },
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: TOKEN },
    ]);
    expect(await promise).toBe(TOKEN);
    expect(sleeps).toEqual([5000, 10000, 10000, 15000]);
  });

  it('stops on expired_token', async () => {
    const { promise } = run([{ error: 'expired_token' }]);
    await expect(promise).rejects.toThrow(new DeviceFlowError(CODE_EXPIRED));
  });

  it('stops on access_denied', async () => {
    const { promise } = run([{ error: 'access_denied' }]);
    await expect(promise).rejects.toThrow(new DeviceFlowError(ACCESS_DENIED));
  });

  it('stops once the code lifetime has passed without an answer', async () => {
    const pending = Array.from({ length: 200 }, () => ({
      error: 'authorization_pending',
    }));
    const { promise, sleeps } = run(pending, 300);
    await expect(promise).rejects.toThrow(CODE_EXPIRED);
    expect(sleeps).toHaveLength(3);
  });

  it('reports other GitHub errors with their description', async () => {
    const { promise } = run([
      {
        error: 'device_flow_disabled',
        error_description: 'Device flow must be enabled',
      },
    ]);
    await expect(promise).rejects.toThrow('Device flow must be enabled');
  });

  it('turns a network failure into a DeviceFlowError', async () => {
    const promise = deviceFlow({
      clientId: 'client-abc',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      sleep: async () => {},
      out: () => {},
    });
    await expect(promise).rejects.toThrow(
      new DeviceFlowError('could not reach GitHub: fetch failed'),
    );
  });
});

describe('githubClientId', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads VOUCHED_GITHUB_CLIENT_ID', () => {
    expect(githubClientId({ VOUCHED_GITHUB_CLIENT_ID: ' abc ' })).toBe('abc');
  });

  it('returns null when neither the env var nor the build value is set', () => {
    expect(githubClientId({})).toBeNull();
    expect(githubClientId({ VOUCHED_GITHUB_CLIENT_ID: '' })).toBeNull();
  });
});
