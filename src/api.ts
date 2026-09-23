// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { AgentResponse, ErrorResponse } from '@vouched/schema';
import { DEFAULT_API_URL } from './config.js';

// A small client for the Vouched API. Every response is parsed with the
// schemas from @vouched/schema before anything reads it.

export const API_URL_ENV = 'VOUCHED_API_URL';
const REQUEST_TIMEOUT_MS = 30_000;

// status is 0 for a network failure. code is the API error code, or
// network_error or bad_response when the API never gave one.
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// An explicit flag wins, then VOUCHED_API_URL, then the config, then the
// production default.
export function resolveApiUrl(
  sources: { flag?: string; config?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env[API_URL_ENV]?.trim();
  return (
    sources.flag?.trim() || fromEnv || sources.config?.trim() || DEFAULT_API_URL
  );
}

export type ApiClient = {
  apiUrl: string;
  registerAgent(envelope: string): Promise<AgentResponse>;
};

export function createApiClient(options: {
  apiUrl: string;
  fetch?: typeof fetch;
}): ApiClient {
  const fetchFn = options.fetch ?? fetch;
  const apiUrl = options.apiUrl.replace(/\/+$/, '');

  async function postJson(path: string, body: unknown) {
    let res: Response;
    try {
      res = await fetchFn(`${apiUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ApiError(
        0,
        'network_error',
        `could not reach the Vouched API at ${apiUrl}: ${(error as Error).message}`,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  function toError(status: number, json: unknown): ApiError {
    const parsed = ErrorResponse.safeParse(json);
    if (parsed.success) {
      const { code, message } = parsed.data.error;
      return new ApiError(status, code, message);
    }
    return new ApiError(
      status,
      'bad_response',
      `the Vouched API returned an unexpected response (HTTP ${status})`,
    );
  }

  return {
    apiUrl,
    async registerAgent(envelope) {
      const { status, json } = await postJson('/v1/agents', { envelope });
      if (status !== 200 && status !== 201) throw toError(status, json);
      const agent = AgentResponse.safeParse(json);
      if (!agent.success) throw toError(status, undefined);
      return agent.data;
    },
  };
}
