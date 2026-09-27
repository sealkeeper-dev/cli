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
  GoalResponse,
  type ListTasksPage,
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

export const API_URL_ENV = 'SEALKEEPER_API_URL';
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

// What a request got back. json is undefined when the body is not JSON.
export type RawResponse = { status: number; json: unknown; headers: Headers };

export type RequestOptions = {
  // Sent as the JSON body. A request with a body is a POST unless method
  // says otherwise.
  body?: unknown;
  method?: string;
  // Overrides the client's timeout for this request.
  timeoutMs?: number;
};

export type ApiClient = {
  apiUrl: string;
  // One request to path, with the rules every request follows. https only,
  // or http to this machine, a redirect is never followed and throws an
  // ApiError naming the new address, and a request that gets no answer
  // throws network_error. Any status comes back as it is.
  request(path: string, options?: RequestOptions): Promise<RawResponse>;
  // request, then the answer parsed with schema. A status outside ok
  // (200 when left out) or a body that does not parse throws an ApiError,
  // with Retry-After kept.
  call<S extends z.ZodType>(
    path: string,
    schema: S,
    options?: RequestOptions & { ok?: number[] },
  ): Promise<z.output<S>>;
  registerAgent(envelope: string): Promise<AgentResponse>;
  getAgent(agentId: string): Promise<AgentResponse>;
  postEvents(envelopes: string[]): Promise<EventsBatchResponse>;
  // The Date header of the last response this client received, in ms since
  // the epoch. null before any response, or when the last one had no Date
  // header or one that does not parse.
  serverDate(): number | null;
  getCredential(agentId: string): Promise<CredentialResponse>;
  getWellKnown(): Promise<WellKnown>;
  getScore(agentId: string): Promise<ScoreResponse>;
  // GET /v1/agents/:id/goal, parsed loosely with unknown keys kept.
  getGoal(agentId: string): Promise<GoalResponse>;
  // One page of GET /v1/tasks, the tasks alone.
  listTasks(query?: z.input<typeof ListTasksQuery>): Promise<TaskResponse[]>;
  // The same with nextCursor, for a caller that pages. cursor is the
  // nextCursor of the page before, as the API sent it.
  listTasksPage(
    query?: Omit<z.input<typeof ListTasksQuery>, 'cursor'> & {
      cursor?: string;
    },
  ): Promise<ListTasksPage>;
  // POST /v1/tasks/open, signed. The open pool as this agent sees it, less
  // the tasks it is barred from (VOU-200).
  listOpenTasks(envelope: string): Promise<ListTasksPage>;
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
  // PATCH /v1/agents/:id, which renames the agent, moves its version or
  // sets its runtime, whichever the signed payload asks for.
  patchAgent(agentId: string, envelope: string): Promise<AgentResponse>;
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
  let serverDate: number | null = null;

  async function request(
    path: string,
    { body, method, timeoutMs: timeout }: RequestOptions = {},
  ): Promise<RawResponse> {
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
        signal: AbortSignal.timeout(timeout ?? timeoutMs),
      });
    } catch (error) {
      throw new ApiError(
        0,
        'network_error',
        `could not reach the SealKeeper API at ${apiUrl}: ${(error as Error).message}`,
      );
    }
    serverDate = httpDate(res.headers.get('Date'));
    if (isRedirect(res.status)) throw redirectError(apiUrl, path, res);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json, headers: res.headers };
  }

  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    { ok = [200], ...rest }: RequestOptions & { ok?: number[] } = {},
  ): Promise<z.output<S>> {
    const { status, json, headers } = await request(path, rest);
    if (!ok.includes(status)) throw apiErrorOf(status, json, headers);
    const result = schema.safeParse(json);
    if (!result.success) throw apiErrorOf(status, undefined, headers);
    return result.data;
  }

  const agentPath = (agentId: string, action = '') =>
    `/v1/agents/${encodeURIComponent(agentId)}${action}`;
  const taskPath = (taskId: string, action = '') =>
    `/v1/tasks/${encodeURIComponent(taskId)}${action}`;
  // A task route. ok lists the statuses that carry a task. Signed writes
  // send the envelope as the whole body.
  const taskCall = (path: string, ok: number[], envelope?: string) =>
    call(path, TaskResponse, {
      ok,
      ...(envelope === undefined ? {} : { body: { envelope } }),
    });

  // A page of tasks from GET /v1/tasks or POST /v1/tasks/open, nextCursor
  // null on the last page.
  async function taskPage(
    path: string,
    options?: RequestOptions,
  ): Promise<ListTasksPage> {
    const page = await call(path, ListTasksResponse, options);
    return { tasks: page.tasks, nextCursor: page.nextCursor ?? null };
  }

  /*
   * GET /v1/tasks. The query is checked with the API's own schema before it
   * is sent, then sent as text. seed, poster and claimant ask the API to
   * filter, so a flood of older tasks from others cannot push the ones this
   * CLI wants off the page (VOU-208). An API from before them refuses them
   * with 400, so this CLI needs the API from the same release.
   */
  async function listTasksPage(
    query: Omit<z.input<typeof ListTasksQuery>, 'cursor'> & {
      cursor?: string;
    } = {},
  ): Promise<ListTasksPage> {
    const { state, taskType, assignee, poster, claimant, seed, limit } =
      ListTasksQuery.parse(query);
    const search = new URLSearchParams({ state, limit: String(limit) });
    if (taskType !== undefined) search.set('taskType', taskType);
    // With state open, the tasks addressed to this agent that wait for it.
    // Without it, open tasks leave addressed ones out.
    if (assignee !== undefined) search.set('assignee', assignee);
    if (poster !== undefined) search.set('poster', poster);
    if (claimant !== undefined) search.set('claimant', claimant);
    if (seed !== undefined) search.set('seed', String(seed));
    // The cursor goes back as the API sent it. The parse above checked it.
    if (query.cursor !== undefined) search.set('cursor', query.cursor);
    return taskPage(`/v1/tasks?${search.toString()}`);
  }

  return {
    apiUrl,
    request,
    call,
    serverDate: () => serverDate,
    registerAgent: (envelope) =>
      call('/v1/agents', AgentResponse, {
        body: { envelope },
        ok: [200, 201],
      }),
    // The public agent answer, with live counts and operatedBySealKeeper.
    getAgent: (agentId) => call(agentPath(agentId), AgentResponse),
    postEvents: (envelopes) =>
      call('/v1/events', EventsBatchResponse, { body: { envelopes } }),
    // GET /v1/agents/:id/seal. /credential is the old path of the same
    // answer, kept by the API for one release.
    getCredential: (agentId) =>
      call(agentPath(agentId, '/seal'), CredentialResponse),
    getWellKnown: () => call(WELL_KNOWN_PATH, WellKnown),
    getScore: (agentId) => call(agentPath(agentId, '/score'), ScoreResponse),
    getGoal: (agentId) => call(agentPath(agentId, '/goal'), GoalResponse),
    async listTasks(query = {}) {
      return (await listTasksPage(query)).tasks;
    },
    listTasksPage,
    // Signed, the envelope as the whole body, the same page as GET
    // /v1/tasks.
    listOpenTasks: (envelope) =>
      taskPage('/v1/tasks/open', { body: { envelope } }),
    getTask: (taskId) => taskCall(taskPath(taskId), [200]),
    // 201 for a new task, 200 when a retried post returns the existing one.
    postTask: (envelope) => taskCall('/v1/tasks', [200, 201], envelope),
    claimTask: (taskId, envelope) =>
      taskCall(taskPath(taskId, '/claim'), [200], envelope),
    submitTask: (taskId, envelope) =>
      taskCall(taskPath(taskId, '/submit'), [200], envelope),
    postOutcome: (taskId, envelope) =>
      taskCall(taskPath(taskId, '/outcome'), [200], envelope),
    readSubmission: (taskId, envelope) =>
      call(taskPath(taskId, '/submission'), TaskSubmissionResponse, {
        body: { envelope },
      }),
    postRating: (envelope) =>
      call('/v1/ratings', RatingResponse, { body: { envelope } }),
    patchAgent: (agentId, envelope) =>
      call(agentPath(agentId), AgentResponse, {
        body: { envelope },
        method: 'PATCH',
      }),
    async deleteAgent(agentId, envelope) {
      const { status, json, headers } = await request(agentPath(agentId), {
        body: { envelope },
        method: 'DELETE',
      });
      if (status === 204) return 'deleted';
      if (status === 404) return 'gone';
      throw apiErrorOf(status, json, headers);
    },
  };
}

// The ApiError for an answer the caller cannot use. The API's own code,
// message and issues when the body is its error shape, with the
// Retry-After of a 429, else bad_response.
export function apiErrorOf(
  status: number,
  json: unknown,
  headers?: Headers,
): ApiError {
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

// An HTTP Date header in ms since the epoch, or null when it is missing or
// does not parse.
function httpDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
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
