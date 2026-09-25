// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ListTasksQuery, WELL_KNOWN_PATH } from '@sealkeeper/schema';
import type { z } from 'zod';
import {
  DEFAULT_API_URL,
  INSECURE_API_URL,
  isSecureApiUrl,
  paths,
} from './config.js';
import { readEnv } from './env.js';
import { tildePath } from './files.js';
import {
  AgentResponse,
  CredentialResponse,
  type ErrorIssue,
  ErrorResponse,
  EventsBatchResponse,
  ListTasksResponse,
  RatingResponse,
  ScoreResponse,
  TaskResponse,
  TaskSubmissionResponse,
  WellKnown,
} from './responses.js';

// A small client for the SealKeeper API. Every response is parsed before
// anything reads it, with the loose schemas in responses.ts, so a field the
// API adds later never breaks this CLI.

const API_URL_ENV = 'SEALKEEPER_API_URL';
const REQUEST_TIMEOUT_MS = 30_000;

type ApiIssue = ErrorIssue;

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

// An explicit flag wins, then SEALKEEPER_API_URL, then the config, then the
// production default.
export function resolveApiUrl(
  sources: { flag?: string; config?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = readEnv(API_URL_ENV, env);
  return (
    sources.flag?.trim() || fromEnv || sources.config?.trim() || DEFAULT_API_URL
  );
}

export type ApiClient = {
  apiUrl: string;
  registerAgent(envelope: string): Promise<AgentResponse>;
  getAgent(agentId: string): Promise<AgentResponse>;
  postEvents(envelopes: string[]): Promise<EventsBatchResponse>;
  getCredential(agentId: string): Promise<CredentialResponse>;
  getWellKnown(): Promise<WellKnown>;
  getScore(agentId: string): Promise<ScoreResponse>;
  listTasks(query?: z.input<typeof ListTasksQuery>): Promise<TaskResponse[]>;
  getTask(taskId: string): Promise<TaskResponse>;
  postTask(envelope: string): Promise<TaskResponse>;
  claimTask(taskId: string, envelope: string): Promise<TaskResponse>;
  submitTask(taskId: string, envelope: string): Promise<TaskResponse>;
  postOutcome(taskId: string, envelope: string): Promise<TaskResponse>;
  // POST /v1/tasks/:id/submission, signed by the poster. The task with its
  // submission and both sides' outcome reports.
  readSubmission(
    taskId: string,
    envelope: string,
  ): Promise<TaskSubmissionResponse>;
  postRating(envelope: string): Promise<RatingResponse>;
  renameAgent(agentId: string, envelope: string): Promise<AgentResponse>;
  // PATCH /v1/agents/:id with a signed { version, issuedAt }.
  changeAgentVersion(agentId: string, envelope: string): Promise<AgentResponse>;
  // DELETE /v1/agents/:id, signed. deleted on 204, gone on 404. Anything
  // else throws.
  deleteAgent(agentId: string, envelope: string): Promise<'deleted' | 'gone'>;
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

  async function request(path: string, body?: unknown, method?: string) {
    if (!isSecureApiUrl(apiUrl)) {
      throw new ApiError(
        0,
        'insecure_api_url',
        `refusing the SealKeeper API at ${apiUrl}, ${INSECURE_API_URL}`,
      );
    }
    let res: Response;
    try {
      res = await fetchFn(`${apiUrl}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers:
          body === undefined
            ? { Accept: 'application/json' }
            : {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would re-send a signed body, or the GitHub token at
        // registration, to wherever the server points. manual hands the
        // redirect back unfollowed, so the new address can be named.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ApiError(
        0,
        'network_error',
        `could not reach the SealKeeper API at ${apiUrl}: ${(error as Error).message}`,
      );
    }
    if (isRedirect(res.status)) throw redirectError(apiUrl, path, res);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json, headers: res.headers };
  }

  // A task route. ok lists the statuses that carry a task, anything else is
  // an error. Signed writes send the envelope as the whole body.
  async function taskRequest(
    path: string,
    ok: number[],
    envelope?: string,
  ): Promise<TaskResponse> {
    const { status, json, headers } = await request(
      path,
      envelope === undefined ? undefined : { envelope },
    );
    if (!ok.includes(status)) throw toError(status, json, headers);
    const result = TaskResponse.safeParse(json);
    if (!result.success) throw toError(status, undefined);
    return result.data;
  }

  // PATCH /v1/agents/:id, which renames the agent or moves its version,
  // whichever the signed payload asks for.
  async function patchAgent(
    agentId: string,
    envelope: string,
  ): Promise<AgentResponse> {
    const { status, json, headers } = await request(
      `/v1/agents/${encodeURIComponent(agentId)}`,
      { envelope },
      'PATCH',
    );
    if (status !== 200) throw toError(status, json, headers);
    const result = AgentResponse.safeParse(json);
    if (!result.success) throw toError(status, undefined);
    return result.data;
  }

  const taskPath = (taskId: string, action = '') =>
    `/v1/tasks/${encodeURIComponent(taskId)}${action}`;

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
      `the SealKeeper API returned an unexpected response (HTTP ${status})`,
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
    // The public agent answer, with live counts and operatedBySealKeeper.
    async getAgent(agentId) {
      const { status, json, headers } = await request(
        `/v1/agents/${encodeURIComponent(agentId)}`,
      );
      if (status !== 200) throw toError(status, json, headers);
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
    // GET /v1/agents/:id/seal. /credential is the old path of the same
    // answer, kept by the API for one release.
    async getCredential(agentId) {
      const { status, json, headers } = await request(
        `/v1/agents/${encodeURIComponent(agentId)}/seal`,
      );
      if (status !== 200) throw toError(status, json, headers);
      const result = CredentialResponse.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data;
    },
    async getWellKnown() {
      const { status, json, headers } = await request(WELL_KNOWN_PATH);
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
    async listTasks(query = {}) {
      const { state, taskType, limit } = ListTasksQuery.parse(query);
      const search = new URLSearchParams({ state, limit: String(limit) });
      if (taskType !== undefined) search.set('taskType', taskType);
      const { status, json, headers } = await request(
        `/v1/tasks?${search.toString()}`,
      );
      if (status !== 200) throw toError(status, json, headers);
      const result = ListTasksResponse.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data.tasks;
    },
    getTask: (taskId) => taskRequest(taskPath(taskId), [200]),
    // 201 for a new task, 200 when a retried post returns the existing one.
    postTask: (envelope) => taskRequest('/v1/tasks', [200, 201], envelope),
    claimTask: (taskId, envelope) =>
      taskRequest(taskPath(taskId, '/claim'), [200], envelope),
    submitTask: (taskId, envelope) =>
      taskRequest(taskPath(taskId, '/submit'), [200], envelope),
    postOutcome: (taskId, envelope) =>
      taskRequest(taskPath(taskId, '/outcome'), [200], envelope),
    async readSubmission(taskId, envelope) {
      const { status, json, headers } = await request(
        taskPath(taskId, '/submission'),
        { envelope },
      );
      if (status !== 200) throw toError(status, json, headers);
      const result = TaskSubmissionResponse.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data;
    },
    async postRating(envelope) {
      const { status, json, headers } = await request('/v1/ratings', {
        envelope,
      });
      if (status !== 200) throw toError(status, json, headers);
      const result = RatingResponse.safeParse(json);
      if (!result.success) throw toError(status, undefined);
      return result.data;
    },
    renameAgent: (agentId, envelope) => patchAgent(agentId, envelope),
    changeAgentVersion: (agentId, envelope) => patchAgent(agentId, envelope),
    async deleteAgent(agentId, envelope) {
      const { status, json, headers } = await request(
        `/v1/agents/${encodeURIComponent(agentId)}`,
        { envelope },
        'DELETE',
      );
      if (status === 204) return 'deleted';
      if (status === 404) return 'gone';
      throw toError(status, json, headers);
    },
  };
}

// Only the delay-seconds form. The API never sends an HTTP date.
function retryAfter(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

export const isRedirect = (status: number): boolean =>
  status >= 300 && status < 400;

// A redirect is never followed. It usually means the API moved, as when
// api.vouched.run became api.sealkeeper.run, so the error names the old
// address and the new one from the Location header and says where to set
// it. path is the part of the request after the API URL. When the new
// address ends with the same path, the API URL is what is left, otherwise
// the origin of the new address.
export function redirectError(
  apiUrl: string,
  path: string,
  res: Pick<Response, 'status' | 'headers'>,
): ApiError {
  const config = tildePath(paths().config);
  const target = movedTo(apiUrl, path, res.headers.get('Location'));
  const message =
    target === null
      ? `the API at ${apiUrl} answered with a redirect (HTTP ${res.status}) and no usable address, check apiUrl in ${config}`
      : `the API at ${apiUrl} moved to ${target}, set apiUrl in ${config} to it`;
  return new ApiError(res.status, 'redirect', message);
}

function movedTo(
  apiUrl: string,
  path: string,
  location: string | null,
): string | null {
  if (!location) return null;
  let url: URL;
  try {
    url = new URL(location, `${apiUrl}${path}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const full = url.href;
  if (path !== '' && full.endsWith(path)) {
    return full.slice(0, full.length - path.length).replace(/\/+$/, '');
  }
  return url.origin;
}
