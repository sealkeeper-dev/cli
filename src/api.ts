// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  AgentResponse,
  CredentialResponse,
  type ErrorIssue,
  ErrorResponse,
  EventsBatchResponse,
  ScoreResponse,
  WellKnown,
} from '@vouched/schema';
import type { z } from 'zod';
import { DEFAULT_API_URL } from './config.js';

// A small client for the Vouched API. Every response is parsed with the
// schemas from @vouched/schema before anything reads it.

export const API_URL_ENV = 'VOUCHED_API_URL';
const REQUEST_TIMEOUT_MS = 30_000;

export type ApiIssue = z.infer<typeof ErrorIssue>;

// status is 0 for a network failure. code is the API error code, or
// network_error or bad_response when the API never gave one. issues are the
// per field issues the API sent, if any. retryAfterSec is the Retry-After
// header of a 429, in seconds, when it was a plain number.
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: ApiIssue[] = [],
    readonly retryAfterSec: number | null = null,
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
  postEvents(envelopes: string[]): Promise<EventsBatchResponse>;
  getCredential(agentId: string): Promise<CredentialResponse>;
  getWellKnown(): Promise<WellKnown>;
  getScore(agentId: string): Promise<ScoreResponse>;
};

// timeoutMs bounds each request. emit passes a short one so a slow network
// never holds up the hook that called it.
export function createApiClient(options: {
  apiUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): ApiClient {
  const fetchFn = options.fetch ?? fetch;
  const apiUrl = options.apiUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function request(path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetchFn(`${apiUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers:
          body === undefined
            ? { Accept: 'application/json' }
            : {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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
    return { status: res.status, json, headers: res.headers };
  }

  function toError(status: number, json: unknown, headers?: Headers): ApiError {
    const parsed = ErrorResponse.safeParse(json);
    if (parsed.success) {
      const { code, message, issues } = parsed.data.error;
      return new ApiError(
        status,
        code,
        message,
        issues,
        retryAfter(headers?.get('Retry-After')),
      );
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
      const { status, json } = await request('/v1/agents', { envelope });
      if (status !== 200 && status !== 201) throw toError(status, json);
      const agent = AgentResponse.safeParse(json);
      if (!agent.success) throw toError(status, undefined);
      return agent.data;
    },
    async postEvents(envelopes) {
      const { status, json, headers } = await request('/v1/events', {
        envelopes,
      });
      if (status !== 200) throw toError(status, json, headers);
      const result = EventsBatchResponse.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data;
    },
    async getCredential(agentId) {
      const { status, json, headers } = await request(
        `/v1/agents/${encodeURIComponent(agentId)}/credential`,
      );
      if (status !== 200) throw toError(status, json, headers);
      const result = CredentialResponse.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data;
    },
    async getWellKnown() {
      const { status, json, headers } = await request(
        '/.well-known/vouched.json',
      );
      if (status !== 200) throw toError(status, json, headers);
      const result = WellKnown.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data;
    },
    async getScore(agentId) {
      const { status, json, headers } = await request(
        `/v1/agents/${encodeURIComponent(agentId)}/score`,
      );
      if (status !== 200) throw toError(status, json, headers);
      const result = ScoreResponse.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data;
    },
  };
}

// Only the delay-seconds form. The API never sends an HTTP date.
function retryAfter(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}
