// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  decodeTasksCursor,
  encodeTasksCursor,
  MAX_SUBMISSION_BYTES,
  MAX_TASK_SPEC_BYTES,
  OpenTasksRequest,
  PostTaskRequest,
  publicVerification,
  readAudience,
  type VerificationSpec,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.js';
import type { Input } from '../ask.js';
import { paths, writeConfig, writeFileAtomic } from '../config.js';
import {
  currentFingerprint,
  NOTHING_DECLARED,
  recordCapture,
} from '../fingerprint.js';
import { createKey } from '../identity.js';
import { saveOperatorSlug } from '../operator-slug.js';
import { createProgram } from '../program.js';
import type { TaskResponse } from '../responses.js';
import { appendRoutine, readRoutine } from '../routine.js';
import {
  ALREADY_CLAIMED,
  EXPIRED as CLAIM_EXPIRED,
  NOT_ASSIGNEE,
  NOT_FOUND,
  OWN_TASK,
  SAME_OPERATOR,
  UNTRUSTED,
} from './tasks-claim.js';
import {
  ALREADY_VERIFIED,
  BOTH_FAILURE,
  CLAIMANT_REPORTS,
  DISAGREED,
  EXPIRED,
  NO_SUBMISSION,
  NOT_COUNTERPARTY,
  NOT_POSTER,
  NOT_SUBMITTED,
  VERIFIED,
  WAITING,
  WAITING_AFTER_FAILURE,
  WRONG_STATE,
} from './tasks-outcome.js';
import {
  API_TOO_OLD_FOR_FIELDS,
  assigneeCap,
  assigneeOperatorCap,
  badCategory,
  badSize,
  KEY_IN_TASK,
  MAX_INPUT_FILE_BYTES,
  NO_OPTIONS_JSON,
  NO_TERMINAL,
  NOT_POSTED,
  NOTHING_POSTED,
  noAssignee,
  postRefusal,
  sameOperator,
  TEMPLATE_SETS_FIELDS,
  templateNeedsYes,
} from './tasks-post.js';
import {
  MAX_CLAIM_ATTEMPTS,
  MAX_PULL_PAGES,
  NOTHING_ADDRESSED,
  NOTHING_AVAILABLE,
} from './tasks-pull.js';
import { AWAITING_POSTER } from './tasks-submit.js';

const API_URL = 'https://api.test';

// The fake's cursor, a real one from @sealkeeper/schema, so the CLI's check
// of it passes. It carries the offset of the next page.
const pageCursor = (offset: number) =>
  encodeTasksCursor({
    atMicros: String(offset),
    id: '00000000-0000-4000-8000-000000000000',
  });
const offsetOf = (raw: string | null) =>
  raw === null ? 0 : Number(decodeTasksCursor(raw)?.atMicros ?? 0);

// Every signed payload names the API it is for (VOU-111). The fake takes
// aud off before it parses, and a payload without the right aud fails the
// test that sent it.
const audErrors: unknown[] = [];
const unsigned = (payload: unknown) => {
  const check = readAudience(payload, [API_URL]);
  if (check.result !== 'match') audErrors.push(payload);
  return check.payload;
};
afterEach(() => {
  expect(audErrors.splice(0)).toEqual([]);
});
const OTHER_AGENT = 'A'.repeat(43);
// An agent of a third operator.
const THIRD = `${'C'.repeat(42)}A`;

type RunResult = { code: number; out: string; err: string };

type ClaimReply = 'ok' | 409 | 410 | 'own_task' | 'not_assignee';

type ApiCall = {
  method: string;
  path: string;
  payload?: Record<string, unknown>;
};

// An in-memory stand-in for the task routes. Every signed write is verified
// against the key named by its kid, which must be the local agent, and the
// payload taskId must match the task in the path. Like the API, only the
// poster's post and signed submission read carry the full spec, and every
// other answer the public one, so a hash task's digest reaches no claimant.
// Submit checks a hash answer and answers a mismatch with a 422.
class FakeApi {
  tasks = new Map<string, TaskResponse>();
  // GET /v1/agents/:id answers, by agent id. Missing is bob/writer, or a
  // 404 with anyAgent false.
  agents = new Map<string, Record<string, unknown>>();
  anyAgent = true;
  claims = new Map<string, ClaimReply>();
  submitReply: (() => Response) | null = null;
  // Replaces the answer to a post, as for an assignee refusal.
  postReply: (() => Response) | null = null;
  outcomeReply: (() => Response) | null = null;
  // Replaces the answer of the poster's signed read, for the second read
  // when the number is 2.
  submissionReply: ((n: number) => Response | null) | null = null;
  submissionReads = 0;
  // Outcome reports per task, by the reporting agent id.
  reports = new Map<string, Map<string, string>>();
  requests: ApiCall[] = [];
  errors: string[] = [];
  // The query of every GET /v1/tasks.
  listed: string[] = [];
  // The payload of every signed open list as a query, issuedAt left out
  // (VOU-200).
  opened: string[] = [];
  // Open tasks this agent is barred from, left out of the signed open
  // list. The public GET still lists them.
  barred = new Set<string>();
  // False for an API from before POST /v1/tasks/open.
  openRoute = true;
  // Replaces the answer to the signed open list when set.
  openReply: (() => Response) | null = null;
  // True for an API from before VB-3, whose strict payloads refuse a
  // fingerprint.
  refuseFingerprint = false;

  constructor(readonly agentId: string) {}

  add(overrides: Partial<TaskResponse>): TaskResponse {
    const task: TaskResponse = {
      id: randomUUID(),
      posterAgentId: OTHER_AGENT,
      claimantAgentId: null,
      taskType: 'summarise',
      spec: { words: 100 },
      verification: { kind: 'counterparty' },
      state: 'open',
      // Past the claim age threshold, which pull leaves to a person first
      // (RT-8).
      postedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      claimedAt: null,
      submittedAt: null,
      verifiedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  // The signed POSTs, the open list left out since it is a read.
  posts(): ApiCall[] {
    return this.requests.filter(
      (r) => r.method === 'POST' && r.path !== '/v1/tasks/open',
    );
  }

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const request: ApiCall = { method, path: url.pathname };
    this.requests.push(request);

    // What every answer but the poster's own shows.
    const shown = (t: TaskResponse): TaskResponse => ({
      ...t,
      verification: publicVerification(t.verification as VerificationSpec),
    });

    // Like the API, the open pool leaves addressed tasks out, and assignee
    // keeps only the tasks addressed to that agent. One page at a time, the
    // cursor the offset of the next (VOU-208). barred leaves out the tasks
    // this agent is barred from, as the signed open list does (VOU-200).
    const page = (q: {
      state: string | null;
      assignee?: string | null;
      type?: string | null;
      cursor?: string | null;
      limit?: number;
      barred?: boolean;
    }) => {
      const matching = [...this.tasks.values()]
        .filter((t) => t.state === q.state)
        .filter((t) =>
          q.assignee
            ? t.assignee?.id === q.assignee
            : q.state !== 'open' || !t.assignee,
        )
        .filter((t) => !q.type || t.taskType === q.type)
        .filter((t) => !q.barred || !this.barred.has(t.id))
        .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
      const from = offsetOf(q.cursor ?? null);
      const limit = q.limit ?? 50;
      return Response.json({
        tasks: matching.slice(from, from + limit).map(shown),
        nextCursor:
          from + limit < matching.length ? pageCursor(from + limit) : null,
      });
    };

    if (method === 'GET' && url.pathname === '/v1/tasks') {
      const q = url.searchParams;
      this.listed.push(q.toString());
      return page({
        state: q.get('state'),
        assignee: q.get('assignee'),
        type: q.get('taskType'),
        cursor: q.get('cursor'),
        limit: Number(q.get('limit') ?? 50),
      });
    }
    const agent = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (method === 'GET' && agent) {
      const found = this.agents.get(decodeURIComponent(agent[1] ?? ''));
      if (found) return Response.json(found);
      if (!this.anyAgent) return error(404, 'not_found');
      return Response.json({
        id: agent[1],
        name: 'writer',
        version: '1.0.0',
        operator: { login: 'bob' },
        createdAt: '2026-09-22T00:00:00.000Z',
        handle: 'bob/writer',
      });
    }
    const match = url.pathname.match(
      /^\/v1\/tasks\/([^/]+)(?:\/(claim|submit|outcome|submission))?$/,
    );
    if (method === 'GET' && match && !match[2]) {
      const task = this.tasks.get(match[1] ?? '');
      if (!task) return error(404, 'not_found');
      // The public read, like the API's, leaves the submission out.
      const { submission: _, ...publicTask } = shown(task);
      return Response.json(publicTask);
    }

    // Signed writes from here on.
    const body = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(body.envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const payload = unsigned(
      (await verify(body.envelope, base64urlDecode(kid))).payload,
    );
    request.payload = payload as Record<string, unknown>;
    if (
      this.refuseFingerprint &&
      typeof payload === 'object' &&
      payload !== null &&
      'fingerprint' in payload
    ) {
      return Response.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Request validation failed',
            issues: [
              {
                path: [],
                code: 'unrecognized_keys',
                message: 'Unrecognized key: "fingerprint"',
              },
            ],
          },
        },
        { status: 400 },
      );
    }

    if (url.pathname === '/v1/tasks/open') {
      // An API from before the signed open list answers 404.
      if (!this.openRoute) return error(404, 'not_found');
      if (this.openReply) return this.openReply();
      const q = OpenTasksRequest.parse(payload);
      const { issuedAt: _, ...sent } = payload as Record<string, unknown>;
      const cursor = (sent as { cursor?: string }).cursor;
      this.opened.push(
        new URLSearchParams(
          Object.entries(sent).map(([k, v]): [string, string] => [
            k,
            String(v),
          ]),
        ).toString(),
      );
      return page({
        state: 'open',
        type: q.taskType,
        cursor,
        limit: q.limit,
        barred: true,
      });
    }

    if (url.pathname === '/v1/tasks') {
      if (this.postReply) return this.postReply();
      const parsed = PostTaskRequest.parse(payload);
      const task = this.add({
        id: parsed.taskId,
        posterAgentId: this.agentId,
        taskType: parsed.taskType,
        spec: parsed.spec,
        verification: parsed.verification,
        ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
        // The API resolves a handle to the agent and answers with both.
        assignee: parsed.assignee
          ? { id: OTHER_AGENT, handle: 'bob/writer' }
          : null,
      });
      return Response.json(task, { status: 201 });
    }
    const id = match?.[1] ?? '';
    if (request.payload.taskId !== id) this.errors.push(`taskId ${id}`);
    const task = this.tasks.get(id);
    if (!task) return error(404, 'not_found');

    switch (match?.[2]) {
      case 'claim': {
        const reply = this.claims.get(id) ?? 'ok';
        if (reply === 409) return error(409, 'already_claimed');
        if (reply === 410) return error(410, 'expired');
        if (reply === 'own_task') return error(400, 'own_task');
        if (reply === 'not_assignee') return error(403, 'not_assignee');
        if (task.assignee && task.assignee.id !== this.agentId) {
          return error(403, 'not_assignee');
        }
        Object.assign(task, {
          state: 'claimed',
          claimantAgentId: this.agentId,
          claimedAt: new Date().toISOString(),
        });
        return Response.json(shown(task));
      }
      case 'submit': {
        if (this.submitReply) return this.submitReply();
        if (
          task.verification.kind === 'hash' &&
          sha256(String(request.payload.submission)) !==
            task.verification.sha256
        ) {
          return error(422, 'verification_failed', 'hash_mismatch');
        }
        const now = new Date().toISOString();
        Object.assign(task, {
          submittedAt: now,
          submission: request.payload.submission,
          ...(task.verification.kind === 'counterparty'
            ? { state: 'submitted' }
            : { state: 'verified', verifiedAt: now }),
        });
        return Response.json(shown(task));
      }
      case 'outcome': {
        if (this.outcomeReply) return this.outcomeReply();
        const reports = this.reports.get(id) ?? new Map<string, string>();
        reports.set(this.agentId, String(request.payload.outcome));
        this.reports.set(id, reports);
        const outcomes = [...reports.values()];
        if (outcomes.length === 2 && outcomes.every((o) => o === 'success')) {
          Object.assign(task, {
            state: 'verified',
            verifiedAt: new Date().toISOString(),
          });
        }
        return Response.json(shown(task));
      }
      case 'submission': {
        this.submissionReads += 1;
        const reply = this.submissionReply?.(this.submissionReads);
        if (reply) return reply;
        if (typeof request.payload.issuedAt !== 'string') {
          this.errors.push('submission read without issuedAt');
        }
        if (task.posterAgentId !== this.agentId) {
          return error(403, 'not_party');
        }
        const reports = this.reports.get(id);
        const reportOf = (who: string | null) =>
          (who && reports?.get(who)) ?? null;
        return Response.json({
          task,
          reports: {
            poster: reportOf(task.posterAgentId),
            claimant: reportOf(task.claimantAgentId),
          },
        });
      }
    }
    return error(404, 'not_found');
  }) as typeof fetch;
}

function error(status: number, code: string, issueCode?: string): Response {
  return Response.json(
    {
      error: {
        code,
        message: `failed with ${code}`,
        ...(issueCode
          ? {
              issues: [
                { path: ['submission'], code: issueCode, message: issueCode },
              ],
            }
          : {}),
      },
    },
    { status },
  );
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('tasks pull, submit and post', () => {
  let home: string;
  let agentId: string;
  let api: FakeApi;
  // What tasks outcome reads its answer from. Unset is no terminal.
  let stdin: Input | undefined;
  // Whether stdout is a terminal, for the guided tasks post.
  let stdoutTTY = false;
  // Files a test wrote next to the home, removed after it.
  let onCleanup: string[] = [];
  // The current directory the commands see. The temp folder, so the files
  // tests write next to the home count as inside it (VOU-229).
  let cwd: string;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({
      tasks: {
        fetch: api.fetch,
        isTTY: () => stdoutTTY,
        ...(stdin === undefined ? {} : { stdin: () => stdin as Input }),
      },
    });
    throwOnExit(program);
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    try {
      await program.parseAsync(args, { from: 'user' });
      return { code: 0, out, err };
    } catch (e) {
      if (e instanceof CommanderError) return { code: e.exitCode, out, err };
      throw e;
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  // Every event in today's local log.
  async function logged(): Promise<{ type: string; payload: unknown }[]> {
    const dir = paths().log;
    const files = await readdir(dir).catch(() => [] as string[]);
    const lines: { type: string; payload: unknown }[] = [];
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
    }
    return lines;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-tasks-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'summariser',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    api = new FakeApi(agentId);
    stdin = undefined;
    stdoutTTY = false;
    onCleanup = [];
    cwd = tmpdir();
    vi.spyOn(process, 'cwd').mockImplementation(() => cwd);
  });

  afterEach(async () => {
    vi.mocked(process.cwd).mockRestore();
    for (const file of onCleanup) {
      await rm(file, { force: true, recursive: true });
    }
    expect(api.errors).toEqual([]);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  describe('without setup', () => {
    it.each([
      ['tasks', 'pull'],
      ['tasks', 'claim', randomUUID()],
      ['tasks', 'submit', randomUUID(), '--text', 'x'],
      [
        'tasks',
        'post',
        '--type',
        'a',
        '--spec',
        '{}',
        '--verify',
        'counterparty',
      ],
    ])('%s %s without config gives the init hint', async (...args) => {
      await rm(paths().config);
      const { code, err } = await run(...args);
      expect(code).toBe(1);
      expect(err).toBe('not initialised, run npx sealkeeper init\n');
      expect(api.requests).toEqual([]);
    });

    it('pull without a key gives the init hint', async () => {
      await rm(paths().key);
      const { code, err } = await run('tasks', 'pull');
      expect(code).toBe(1);
      expect(err).toBe('no key found, run npx sealkeeper init\n');
    });
  });

  describe('pull', () => {
    it('claims the oldest open task of the type, skipping its own', async () => {
      const hour = 3_600_000;
      const at = (ago: number) => new Date(Date.now() - ago).toISOString();
      api.add({ postedAt: at(5 * hour), posterAgentId: agentId });
      api.add({ postedAt: at(4 * hour), taskType: 'translate' });
      const oldest = api.add({
        postedAt: at(3 * hour),
        verification: { kind: 'hash', sha256: sha256('done') },
      });
      api.add({ postedAt: at(2 * hour) });

      const { code, out } = await run(
        'tasks',
        'pull',
        '--type',
        'summarise',
        '--json',
      );
      expect(code).toBe(0);
      const { task } = JSON.parse(out);
      expect(task).toMatchObject({
        id: oldest.id,
        taskType: 'summarise',
        state: 'claimed',
        verification: { kind: 'hash' },
        expiresAt: oldest.expiresAt,
        spec: { words: 100 },
      });
      // A claimant never sees the digest.
      expect(task.verification).toEqual({ kind: 'hash' });
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${oldest.id}/claim`,
      ]);
      expect(api.posts()[0]?.payload).toEqual({ taskId: oldest.id });
      expect(await logged()).toMatchObject([
        {
          type: 'task.claimed',
          version: '1.0.0',
          payload: { task_id: oldest.id, task_type: 'summarise' },
        },
      ]);
    });

    it('reads the next page when its own tasks fill the first', async () => {
      // VOU-208. An agent may have 200 open tasks of its own, more than one
      // page of 100 holds.
      const at = (ago: number) => new Date(Date.now() - ago).toISOString();
      for (let i = 0; i < 150; i++) {
        api.add({ postedAt: at(9e6 - i), posterAgentId: agentId });
      }
      const other = api.add({ postedAt: at(2e6) });
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).task.id).toBe(other.id);
      expect(api.opened).toEqual([
        'limit=100',
        `limit=100&cursor=${pageCursor(100)}`,
      ]);
      expect(api.listed).toEqual([]);
    });

    it('stops paging after MAX_PULL_PAGES pages', async () => {
      for (let i = 0; i < 100 * MAX_PULL_PAGES + 1; i++) {
        api.add({ posterAgentId: agentId });
      }
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ task: null });
      expect(api.opened).toHaveLength(MAX_PULL_PAGES);
    });

    it('prints the task as text', async () => {
      const task = api.add({});
      const { code, out } = await run('tasks', 'pull');
      expect(code).toBe(0);
      expect(out).toContain(`id            ${task.id}`);
      expect(out).toContain('verification  counterparty');
      expect(out).toContain('spec          {"words":100}');
    });

    it('takes a task posted 5 minutes ago, since a person never waits (RT-8)', async () => {
      const young = api.add({
        postedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      });
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).task.id).toBe(young.id);
      expect(api.posts()[0]?.payload).toEqual({ taskId: young.id });
    });

    it('moves on after a 409 or 410', async () => {
      const first = api.add({
        postedAt: new Date(Date.now() - 9e6).toISOString(),
      });
      const second = api.add({
        postedAt: new Date(Date.now() - 8e6).toISOString(),
      });
      const third = api.add({});
      api.claims.set(first.id, 409);
      api.claims.set(second.id, 410);
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).task.id).toBe(third.id);
      expect(api.posts()).toHaveLength(3);
    });

    it(`gives up after ${MAX_CLAIM_ATTEMPTS} lost claims`, async () => {
      for (let i = 0; i < 7; i++) {
        const task = api.add({
          postedAt: new Date(Date.now() - (60 - i) * 60_000).toISOString(),
        });
        api.claims.set(task.id, 409);
      }
      const { code, out } = await run('tasks', 'pull');
      expect(code).toBe(0);
      expect(out).toBe(`${NOTHING_AVAILABLE}\n`);
      expect(api.posts()).toHaveLength(MAX_CLAIM_ATTEMPTS);
      expect(await logged()).toEqual([]);
    });

    it('claims a task from another agent behind a full page of its own', async () => {
      for (let i = 0; i < 50; i++) {
        api.add({
          posterAgentId: agentId,
          postedAt: new Date(Date.now() - (100 - i) * 60_000).toISOString(),
        });
      }
      const other = api.add({});
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).task.id).toBe(other.id);
      expect(api.requests[0]?.path).toBe('/v1/tasks/open');
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${other.id}/claim`,
      ]);
    });

    it('never claims a task it is barred from, which the signed list leaves out', async () => {
      // VOU-200. After three failed submits the claim route refuses the
      // agent with 409 claim_barred until the task expires.
      const barred = api.add({
        postedAt: new Date(Date.now() - 9e6).toISOString(),
      });
      api.barred.add(barred.id);
      api.claims.set(barred.id, 409);
      const other = api.add({});
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).task.id).toBe(other.id);
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${other.id}/claim`,
      ]);
      expect(api.listed).toEqual([]);
    });

    it('reads the public list and moves on past a barred task on an older API', async () => {
      // An API from before POST /v1/tasks/open answers 404, and its list
      // still holds the barred task, so the claim gets 409 and pull moves on.
      api.openRoute = false;
      const barred = api.add({
        postedAt: new Date(Date.now() - 9e6).toISOString(),
      });
      api.barred.add(barred.id);
      api.claims.set(barred.id, 409);
      const other = api.add({ taskType: 'summarise' });
      const { code, out } = await run(
        'tasks',
        'pull',
        '--type',
        'summarise',
        '--json',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).task.id).toBe(other.id);
      expect(api.requests[0]).toMatchObject({
        method: 'POST',
        path: '/v1/tasks/open',
      });
      expect(api.listed).toEqual(['state=open&limit=100&taskType=summarise']);
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${barred.id}/claim`,
        `/v1/tasks/${other.id}/claim`,
      ]);
    });

    it('reads the public list once when the signed read refuses the clock', async () => {
      api.openReply = () => error(400, 'issued_at_out_of_window');
      const task = api.add({});
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).task.id).toBe(task.id);
      expect(api.requests[0]).toMatchObject({
        method: 'POST',
        path: '/v1/tasks/open',
      });
      expect(api.listed).toEqual(['state=open&limit=100']);
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${task.id}/claim`,
      ]);
    });

    it.each([
      [401, 'unknown_agent', 'failed with unknown_agent'],
      [500, 'internal', 'failed with internal'],
    ])(
      'fails on a %i %s from the signed read and never reads the public list',
      async (status, code, message) => {
        api.openReply = () => error(status, code);
        api.add({});
        const result = await run('tasks', 'pull', '--json');
        expect(result.code).toBe(1);
        expect(result.err).toContain(message);
        expect(api.listed).toEqual([]);
        expect(api.posts()).toEqual([]);
      },
    );

    it('reports nothing available as JSON when only own tasks are open', async () => {
      api.add({ posterAgentId: agentId });
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ task: null });
      expect(api.posts()).toEqual([]);
    });
  });

  describe('claim', () => {
    const SEED_AGENT = 'Q'.repeat(43);
    const agentAnswer = (
      id: string,
      login: string,
      name: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      name,
      version: '1.0.0',
      operator: { login },
      createdAt: new Date().toISOString(),
      handle: `${login}/${name}`,
      ...extra,
    });

    beforeEach(() => {
      api.agents.set(OTHER_AGENT, agentAnswer(OTHER_AGENT, 'bob', 'poster'));
      api.agents.set(
        SEED_AGENT,
        agentAnswer(SEED_AGENT, 'sealkeeper', 'sealkeeper-seed', {
          operatedBySealKeeper: true,
        }),
      );
    });

    it('claims exactly the task named, not the oldest of its type', async () => {
      api.add({ postedAt: new Date(Date.now() - 9e6).toISOString() });
      const picked = api.add({});
      const { code, out } = await run('tasks', 'claim', picked.id, '--json');
      expect(code).toBe(0);
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${picked.id}/claim`,
      ]);
      expect(api.posts()[0]?.payload).toEqual({ taskId: picked.id });
      expect(JSON.parse(out)).toEqual({
        task: expect.objectContaining({ id: picked.id, state: 'claimed' }),
        already_held: false,
        poster: {
          agent_id: OTHER_AGENT,
          handle: 'bob/poster',
          seed: false,
          same_operator: false,
        },
        untrusted: true,
        submit: `npx sealkeeper tasks submit ${picked.id} --file <answer file>`,
      });
      expect(await logged()).toMatchObject([
        {
          type: 'task.claimed',
          payload: { task_id: picked.id, task_type: 'summarise' },
        },
      ]);
    });

    it('prints who posted it and that the spec is untrusted', async () => {
      const task = api.add({});
      const { code, out } = await run('tasks', 'claim', task.id);
      expect(code).toBe(0);
      const lines = out.split('\n');
      expect(lines[0]).toBe(`Claimed ${task.id}.`);
      expect(lines[1]).toBe('Posted by bob/poster, operator bob.');
      expect(lines[2]).toBe(UNTRUSTED);
      expect(out).toContain('"words": 100');
      expect(out).toContain(
        `npx sealkeeper tasks submit ${task.id} --text <answer>`,
      );
    });

    it('names a seed task and leaves out the untrusted line', async () => {
      const task = api.add({
        posterAgentId: SEED_AGENT,
        verification: { kind: 'hash', sha256: sha256('x') },
      });
      const { code, out } = await run('tasks', 'claim', task.id);
      expect(code).toBe(0);
      expect(out).toContain(
        'Posted by sealkeeper/sealkeeper-seed, a seed task run by SealKeeper.',
      );
      expect(out).not.toContain(UNTRUSTED);
    });

    it('says when the poster is an agent of the same operator', async () => {
      api.agents.set(OTHER_AGENT, agentAnswer(OTHER_AGENT, 'Alice', 'helper'));
      const task = api.add({});
      const { code, out } = await run('tasks', 'claim', task.id, '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).poster.same_operator).toBe(true);
      const text = await run('tasks', 'claim', api.add({}).id);
      expect(text.out).toContain(SAME_OPERATOR);
    });

    it('still claims when the poster cannot be looked up', async () => {
      api.agents.clear();
      api.anyAgent = false;
      const task = api.add({});
      const { code, out } = await run('tasks', 'claim', task.id);
      expect(code).toBe(0);
      expect(out).toContain(
        `Posted by agent ${OTHER_AGENT}, which the API could not name.`,
      );
      expect(out).toContain(UNTRUSTED);
    });

    it.each([
      ['own_task', OWN_TASK],
      ['not_assignee', NOT_ASSIGNEE],
      [409, ALREADY_CLAIMED],
      [410, CLAIM_EXPIRED],
    ] as const)('refuses %s in one line', async (reply, message) => {
      const task = api.add({});
      api.claims.set(task.id, reply);
      const { code, out, err } = await run('tasks', 'claim', task.id);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe(`${message}\n`);
      expect(await logged()).toEqual([]);
    });

    it('refuses an unknown task in one line', async () => {
      const { code, err } = await run('tasks', 'claim', randomUUID());
      expect(code).toBe(1);
      expect(err).toBe(`${NOT_FOUND}\n`);
    });

    it('prints a task this agent already holds again, without logging it twice', async () => {
      const task = api.add({
        state: 'claimed',
        claimantAgentId: agentId,
        claimedAt: new Date().toISOString(),
      });
      api.claims.set(task.id, 409);
      const { code, out } = await run('tasks', 'claim', task.id);
      expect(code).toBe(0);
      expect(out.split('\n')[0]).toBe(`This agent already holds ${task.id}.`);
      expect(await logged()).toEqual([]);
    });

    it('refuses anything but a full task id before any request', async () => {
      const { code, err } = await run('tasks', 'claim', 'abcd1234');
      expect(code).toBe(1);
      expect(err).toBe(
        'abcd1234 is not a task id, copy the full id from the board\n',
      );
      expect(api.requests).toEqual([]);
    });
  });

  describe('submit', () => {
    function claimed(verification: VerificationSpec): TaskResponse {
      return api.add({
        verification,
        state: 'claimed',
        claimantAgentId: agentId,
        claimedAt: new Date().toISOString(),
      });
    }

    it('leaves a hash answer to the server, which it never sees the digest of', async () => {
      const task = claimed({ kind: 'hash', sha256: sha256('right') });
      const { code, err } = await run(
        'tasks',
        'submit',
        task.id,
        '--text',
        'wrong',
      );
      expect(code).toBe(1);
      expect(err).toContain('verification failed: hash_mismatch');
      expect(err).not.toContain(sha256('right'));
      expect(api.posts()).toHaveLength(1);
      expect(await logged()).toEqual([]);
    });

    it('submits a matching hash from a file and prints verified', async () => {
      const task = api.add({
        verification: { kind: 'hash', sha256: sha256('the answer\n') },
        spec: { output: 'The answer, and end with exactly one line feed.' },
        state: 'claimed',
        claimantAgentId: agentId,
        claimedAt: new Date().toISOString(),
      });
      // Outside the SealKeeper home, which submit refuses to read from.
      const file = `${home}-answer.txt`;
      await writeFile(file, 'the answer\n');
      const { code, out } = await run(
        'tasks',
        'submit',
        task.id,
        '--file',
        file,
      ).finally(() => rm(file, { force: true }));
      expect(code).toBe(0);
      expect(out).toContain('state  verified');
      expect(out).not.toContain(sha256('the answer\n'));
      expect(api.posts()).toHaveLength(1);
      expect(api.posts()[0]?.payload).toEqual({
        taskId: task.id,
        submission: 'the answer\n',
      });
      expect(await logged()).toMatchObject([
        {
          type: 'task.submitted',
          payload: { task_id: task.id, task_type: 'summarise' },
        },
      ]);
    });

    it('refuses a hash answer that ends in a line break, sending nothing', async () => {
      const task = claimed({ kind: 'hash', sha256: sha256('Oslo') });
      const file = `${home}-answer.txt`;
      await writeFile(file, 'Oslo\n');
      const fromFile = await run(
        'tasks',
        'submit',
        task.id,
        '--file',
        file,
      ).finally(() => rm(file, { force: true }));
      expect(fromFile.code).toBe(1);
      expect(fromFile.err).toContain('the answer ends in a line break');
      expect(fromFile.err).toContain('a claim allows 3 failed submits');
      expect(fromFile.err).toContain('add --keep-newline to send it as is');
      const crlf = await run('tasks', 'submit', task.id, '--text', 'Oslo\r\n');
      expect(crlf.code).toBe(1);
      expect(crlf.err).toContain('the answer ends in a line break');
      expect(api.posts()).toEqual([]);
      expect(await logged()).toEqual([]);
    });

    it('sends a hash answer with its line break as is under --keep-newline', async () => {
      const task = claimed({ kind: 'hash', sha256: sha256('Oslo\n') });
      const { code, out } = await run(
        'tasks',
        'submit',
        task.id,
        '--text',
        'Oslo\n',
        '--keep-newline',
      );
      expect(code).toBe(0);
      expect(out).toContain('state  verified');
      expect(api.posts()[0]?.payload).toEqual({
        taskId: task.id,
        submission: 'Oslo\n',
      });
    });

    it('leaves the line break of a counterparty or schema answer alone', async () => {
      const counterparty = claimed({ kind: 'counterparty' });
      expect(
        (await run('tasks', 'submit', counterparty.id, '--text', 'done\n'))
          .code,
      ).toBe(0);
      const schema = claimed({
        kind: 'schema',
        jsonSchema: { type: 'object' },
      });
      expect(
        (await run('tasks', 'submit', schema.id, '--text', '{}\n')).code,
      ).toBe(0);
      expect(api.posts().map((r) => r.path)).toContain(
        `/v1/tasks/${schema.id}/submit`,
      );
    });

    it('refuses invalid JSON for a schema task locally', async () => {
      const task = claimed({ kind: 'schema', jsonSchema: { type: 'object' } });
      const { code, err } = await run(
        'tasks',
        'submit',
        task.id,
        '--text',
        '{',
      );
      expect(code).toBe(1);
      expect(err).toContain('not valid JSON');
      expect(api.posts()).toEqual([]);
    });

    it('in a routine run notes the operator as barred on the first failure of a network claim (RT-8)', async () => {
      vi.stubEnv('SEALKEEPER_ROUTINE_RUN', 'run-1');
      const task = claimed({ kind: 'hash', sha256: sha256('right') });
      const seed = claimed({ kind: 'hash', sha256: sha256('right') });
      await appendRoutine({
        kind: 'claim',
        runId: 'run-1',
        taskId: task.id,
        network: true,
        operator: 'bob',
      });
      await appendRoutine({ kind: 'claim', runId: 'run-1', taskId: seed.id });
      const dir = await realpath(
        await mkdtemp(join(tmpdir(), 'sealkeeper-rt8-')),
      );
      onCleanup.push(dir);
      await mkdir(join(dir, '.sealkeeper-answers'), { recursive: true });
      await writeFile(join(dir, '.sealkeeper-answers', 'a.txt'), 'wrong');
      cwd = dir;
      for (const id of [task.id, seed.id]) {
        const { code } = await run(
          'tasks',
          'submit',
          id,
          '--file',
          '.sealkeeper-answers/a.txt',
        );
        expect(code).toBe(1);
      }
      expect(
        (await readRoutine()).filter((e) => e.kind === 'barred'),
      ).toMatchObject([{ taskId: task.id, operator: 'bob' }]);
    });

    it('outside a routine run notes nothing on a failure that leaves the claim', async () => {
      const task = claimed({ kind: 'hash', sha256: sha256('right') });
      const { code } = await run('tasks', 'submit', task.id, '--text', 'wrong');
      expect(code).toBe(1);
      expect((await readRoutine()).filter((e) => e.kind === 'barred')).toEqual(
        [],
      );
      // The failure that ends the claim is noted with the poster's operator.
      Object.assign(task, { state: 'open', claimantAgentId: null });
      api.submitReply = () =>
        error(422, 'verification_failed', 'hash_mismatch');
      expect((await run('tasks', 'submit', task.id, '--text', 'x')).code).toBe(
        1,
      );
      expect(
        (await readRoutine()).filter((e) => e.kind === 'barred'),
      ).toMatchObject([{ taskId: task.id, operator: 'bob' }]);
    });

    it('prints the reason code of a 422', async () => {
      const task = claimed({ kind: 'schema', jsonSchema: { type: 'object' } });
      api.submitReply = () =>
        error(422, 'verification_failed', 'schema_mismatch');
      const { code, err } = await run(
        'tasks',
        'submit',
        task.id,
        '--text',
        '[1]',
      );
      expect(code).toBe(1);
      expect(err).toContain('verification failed: schema_mismatch');
      expect(await logged()).toEqual([]);
    });

    it('submits a counterparty task, then reports success', async () => {
      const task = claimed({ kind: 'counterparty' });
      const { code, out } = await run(
        'tasks',
        'submit',
        task.id,
        '--text',
        'done',
        '--json',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        id: task.id,
        state: 'submitted',
        verification: 'counterparty',
        awaitingPoster: true,
      });
      expect(api.posts().map((r) => [r.path, r.payload])).toEqual([
        [
          `/v1/tasks/${task.id}/submit`,
          { taskId: task.id, submission: 'done' },
        ],
        [
          `/v1/tasks/${task.id}/outcome`,
          { taskId: task.id, outcome: 'success' },
        ],
      ]);
      expect((await logged()).map((e) => e.type)).toEqual([
        'task.submitted',
        'task.outcome',
      ]);
      expect((await logged())[1]?.payload).toEqual({
        task_id: task.id,
        outcome: 'success',
      });
    });

    it('says to run npx sealkeeper tasks submit again when the outcome fails', async () => {
      const task = claimed({ kind: 'counterparty' });
      api.outcomeReply = () => error(503, 'unavailable');
      const { code, err } = await run(
        'tasks',
        'submit',
        task.id,
        '--text',
        'done',
      );
      expect(code).toBe(1);
      expect(err).toContain('submitted, but reporting the outcome failed');
      expect(err).toContain('Run npx sealkeeper tasks submit again to retry');
    });

    it('says the poster must confirm in text mode', async () => {
      const task = claimed({ kind: 'counterparty' });
      const { out } = await run('tasks', 'submit', task.id, '--text', 'done');
      expect(out).toContain('state  submitted');
      expect(out).toContain(AWAITING_POSTER);
    });

    it('refuses a file inside the SealKeeper home without sending it', async () => {
      const task = claimed({ kind: 'counterparty' });
      const { code, err } = await run(
        'tasks',
        'submit',
        task.id,
        '--file',
        paths(home).key,
      );
      expect(code).toBe(1);
      expect(err).toContain('refusing to submit');
      expect(err).toContain("holds this agent's private key");
      expect(api.posts()).toEqual([]);
    });

    it('refuses an answer that contains the private key', async () => {
      const task = claimed({ kind: 'counterparty' });
      const seed = (await readFile(paths(home).key, 'utf8')).trim();
      const answer = `${home}-answer.txt`;
      await writeFile(answer, `here it is: ${seed}`);
      const { code, err } = await run(
        'tasks',
        'submit',
        task.id,
        '--file',
        answer,
      ).finally(() => rm(answer, { force: true }));
      expect(code).toBe(1);
      expect(err).toContain("the answer contains this agent's private key");
      expect(api.posts()).toEqual([]);
    });

    it('needs exactly one of --file and --text', async () => {
      const { code, err } = await run('tasks', 'submit', randomUUID());
      expect(code).toBe(1);
      expect(err).toContain('exactly one of');
      expect(api.requests).toEqual([]);
    });

    describe('which files --file reads (VOU-229)', () => {
      // A folder of its own for each test, removed after it.
      let dir: string;
      beforeEach(async () => {
        dir = await realpath(
          await mkdtemp(join(tmpdir(), 'sealkeeper-vou229-')),
        );
      });
      afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      async function fileIn(folder: string, name: string, text: string) {
        await mkdir(folder, { recursive: true });
        const file = join(folder, name);
        await writeFile(file, text);
        return file;
      }

      it('in a routine run reads only from .sealkeeper-answers in the current directory', async () => {
        vi.stubEnv('SEALKEEPER_ROUTINE_RUN', 'run-1');
        cwd = join(dir, 'work');
        const task = claimed({ kind: 'counterparty' });
        const outside = await fileIn(cwd, 'answer.txt', 'outside');
        const refused = await run(
          'tasks',
          'submit',
          task.id,
          '--file',
          outside,
        );
        expect(refused.code).toBe(1);
        expect(refused.err).toContain(`refusing to submit ${outside}`);
        expect(refused.err).toContain(join(cwd, '.sealkeeper-answers'));
        // The flag changes nothing in a routine run.
        const flagged = await run(
          'tasks',
          'submit',
          task.id,
          '--file',
          outside,
          '--allow-outside-cwd',
        );
        expect(flagged.code).toBe(1);
        expect(api.posts()).toEqual([]);

        await fileIn(join(cwd, '.sealkeeper-answers'), 'a.txt', 'inside');
        const read = await run(
          'tasks',
          'submit',
          task.id,
          '--file',
          '.sealkeeper-answers/a.txt',
        );
        expect(read.err).toBe('');
        expect(read.code).toBe(0);
        expect(api.posts()[0]?.payload).toEqual({
          taskId: task.id,
          submission: 'inside',
        });
      });

      it('refuses a symlink from .sealkeeper-answers to a file outside it', async () => {
        vi.stubEnv('SEALKEEPER_ROUTINE_RUN', 'run-1');
        cwd = join(dir, 'work');
        const task = claimed({ kind: 'counterparty' });
        const secret = await fileIn(dir, 'secret.txt', 'secret');
        await mkdir(join(cwd, '.sealkeeper-answers'), { recursive: true });
        const link = join(cwd, '.sealkeeper-answers', 'a.txt');
        await symlink(secret, link);
        const { code, err } = await run(
          'tasks',
          'submit',
          task.id,
          '--file',
          link,
        );
        expect(code).toBe(1);
        expect(err).toContain(`refusing to submit ${link}`);
        expect(api.posts()).toEqual([]);
      });

      it('never reads a hidden folder of the home, even inside the current directory or with the flag', async () => {
        const userHome = join(dir, 'home');
        vi.stubEnv('HOME', userHome);
        vi.stubEnv('USERPROFILE', userHome);
        cwd = userHome;
        const task = claimed({ kind: 'counterparty' });
        const token = await fileIn(
          join(userHome, '.config', 'gh'),
          'hosts.yml',
          'oauth_token: gho_x',
        );
        const ssh = await fileIn(join(userHome, '.ssh'), 'id_ed25519', 'key');
        for (const file of [token, ssh, '.config/gh/hosts.yml']) {
          for (const extra of [[], ['--allow-outside-cwd']]) {
            const { code, err } = await run(
              'tasks',
              'submit',
              task.id,
              '--file',
              file,
              ...extra,
            );
            expect(code, file).toBe(1);
            expect(err).toContain('a hidden file or folder in your home');
          }
        }
        expect(api.posts()).toEqual([]);
      });

      it('refuses a file outside the current directory unless --allow-outside-cwd is given', async () => {
        cwd = join(dir, 'work');
        await mkdir(cwd);
        const task = claimed({ kind: 'counterparty' });
        const file = await fileIn(join(dir, 'elsewhere'), 'answer.txt', 'done');
        const refused = await run('tasks', 'submit', task.id, '--file', file);
        expect(refused.code).toBe(1);
        expect(refused.err).toContain('outside the current directory');
        expect(refused.err).toContain('--allow-outside-cwd');
        expect(api.posts()).toEqual([]);
        const allowed = await run(
          'tasks',
          'submit',
          task.id,
          '--file',
          file,
          '--allow-outside-cwd',
        );
        expect(allowed.code).toBe(0);
        expect(api.posts()[0]?.payload).toEqual({
          taskId: task.id,
          submission: 'done',
        });
      });

      it('refuses a file over the size cap, a folder and a device before reading them', async () => {
        cwd = dir;
        const task = claimed({ kind: 'counterparty' });
        // Sparse, so it takes no room on disk and reading it would take long.
        const big = join(dir, 'big.txt');
        await writeFile(big, '');
        await truncate(big, 1024 ** 3);
        const tooBig = await run('tasks', 'submit', task.id, '--file', big);
        expect(tooBig.code).toBe(1);
        expect(tooBig.err).toContain(
          `it is ${1024 ** 3} bytes and the most allowed is ${MAX_SUBMISSION_BYTES}`,
        );
        const folder = await run('tasks', 'submit', task.id, '--file', dir);
        expect(folder.code).toBe(1);
        expect(folder.err).toContain('it is not a regular file');
        if (process.platform !== 'win32') {
          const zero = await run(
            'tasks',
            'submit',
            task.id,
            '--file',
            '/dev/zero',
            '--allow-outside-cwd',
          );
          expect(zero.code).toBe(1);
          expect(zero.err).toContain('it is not a regular file');
        }
        expect(api.posts()).toEqual([]);
      });
    });
  });

  describe('post', () => {
    const hash = sha256('expected output');

    it.each([
      [`hash:${hash}`, { kind: 'hash', sha256: hash }],
      ['counterparty', { kind: 'counterparty' }],
    ])('posts a %s task', async (verify, verification) => {
      const { code, out } = await run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '{"words":100}',
        '--verify',
        verify,
        '--json',
      );
      expect(code).toBe(0);
      const payload = api.posts()[0]?.payload;
      expect(PostTaskRequest.parse(payload)).toEqual({
        taskId: expect.any(String),
        taskType: 'summarise',
        spec: { words: 100 },
        verification,
      });
      expect(JSON.parse(out)).toMatchObject({
        id: payload?.taskId,
        state: 'open',
      });
      // An open task has no assignee, so the key is left out.
      expect(JSON.parse(out)).not.toHaveProperty('assignee');
      expect(await logged()).toEqual([]);
    });

    it('posts a schema task with the schema and spec read from files', async () => {
      // Outside the SealKeeper home, which tasks post never reads from.
      const schemaFile = `${home}-schema.json`;
      const specFile = `${home}-spec.json`;
      onCleanup.push(schemaFile, specFile);
      await writeFile(schemaFile, '{"type":"object","required":["title"]}');
      await writeFile(specFile, '{"source":"https://example.com"}');
      const { code, out } = await run(
        'tasks',
        'post',
        '--type',
        'extract',
        '--spec',
        `@${specFile}`,
        '--verify',
        `schema:@${schemaFile}`,
        '--expires-hours',
        '2',
      );
      expect(code).toBe(0);
      const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
      expect(payload.verification).toEqual({
        kind: 'schema',
        jsonSchema: { type: 'object', required: ['title'] },
      });
      expect(payload.spec).toEqual({ source: 'https://example.com' });
      // A plain post leaves origin out, which the API reads as manual.
      expect(payload).not.toHaveProperty('origin');
      const ttl = Date.parse(payload.expiresAt ?? '') - Date.now();
      expect(ttl).toBeGreaterThan(1.9 * 3_600_000);
      expect(ttl).toBeLessThanOrEqual(2 * 3_600_000);
      expect(out).toContain(`id       ${payload.taskId}`);
      expect(out).toContain('state    open');
    });

    it('posts the --category and --size it is given (RT-2)', async () => {
      const { code } = await run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '{}',
        '--verify',
        'counterparty',
        '--category',
        'research',
        '--size',
        'm',
      );
      expect(code).toBe(0);
      expect(PostTaskRequest.parse(api.posts()[0]?.payload)).toMatchObject({
        category: 'research',
        size: 'm',
      });
    });

    it('leaves category and size out when not given, for the API to derive', async () => {
      const { code } = await run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '{}',
        '--verify',
        'counterparty',
      );
      expect(code).toBe(0);
      const payload = api.posts()[0]?.payload;
      expect(payload).not.toHaveProperty('category');
      expect(payload).not.toHaveProperty('size');
    });

    it.each([
      [['--category', 'cooking'], badCategory('cooking')],
      [['--category', 'Data'], badCategory('Data')],
      [['--size', 'l'], badSize('l')],
    ])('refuses %j before anything is read or sent', async (flags, message) => {
      const { code, err } = await run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '@/no/such/file',
        '--verify',
        'counterparty',
        ...flags,
      );
      expect(code).toBe(1);
      expect(err).toBe(`${message}\n`);
      expect(api.requests).toEqual([]);
    });

    it('says an API from before the fields does not take category or size', async () => {
      // What an API before RT-2 answers, its strict payload refusing both.
      api.postReply = () =>
        Response.json(
          {
            error: {
              code: 'validation_failed',
              message: 'Invalid payload',
              issues: [
                {
                  path: [],
                  code: 'unrecognized_keys',
                  message: 'Unrecognized keys: "category", "size"',
                },
              ],
            },
          },
          { status: 400 },
        );
      const { code, err } = await run(
        'tasks',
        'post',
        '--template',
        'text_dedupe',
        '--yes',
      );
      expect(code).toBe(1);
      expect(err).toBe(`${API_TOO_OLD_FOR_FIELDS}\n`);
    });

    it('names the fields by path too, and leaves other validation refusals alone', () => {
      const failed = (path: string[]) =>
        new ApiError(400, 'validation_failed', 'Invalid payload', [
          { path, code: 'invalid_value', message: 'Invalid option' },
        ]);
      expect(postRefusal(failed(['size']), undefined)).toBe(
        API_TOO_OLD_FOR_FIELDS,
      );
      expect(postRefusal(failed(['spec']), undefined)).not.toBe(
        API_TOO_OLD_FOR_FIELDS,
      );
    });

    it('refuses --category and --size beside --template', async () => {
      const { code, err } = await run(
        'tasks',
        'post',
        '--template',
        'text_dedupe',
        '--yes',
        '--category',
        'code',
      );
      expect(code).toBe(1);
      expect(err).toContain(TEMPLATE_SETS_FIELDS);
      expect(api.requests).toEqual([]);
    });

    it.each([
      ['hash:abc', 'sha256 as 64 hex'],
      ['nonsense', '--verify must be'],
    ])('rejects --verify %s', async (verify, message) => {
      const { code, err } = await run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '{}',
        '--verify',
        verify,
      );
      expect(code).toBe(1);
      expect(err).toContain(message);
      expect(api.requests).toEqual([]);
    });
  });

  describe('post from a template or the guided flow', () => {
    // A terminal that answers each question in turn, then closes.
    function answers(...lines: string[]): Input & { reads: number } {
      const queue = [...lines];
      const input = {
        isTTY: true,
        reads: 0,
        readLine: async () => {
          input.reads += 1;
          return queue.shift() ?? null;
        },
      };
      return input;
    }

    it('refuses no options without a terminal and sends nothing', async () => {
      const { code, err } = await run('tasks', 'post');
      expect(code).toBe(1);
      expect(err).toBe(`${NO_TERMINAL}\n`);
      expect(NO_TERMINAL).toBe(
        'nothing posted. Give --type, --spec and --verify, or --template <id> with --yes. In a terminal, npx sealkeeper tasks post with no options walks you through it',
      );
      expect(api.requests).toEqual([]);
    });

    it('refuses no options with --json even in a terminal', async () => {
      stdoutTTY = true;
      stdin = answers('1');
      const { code, err } = await run('tasks', 'post', '--json');
      expect(code).toBe(1);
      expect(err).toBe(`${NO_OPTIONS_JSON}\n`);
      expect(api.requests).toEqual([]);
    });

    it('refuses --yes without --template', async () => {
      const { code, err } = await run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '{}',
        '--verify',
        'counterparty',
        '--yes',
      );
      expect(code).toBe(1);
      expect(err).toContain('--yes goes with --template');
      expect(api.requests).toEqual([]);
    });

    it.each([
      [
        '--input',
        (key: string) => [
          '--template',
          'summarise',
          '--input',
          `@${key}`,
          '--yes',
        ],
      ],
      [
        '--spec',
        (key: string) => [
          '--type',
          'x',
          '--spec',
          `@${key}`,
          '--verify',
          'counterparty',
        ],
      ],
      [
        '--verify schema:',
        (key: string) => [
          '--type',
          'x',
          '--spec',
          '{}',
          '--verify',
          `schema:@${key}`,
        ],
      ],
    ])('never reads a %s file inside the SealKeeper home', async (_, args) => {
      const key = paths(home).key;
      const { code, err } = await run('tasks', 'post', ...args(key));
      expect(code).toBe(1);
      expect(err).toContain(`refusing to read ${key}`);
      expect(err).toContain("which holds this agent's private key");
      expect(api.requests).toEqual([]);
    });

    it('refuses a task that holds the private key, as input text, a file or a spec', async () => {
      const seed = (await readFile(paths(home).key, 'utf8')).trim();
      const file = `${home}-leak.txt`;
      onCleanup.push(file);
      await writeFile(file, `${'word '.repeat(45)}${seed}`);
      for (const args of [
        [
          '--template',
          'answer_question',
          '--input',
          `What is ${seed}?`,
          '--yes',
        ],
        ['--template', 'summarise', '--input', `@${file}`, '--yes'],
        [
          '--type',
          'x',
          '--spec',
          JSON.stringify({ input: seed }),
          '--verify',
          'counterparty',
        ],
      ]) {
        const { code, err } = await run('tasks', 'post', ...args);
        expect(code, args.join(' ')).toBe(1);
        expect(err).toContain(KEY_IN_TASK);
      }
      expect(api.requests).toEqual([]);
    });

    it('refuses a key split across lines or spaced out, and warns about a loose key file once', async () => {
      const key = paths(home).key;
      const seed = (await readFile(key, 'utf8')).trim();
      const half = Math.floor(seed.length / 2);
      const split = `${seed.slice(0, half)}\n${seed.slice(half)}`;
      const spaced = seed.replace(/(.{8})/g, '$1 ');
      const file = `${home}-split.txt`;
      onCleanup.push(file);
      await writeFile(file, `${'word '.repeat(45)}\n${split}\n`);
      await chmod(key, 0o644);
      let errs = '';
      for (const args of [
        ['--template', 'summarise', '--input', `@${file}`, '--yes'],
        [
          '--template',
          'answer_question',
          '--input',
          `Is ${spaced} a key?`,
          '--yes',
        ],
        [
          '--type',
          'x',
          '--spec',
          JSON.stringify({ input: { lines: [`key ${split}`] } }),
          '--verify',
          'counterparty',
        ],
      ]) {
        const { code, err } = await run('tasks', 'post', ...args);
        expect(code, args.join(' ')).toBe(1);
        expect(err).toContain(KEY_IN_TASK);
        errs += err;
      }
      // The key is loaded once, however many times it is checked, so its
      // loose mode is warned about once.
      expect(errs.split('warning: key file')).toHaveLength(2);
      expect(api.requests).toEqual([]);
    });

    it('refuses the key in guided input and asks again', async () => {
      stdoutTTY = true;
      const seed = (await readFile(paths(home).key, 'utf8')).trim();
      stdin = answers('answer_question', `What is ${seed} for?`, '');
      const { code, out } = await run('tasks', 'post');
      expect(code).toBe(0);
      expect(out).toContain(KEY_IN_TASK);
      expect(out.trimEnd().endsWith(NOTHING_POSTED)).toBe(true);
      expect(api.requests).toEqual([]);
    });

    it('with --json and a terminal, shows the task on stderr and keeps stdout empty on no', async () => {
      stdin = answers('n');
      const { code, out, err } = await run(
        'tasks',
        'post',
        '--template',
        'json_shape',
        '--json',
      );
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('type     json_shape');
      expect(err.trimEnd().endsWith(NOT_POSTED)).toBe(true);
      expect(api.posts()).toEqual([]);
    });

    it('checks --for against its own operator before the guided walk asks anything', async () => {
      stdoutTTY = true;
      const input = answers('1', '', 'y');
      stdin = input;
      const { code, err } = await run('tasks', 'post', '--for', 'alice/other');
      expect(code).toBe(1);
      expect(err).toContain(sameOperator('alice/other'));
      expect(input.reads).toBe(0);
      expect(api.requests).toEqual([]);
    });

    it('checks the guided walk --for against the stored slug (VOU-196)', async () => {
      await saveOperatorSlug(agentId, 'alice-dev');
      stdoutTTY = true;
      const input = answers('1', '', 'y');
      stdin = input;
      const { code, err } = await run(
        'tasks',
        'post',
        '--for',
        'alice-dev/other',
      );
      expect(code).toBe(1);
      expect(err).toContain(sameOperator('alice-dev/other'));
      expect(input.reads).toBe(0);
      expect(api.requests).toEqual([]);
    });

    it('still names a missing option when some are given', async () => {
      const { code, err } = await run('tasks', 'post', '--type', 'summarise');
      expect(code).toBe(1);
      expect(err).toContain("required option '--spec <json>' not specified");
      expect(api.requests).toEqual([]);
    });

    it.each([
      [['--template', 'nope', '--yes'], 'no template nope, pick one of'],
      [
        ['--template', 'line_sort', '--type', 'x', '--yes'],
        '--template replaces --type',
      ],
      [['--input', 'x', '--type', 'x'], '--input goes with --template'],
      [
        ['--template', 'json_shape', '--input', 'x', '--yes'],
        'json_shape takes no --input',
      ],
      [['--template', 'summarise', '--yes'], 'summarise needs --input'],
      [
        ['--template', 'text_dedupe', '--input', 'a', '--yes'],
        '--input does not fit text_dedupe, no line repeats',
      ],
      [
        ['--template', 'summarise', '--input', '@/no/such/file', '--yes'],
        'could not read the input file /no/such/file',
      ],
    ])('refuses %j before sending', async (args, message) => {
      const { code, err } = await run('tasks', 'post', ...args);
      expect(code).toBe(1);
      expect(err).toContain(message);
      expect(api.requests).toEqual([]);
    });

    it('reads --input @file under the same rules as tasks submit --file (VOU-229)', async () => {
      const dir = await realpath(
        await mkdtemp(join(tmpdir(), 'sealkeeper-vou229-')),
      );
      try {
        const userHome = join(dir, 'home');
        vi.stubEnv('HOME', userHome);
        vi.stubEnv('USERPROFILE', userHome);
        cwd = join(dir, 'work');
        await mkdir(cwd, { recursive: true });
        await mkdir(join(userHome, '.aws'), { recursive: true });
        const hidden = join(userHome, '.aws', 'credentials');
        await writeFile(hidden, 'aws_secret_access_key = x');
        const outside = join(dir, 'text.txt');
        await writeFile(outside, 'The harbor opens at dawn. '.repeat(10));
        const big = join(cwd, 'big.txt');
        await writeFile(big, '');
        await truncate(big, MAX_INPUT_FILE_BYTES + 1);
        const post = (file: string, ...extra: string[]) =>
          run(
            'tasks',
            'post',
            '--template',
            'summarise',
            '--input',
            `@${file}`,
            '--yes',
            ...extra,
          );

        const secret = await post(hidden, '--allow-outside-cwd');
        expect(secret.code).toBe(1);
        expect(secret.err).toContain(`refusing to read ${hidden}`);
        expect(secret.err).toContain('a hidden file or folder in your home');
        const tooBig = await post(big);
        expect(tooBig.code).toBe(1);
        expect(tooBig.err).toContain(
          `the most allowed is ${MAX_INPUT_FILE_BYTES}`,
        );
        const away = await post(outside);
        expect(away.code).toBe(1);
        expect(away.err).toContain('outside the current directory');
        expect(api.requests).toEqual([]);

        const allowed = await post(outside, '--allow-outside-cwd');
        expect(allowed.code).toBe(0);
        expect(api.posts()).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads --spec and --verify schema: files under the same rules (VOU-241)', async () => {
      const dir = await realpath(
        await mkdtemp(join(tmpdir(), 'sealkeeper-vou241-')),
      );
      try {
        const userHome = join(dir, 'home');
        vi.stubEnv('HOME', userHome);
        vi.stubEnv('USERPROFILE', userHome);
        cwd = join(dir, 'work');
        await mkdir(cwd, { recursive: true });
        await mkdir(join(userHome, '.config'), { recursive: true });
        const hidden = join(userHome, '.config', 'spec.json');
        await writeFile(hidden, '{"source":"x"}');
        const outside = join(dir, 'spec.json');
        await writeFile(outside, '{"source":"https://example.com"}');
        const schema = join(dir, 'schema.json');
        await writeFile(schema, '{"type":"object"}');
        const big = join(cwd, 'big.json');
        await writeFile(big, '');
        await truncate(big, MAX_TASK_SPEC_BYTES + 1);
        const post = (spec: string, verify: string, ...extra: string[]) =>
          run(
            'tasks',
            'post',
            '--type',
            'extract',
            '--spec',
            spec,
            '--verify',
            verify,
            ...extra,
          );
        const inline = '{"source":"https://example.com"}';

        const secret = await post(
          `@${hidden}`,
          'counterparty',
          '--allow-outside-cwd',
        );
        expect(secret.code).toBe(1);
        expect(secret.err).toContain(`refusing to read ${hidden}`);
        expect(secret.err).toContain('a hidden file or folder in your home');
        const tooBig = await post(`@${big}`, 'counterparty');
        expect(tooBig.code).toBe(1);
        expect(tooBig.err).toContain(
          `the most allowed is ${MAX_TASK_SPEC_BYTES}`,
        );
        const folder = await post(`@${cwd}`, 'counterparty');
        expect(folder.code).toBe(1);
        expect(folder.err).toContain('it is not a regular file');
        const away = await post(`@${outside}`, 'counterparty');
        expect(away.code).toBe(1);
        expect(away.err).toContain('outside the current directory');
        const awaySchema = await post(inline, `schema:@${schema}`);
        expect(awaySchema.code).toBe(1);
        expect(awaySchema.err).toContain(`refusing to read ${schema}`);
        expect(api.requests).toEqual([]);

        const allowed = await post(
          `@${outside}`,
          `schema:@${schema}`,
          '--allow-outside-cwd',
        );
        expect(allowed.code).toBe(0);
        const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
        expect(payload.spec).toEqual({ source: 'https://example.com' });
        expect(payload.verification).toEqual({
          kind: 'schema',
          jsonSchema: { type: 'object' },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses a template without --yes and without a terminal, before anything else', async () => {
      const { code, err } = await run(
        'tasks',
        'post',
        '--template',
        'summarise',
        '--input',
        '@/no/such/file',
      );
      expect(code).toBe(1);
      expect(err).toBe(`${templateNeedsYes('summarise')}\n`);
      expect(api.requests).toEqual([]);
    });

    it('posts a drawn hash template with --yes and the sha256 of its answer', async () => {
      const { code, out } = await run(
        'tasks',
        'post',
        '--template',
        'text_dedupe',
        '--yes',
        '--json',
      );
      expect(code).toBe(0);
      const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
      expect(payload.taskType).toBe('text_dedupe');
      // A template post says so, for the gold rule (VOU-134).
      expect(payload.origin).toBe('template');
      // And carries the template's category and size (RT-2).
      expect(payload).toMatchObject({ category: 'data', size: 's' });
      const input = String(payload.spec.input);
      const answer = `${[...new Set(input.split('\n'))].join('\n')}\n`;
      expect(payload.verification).toEqual({
        kind: 'hash',
        sha256: sha256(answer),
      });
      // The answer itself never leaves the machine.
      expect(JSON.stringify(api.posts()[0]?.payload)).not.toContain(
        JSON.stringify(answer),
      );
      expect(JSON.parse(out)).toMatchObject({ id: payload.taskId });
    });

    it('posts a counterparty template from an input file, addressed with --for', async () => {
      const file = `${home}-text.txt`;
      onCleanup.push(file);
      const text = 'The harbor opens at dawn and closes at dusk. '.repeat(6);
      await writeFile(file, `${text}\n`);
      const { code, out } = await run(
        'tasks',
        'post',
        '--template',
        'summarise',
        '--input',
        `@${file}`,
        '--for',
        'bob/writer',
        '--yes',
      );
      expect(code).toBe(0);
      const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
      expect(payload).toMatchObject({
        taskType: 'summarise',
        verification: { kind: 'counterparty' },
        assignee: 'bob/writer',
      });
      expect(payload.spec.input).toBe(text);
      expect(out).toContain('for      bob/writer');
      expect(out).toContain('You judge the result.');
    });

    it('with a terminal and no --yes, shows the task and posts nothing on no', async () => {
      stdin = answers('n');
      const { code, out, err } = await run(
        'tasks',
        'post',
        '--template',
        'json_shape',
      );
      expect(code).toBe(1);
      expect(err).toBe(`Post it? [y/N] ${NOT_POSTED}\n`);
      expect(out).toContain('type     json_shape');
      expect(out).toContain(
        'check    schema, SealKeeper checks the answer on submit',
      );
      expect(out).toContain('The spec is public on sealkeeper.run');
      expect(out).not.toContain(NOTHING_POSTED);
      expect(api.posts()).toEqual([]);
    });

    it('with a terminal and no --yes, posts on y', async () => {
      stdin = answers('y');
      const { code } = await run('tasks', 'post', '--template', 'line_sort');
      expect(code).toBe(0);
      expect(api.posts()).toHaveLength(1);
    });

    it('walks through a post in a terminal and posts only on yes', async () => {
      stdoutTTY = true;
      stdin = answers('2', '', 'bob/writer', 'y');
      const { code, out, err } = await run('tasks', 'post');
      expect(code).toBe(0);
      expect(out).toContain(
        ' 2  line_sort        hash          Sort the lines of a text. SealKeeper checks the answer.',
      );
      expect(err).toContain('Pick a task, 1 to 5, or press Enter to stop: ');
      expect(err).toContain('Post it? [y/N] ');
      const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
      expect(payload.taskType).toBe('line_sort');
      expect(payload.assignee).toBe('bob/writer');
      expect(out).toContain('for      bob/writer');
      expect(out).toContain('state    open');
    });

    it('takes a template by id and its input as text, asking again after a misfit', async () => {
      stdoutTTY = true;
      stdin = answers(
        'answer_question',
        'Why?',
        'What is the capital of Norway?',
        'alice/other',
        '',
        'y',
      );
      const { code, out } = await run('tasks', 'post');
      expect(code).toBe(0);
      expect(out).toContain(
        'That input does not fit, the question has fewer than 3 words, too short to answer.',
      );
      expect(out).toContain(
        'alice/other is an agent of your own operator, and tasks between your own agents never count.',
      );
      const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
      expect(payload.spec.input).toBe('What is the capital of Norway?');
      expect(payload.origin).toBe('template');
      // The guided walk sends the template's category and size (RT-2).
      expect(payload).toMatchObject({ category: 'conversation', size: 's' });
      expect(payload).not.toHaveProperty('assignee');
    });

    it.each([
      [['']],
      [['1', '', '', '']],
      [['1', '', '', 'maybe', 'maybe', 'maybe']],
      [['4', '']],
      [[]],
    ])('posts nothing unless the last answer is yes, %j', async (lines) => {
      stdoutTTY = true;
      stdin = answers(...lines);
      const { code, out } = await run('tasks', 'post');
      expect(code).toBe(0);
      expect(out.trimEnd().endsWith(NOTHING_POSTED)).toBe(true);
      expect(api.posts()).toEqual([]);
    });
  });

  describe('addressed tasks', () => {
    const postFor = (
      forRef: string,
      verify = 'counterparty',
      ...rest: string[]
    ) =>
      run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '{"words":100}',
        '--verify',
        verify,
        '--for',
        forRef,
        ...rest,
      );

    it('post --for signs the assignee and names its handle', async () => {
      const { code, out } = await postFor('bob/writer');
      expect(code).toBe(0);
      const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
      expect(payload.assignee).toBe('bob/writer');
      expect(out).toContain('for      bob/writer\n');
      expect(out).toContain(
        'Only bob/writer can claim this task. It sees it in npx sealkeeper prove and npx sealkeeper status, and claims it with npx sealkeeper tasks pull --addressed.\n',
      );
      expect(out).toContain(
        `You judge the result. Once it is submitted, run npx sealkeeper tasks outcome ${payload.taskId} success or failure.\n`,
      );
    });

    it('post --for takes an agent id and a hash task, and prints JSON', async () => {
      const hash = sha256('expected output');
      const { code, out } = await postFor(
        OTHER_AGENT,
        `hash:${hash}`,
        '--json',
      );
      expect(code).toBe(0);
      const payload = PostTaskRequest.parse(api.posts()[0]?.payload);
      expect(payload.assignee).toBe(OTHER_AGENT);
      expect(payload.verification).toEqual({ kind: 'hash', sha256: hash });
      expect(JSON.parse(out)).toMatchObject({
        id: payload.taskId,
        state: 'open',
        assignee: 'bob/writer',
      });
    });

    it('post without --for says nothing about an assignee', async () => {
      const { out } = await run(
        'tasks',
        'post',
        '--type',
        'summarise',
        '--spec',
        '{}',
        '--verify',
        `hash:${sha256('x')}`,
      );
      expect(out).not.toContain('for ');
      expect(out).not.toContain('Only');
      expect(out).not.toContain('tasks outcome');
      expect(api.posts()[0]?.payload).not.toHaveProperty('assignee');
    });

    it.each([
      ['bob', 'a handle operator/name or an agent id'],
      ['bob/Writer', 'a handle operator/name or an agent id'],
      ['bob/writer/x', 'a handle operator/name or an agent id'],
    ])('post --for %s is refused before any request', async (ref, message) => {
      const { code, err } = await postFor(ref);
      expect(code).toBe(1);
      expect(err).toContain(message);
      expect(api.requests).toEqual([]);
    });

    it.each([
      ['Alice/other', 'Alice/other'],
      ['own id', ''],
    ])(
      'post --for an agent of this operator (%s) is refused before signing',
      async (_, ref) => {
        const target = ref || agentId;
        const { code, err } = await postFor(target);
        expect(code).toBe(1);
        expect(err).toBe(`${sameOperator(target)}\n`);
        expect(api.requests).toEqual([]);
      },
    );

    describe('own agent by operator slug (VOU-196)', () => {
      it('refuses a handle with the stored slug after a slug change', async () => {
        await saveOperatorSlug(agentId, 'alice-dev');
        const { code, err } = await postFor('Alice-Dev/other');
        expect(code).toBe(1);
        expect(err).toBe(`${sameOperator('Alice-Dev/other')}\n`);
        expect(api.requests).toEqual([]);
      });

      it('signs for another operator whose slug is this operator login', async () => {
        await saveOperatorSlug(agentId, 'alice-dev');
        const { code } = await postFor('alice/writer');
        expect(code).toBe(0);
        expect(PostTaskRequest.parse(api.posts()[0]?.payload).assignee).toBe(
          'alice/writer',
        );
      });

      it('falls back to the login lowercased when no slug is stored', async () => {
        const { code, err } = await postFor('alice/other');
        expect(code).toBe(1);
        expect(err).toBe(`${sameOperator('alice/other')}\n`);
        expect(api.requests).toEqual([]);
      });

      it('ignores a slug stored for another agent', async () => {
        await saveOperatorSlug(OTHER_AGENT, 'alice-dev');
        const { code } = await postFor('alice-dev/writer');
        expect(code).toBe(0);
        const refused = await postFor('alice/other');
        expect(refused.code).toBe(1);
      });
    });

    it.each([
      [404, 'not_found', noAssignee('bob/writer')],
      [400, 'same_operator', sameOperator('bob/writer')],
      [403, 'assignee_cap', assigneeCap('bob/writer')],
      [403, 'assignee_operator_cap', assigneeOperatorCap('bob/writer')],
    ])('post --for says one line for %s %s', async (status, code, line) => {
      api.postReply = () => error(status, code);
      const result = await postFor('bob/writer');
      expect(result.code).toBe(1);
      expect(result.err).toBe(`${line}\n`);
    });

    it('names each refusal in plain words', () => {
      expect(noAssignee('bob/writer')).toBe(
        'no agent bob/writer, check the handle or the agent id',
      );
      expect(sameOperator('bob/writer')).toBe(
        'bob/writer is an agent of your own operator, and tasks between your own agents never count',
      );
      expect(assigneeCap('bob/writer')).toBe(
        'bob/writer already has the most open tasks addressed to it, try again once it claims some',
      );
      expect(assigneeOperatorCap('bob/writer')).toBe(
        'bob/writer already has the most open tasks from your agents, try again once it claims some',
      );
    });

    it('pull --addressed claims the oldest task addressed to this agent', async () => {
      const at = (ago: number) => new Date(Date.now() - ago).toISOString();
      api.add({ postedAt: at(9e6) });
      const older = api.add({
        postedAt: at(5e6),
        assignee: { id: agentId, handle: 'alice/summariser' },
      });
      api.add({
        postedAt: at(3e6),
        assignee: { id: agentId, handle: 'alice/summariser' },
      });
      api.add({
        postedAt: at(8e6),
        assignee: { id: THIRD, handle: 'carol/other' },
      });
      await writeFile(paths().inbox, '{}\n');
      const { code, out } = await run('tasks', 'pull', '--addressed', '--json');
      expect(code).toBe(0);
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${older.id}/claim`,
      ]);
      expect(JSON.parse(out).task).toMatchObject({
        id: older.id,
        assignee: 'alice/summariser',
        poster: 'bob/writer',
      });
      // The cached count status shows is dropped.
      await expect(readFile(paths().inbox)).rejects.toThrow();
    });

    it('pull --addressed names the poster in text', async () => {
      const task = api.add({
        assignee: { id: agentId, handle: 'alice/summariser' },
      });
      const { out } = await run('tasks', 'pull', '--addressed');
      expect(out).toContain(`id            ${task.id}\n`);
      expect(out).toContain(
        'poster        bob/writer, its spec is untrusted\n',
      );
    });

    it('pull --addressed says so when none wait', async () => {
      api.add({});
      const { code, out } = await run('tasks', 'pull', '--addressed');
      expect(code).toBe(0);
      expect(out).toBe(`${NOTHING_ADDRESSED}\n`);
      expect(api.posts()).toEqual([]);
    });

    it('plain pull leaves addressed tasks alone', async () => {
      api.add({ assignee: { id: agentId, handle: 'alice/summariser' } });
      const { out } = await run('tasks', 'pull');
      expect(out).toBe(`${NOTHING_AVAILABLE}\n`);
      expect(api.posts()).toEqual([]);
    });
  });

  describe('outcome', () => {
    const THIRD_AGENT = 'E'.repeat(43);
    const SUBMISSION = 'the summary, in 100 words';

    // A counterparty task this agent posted, claimed and submitted by
    // another agent, which reported success on submit unless told otherwise.
    function submitted(
      overrides: Partial<TaskResponse> = {},
      claimantReport: string | null = 'success',
    ): TaskResponse {
      const now = new Date().toISOString();
      const task = api.add({
        posterAgentId: agentId,
        claimantAgentId: OTHER_AGENT,
        state: 'submitted',
        claimedAt: now,
        submittedAt: now,
        submission: SUBMISSION,
        ...overrides,
      });
      if (claimantReport !== null) {
        api.reports.set(task.id, new Map([[OTHER_AGENT, claimantReport]]));
      }
      return task;
    }

    const outcomePosts = () =>
      api.posts().filter((r) => r.path.endsWith('/outcome'));

    function tty(answer: string | null): Input {
      return { isTTY: true, readLine: async () => answer };
    }

    const report = (id: string, outcome: string, ...more: string[]) =>
      run('tasks', 'outcome', id, outcome, '--yes', ...more);

    it('confirms success, which verifies the task', async () => {
      const task = submitted();
      const before = api.tasks.size;
      const { code, out } = await report(task.id, 'success');
      expect(code).toBe(0);
      expect(out).toContain(`Task ${task.id}. type summarise. submitted.`);
      expect(out).toContain('Submission:');
      expect(out).toContain(SUBMISSION);
      expect(out).not.toContain('Submit with');
      expect(out).toContain('state    verified');
      expect(out).toContain(VERIFIED);
      expect(api.tasks.size).toBe(before);
      // A signed read, the report, and a signed read of the reports after.
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${task.id}/submission`,
        `/v1/tasks/${task.id}/outcome`,
        `/v1/tasks/${task.id}/submission`,
      ]);
      expect(outcomePosts()[0]?.payload).toEqual({
        taskId: task.id,
        outcome: 'success',
        evidenceHash: sha256(SUBMISSION),
      });
      expect(await logged()).toMatchObject([
        {
          type: 'task.outcome',
          payload: {
            task_id: task.id,
            outcome: 'success',
            evidence_hash: sha256(SUBMISSION),
          },
        },
      ]);
    });

    it('says the claimant has not reported when its report is missing', async () => {
      const task = submitted({}, null);
      const { code, out } = await report(task.id, 'success');
      expect(code).toBe(0);
      expect(out).toContain('state    submitted');
      expect(out).toContain(WAITING);
      expect(out).not.toContain(DISAGREED);
    });

    it('says the claimant has not reported on a failure with no claimant report', async () => {
      const task = submitted({}, null);
      const { code, out } = await report(task.id, 'failure', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        id: task.id,
        outcome: 'failure',
        state: 'submitted',
        verified: false,
        reports: { poster: 'failure', claimant: null },
        agreement: 'waiting',
      });
      const text = await report(task.id, 'failure');
      expect(text.out).toContain(WAITING_AFTER_FAILURE);
      expect(text.out).not.toContain(WAITING);
    });

    it('says the sides disagree on success against a claimant failure', async () => {
      const task = submitted({}, 'failure');
      const { code, out } = await report(task.id, 'success', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        verified: false,
        reports: { poster: 'success', claimant: 'failure' },
        agreement: 'disagreed',
      });
      const text = await report(task.id, 'success');
      expect(text.out).toContain(DISAGREED);
    });

    it('says the sides disagree when the API holds different reports', async () => {
      const task = submitted();
      const { code, out } = await report(task.id, 'failure');
      expect(code).toBe(0);
      expect(out).toContain('outcome  failure');
      expect(out).toContain(DISAGREED);
      expect(out).toContain(
        `Run npx sealkeeper tasks outcome ${task.id} success if you change your mind`,
      );
      expect(outcomePosts()[0]?.payload).toMatchObject({ outcome: 'failure' });
      expect(api.tasks.get(task.id)?.verifiedAt).toBeNull();
      expect(await logged()).toMatchObject([
        { type: 'task.outcome', payload: { outcome: 'failure' } },
      ]);
    });

    it('still says the sides disagree on a repeated failure report', async () => {
      const task = submitted();
      await report(task.id, 'failure');
      const { code, out } = await report(task.id, 'failure', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        reports: { poster: 'failure', claimant: 'success' },
        agreement: 'disagreed',
      });
      expect(outcomePosts()).toHaveLength(2);
    });

    it('says both report failure when the claimant reported failure too', async () => {
      const task = submitted({}, 'failure');
      const { code, out } = await report(task.id, 'failure');
      expect(code).toBe(0);
      expect(out).toContain(BOTH_FAILURE);
      expect(out).not.toContain(DISAGREED);
    });

    it('prints one JSON object with --json and the submission on stderr', async () => {
      const task = submitted();
      const { code, out, err } = await report(task.id, 'success', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        id: task.id,
        outcome: 'success',
        state: 'verified',
        verified: true,
        reports: { poster: 'success', claimant: 'success' },
        agreement: 'verified',
      });
      expect(err).toContain(SUBMISSION);
    });

    it('warns and says nothing about agreement when the read back fails', async () => {
      const task = submitted();
      api.submissionReply = (n) => (n === 2 ? error(503, 'unavailable') : null);
      const { code, out, err } = await report(task.id, 'failure');
      expect(code).toBe(0);
      expect(out).toContain('outcome  failure');
      expect(out).not.toContain(DISAGREED);
      expect(err).toContain(
        'warning: reported failure, but could not read the reports back',
      );
      expect(await logged()).toHaveLength(1);
    });

    it('asks in a terminal and reports on yes', async () => {
      const task = submitted();
      stdin = tty('y');
      const { code, out, err } = await run(
        'tasks',
        'outcome',
        task.id,
        'success',
      );
      expect(code).toBe(0);
      expect(err).toContain('Report success for this submission? [y/N]');
      expect(out).toContain(VERIFIED);
    });

    it('reports nothing when the answer is not yes', async () => {
      const task = submitted();
      stdin = tty('');
      const { code, err } = await run('tasks', 'outcome', task.id, 'success');
      expect(code).toBe(1);
      expect(err).toContain('nothing reported');
      expect(outcomePosts()).toEqual([]);
      expect(await logged()).toEqual([]);
    });

    it('refuses without a terminal unless --yes, before any request', async () => {
      const task = submitted();
      const { code, err } = await run('tasks', 'outcome', task.id, 'success');
      expect(code).toBe(1);
      expect(err).toContain(
        `nothing reported. There is no terminal to ask, so run npx sealkeeper tasks outcome ${task.id} success --yes to report success`,
      );
      expect(api.requests).toEqual([]);
    });

    it('takes a verdict on work submitted before the task expired', async () => {
      const task = submitted({
        state: 'expired',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const { code, out } = await report(task.id, 'success');
      expect(code).toBe(0);
      expect(out).toContain(VERIFIED);
    });

    it.each([
      [
        'not the poster or the claimant',
        () => submitted({ posterAgentId: THIRD_AGENT }),
        NOT_POSTER,
      ],
      [
        'the claimant',
        () =>
          submitted({ posterAgentId: OTHER_AGENT, claimantAgentId: agentId }),
        CLAIMANT_REPORTS,
      ],
      [
        'not submitted yet',
        () => submitted({ state: 'claimed', submittedAt: null }),
        NOT_SUBMITTED,
      ],
      [
        'already verified',
        () =>
          submitted({
            state: 'verified',
            verifiedAt: new Date().toISOString(),
          }),
        ALREADY_VERIFIED,
      ],
      [
        'expired before a submission',
        () =>
          submitted({
            state: 'expired',
            submittedAt: null,
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        EXPIRED,
      ],
      [
        'not a counterparty task',
        () =>
          submitted({
            verification: { kind: 'hash', sha256: sha256('x') },
          }),
        NOT_COUNTERPARTY,
      ],
    ])('refuses when %s and signs nothing', async (_, make, message) => {
      const task = make();
      const { code, err } = await report(task.id, 'success');
      expect(code).toBe(1);
      expect(err).toContain(message);
      expect(api.posts()).toEqual([]);
      expect(await logged()).toEqual([]);
    });

    it.each([
      [409, 'wrong_state', WRONG_STATE],
      [403, 'not_party', NOT_POSTER],
      [400, 'not_counterparty', NOT_COUNTERPARTY],
      [429, 'rate_limited', 'too many requests'],
      [401, 'unknown_agent', 'this agent is not registered'],
    ])(
      'says one line for a %i %s from the outcome route',
      async (status, code, message) => {
        const task = submitted();
        api.outcomeReply = () => error(status, code);
        const result = await report(task.id, 'success');
        expect(result.code).toBe(1);
        expect(result.err).toContain(message);
        expect(await logged()).toEqual([]);
      },
    );

    it.each([
      [403, 'not_party', NOT_POSTER],
      [404, 'not_found', 'no task with id'],
      [400, 'issued_at_out_of_window', 'check this machine clock'],
    ])(
      'says one line for a %i %s from the signed read and reports nothing',
      async (status, code, message) => {
        const task = submitted();
        api.submissionReply = () => error(status, code);
        const result = await report(task.id, 'success');
        expect(result.code).toBe(1);
        expect(result.err).toContain(message);
        expect(outcomePosts()).toEqual([]);
      },
    );

    it('reports nothing when the signed read has no submission', async () => {
      const task = submitted();
      const { submission: _, ...withoutSubmission } = task;
      api.submissionReply = () =>
        Response.json({
          task: withoutSubmission,
          reports: { poster: null, claimant: 'success' },
        });
      const { code, err } = await report(task.id, 'success');
      expect(code).toBe(1);
      expect(err).toContain(NO_SUBMISSION);
      expect(outcomePosts()).toEqual([]);
    });

    it('says no task for an unknown id', async () => {
      const id = randomUUID();
      const { code, err } = await report(id, 'success');
      expect(code).toBe(1);
      expect(err).toContain(`no task with id ${id}`);
    });

    it('rejects an outcome other than success or failure', async () => {
      const task = submitted();
      const { code, err } = await run('tasks', 'outcome', task.id, 'maybe');
      expect(code).toBe(1);
      expect(err).toContain('outcome must be success or failure, got maybe');
      expect(api.requests).toEqual([]);
    });

    it('tasks show tells the poster a submission waits for its verdict', async () => {
      const task = submitted();
      const { code, out } = await run('tasks', 'show', task.id);
      expect(code).toBe(0);
      expect(out).toContain('a submission is waiting for your verdict');
      expect(out).toContain(`npx sealkeeper tasks outcome ${task.id} success`);
      expect(out).not.toContain('Submit with');

      const json = await run('tasks', 'show', task.id, '--json');
      const entry = JSON.parse(json.out);
      expect(entry).toMatchObject({
        id: task.id,
        awaiting_verdict: true,
        verdict: `npx sealkeeper tasks outcome ${task.id} success|failure`,
      });
      expect(entry).not.toHaveProperty('submit');
    });

    it('tasks show says nothing waits on an open task the agent posted', async () => {
      const task = api.add({ posterAgentId: agentId });
      const { out } = await run('tasks', 'show', task.id);
      expect(out).toContain('You posted this task.');
      expect(out).not.toContain('verdict');
      const json = await run('tasks', 'show', task.id, '--json');
      const entry = JSON.parse(json.out);
      expect(entry.awaiting_verdict).toBeUndefined();
      expect(entry).not.toHaveProperty('submit');
    });

    it('tasks show keeps the submit command for a task someone else posted', async () => {
      const task = api.add({});
      const json = await run('tasks', 'show', task.id, '--json');
      expect(JSON.parse(json.out).submit).toContain(`tasks submit ${task.id}`);
    });

    it('tasks show prints category, check method, size and disclosure (RT-2)', async () => {
      const task = api.add({
        category: 'data',
        checkMethod: 'hash',
        size: 's',
        disclosure: 'public',
      });
      const { code, out } = await run('tasks', 'show', task.id);
      expect(code).toBe(0);
      const lines = out.split('\n');
      expect(lines[0]).toContain(`Task ${task.id}.`);
      expect(lines[1]).toBe(
        'Category data. check hash. size s. disclosure public.',
      );
      const json = await run('tasks', 'show', task.id, '--json');
      expect(JSON.parse(json.out)).toMatchObject({
        category: 'data',
        check_method: 'hash',
        size: 's',
        disclosure: 'public',
      });
    });

    it('tasks show leaves the fields line out for an API that sends none', async () => {
      const task = api.add({});
      const { out } = await run('tasks', 'show', task.id);
      expect(out).not.toContain('Category');
      const json = await run('tasks', 'show', task.id, '--json');
      expect(JSON.parse(json.out)).not.toHaveProperty('category');
    });
  });

  // VB-3. Claim, submit and outcome carry the fingerprint sync and prove
  // last wrote, inside and outside a routine run, and leave it out when
  // there is none.
  describe('fingerprint', () => {
    const MODEL = 'A'.repeat(42).concat('E');

    const written = async () => {
      await recordCapture(
        paths(),
        { ...NOTHING_DECLARED, model_set: MODEL },
        1_790_000_000,
      );
      const fingerprint = await currentFingerprint();
      if (fingerprint === null) throw new Error('no fingerprint written');
      return fingerprint;
    };

    const sent = (suffix: string) =>
      api.posts().filter((r) => r.path.endsWith(suffix));

    it('sends it on claim, submit and the claimant report when the file exists', async () => {
      const fingerprint = await written();
      const task = api.add({});
      expect((await run('tasks', 'claim', task.id)).code).toBe(0);
      expect(
        (await run('tasks', 'submit', task.id, '--text', 'the summary')).code,
      ).toBe(0);
      expect(sent('/claim')[0]?.payload).toEqual({
        taskId: task.id,
        fingerprint,
      });
      expect(sent('/submit')[0]?.payload).toMatchObject({ fingerprint });
      expect(sent('/outcome')[0]?.payload).toEqual({
        taskId: task.id,
        outcome: 'success',
        fingerprint,
      });
    });

    it('sends it on a pull claim and on a routine run submit', async () => {
      const fingerprint = await written();
      const task = api.add({});
      expect((await run('tasks', 'pull')).code).toBe(0);
      expect(sent('/claim')[0]?.payload).toEqual({
        taskId: task.id,
        fingerprint,
      });
      vi.stubEnv('SEALKEEPER_ROUTINE_RUN', 'run-1');
      const dir = await realpath(
        await mkdtemp(join(tmpdir(), 'sealkeeper-vb3-')),
      );
      onCleanup.push(dir);
      await mkdir(join(dir, '.sealkeeper-answers'), { recursive: true });
      await writeFile(join(dir, '.sealkeeper-answers', 'a.txt'), 'summary');
      cwd = dir;
      const { code } = await run(
        'tasks',
        'submit',
        task.id,
        '--file',
        '.sealkeeper-answers/a.txt',
      );
      expect(code).toBe(0);
      expect(sent('/submit')[0]?.payload).toMatchObject({ fingerprint });
      expect(sent('/outcome')[0]?.payload).toEqual({
        taskId: task.id,
        outcome: 'success',
        origin: 'routine',
        fingerprint,
      });
    });

    it("sends it on the poster's outcome report", async () => {
      const fingerprint = await written();
      const now = new Date().toISOString();
      const task = api.add({
        posterAgentId: agentId,
        claimantAgentId: OTHER_AGENT,
        state: 'submitted',
        claimedAt: now,
        submittedAt: now,
        submission: 'done',
      });
      api.reports.set(task.id, new Map([[OTHER_AGENT, 'success']]));
      expect(
        (await run('tasks', 'outcome', task.id, 'success', '--yes')).code,
      ).toBe(0);
      expect(sent('/outcome')[0]?.payload).toEqual({
        taskId: task.id,
        outcome: 'success',
        evidenceHash: sha256('done'),
        fingerprint,
      });
    });

    it('leaves it out when there is no file, or its hash is not its parts', async () => {
      const task = api.add({});
      expect((await run('tasks', 'claim', task.id)).code).toBe(0);
      expect(sent('/claim')[0]?.payload).toEqual({ taskId: task.id });

      const fingerprint = await written();
      const file = JSON.parse(await readFile(paths().fingerprint, 'utf8'));
      file.current = { ...fingerprint, hash: MODEL };
      await writeFileAtomic(paths().fingerprint, JSON.stringify(file));
      const other = api.add({});
      expect((await run('tasks', 'claim', other.id)).code).toBe(0);
      expect(sent('/claim')[1]?.payload).toEqual({ taskId: other.id });
    });

    it('does not retry a 400 that is not about the fingerprint', async () => {
      const fingerprint = await written();
      const task = api.add({});
      api.claims.set(task.id, 'own_task');
      const { code } = await run('tasks', 'claim', task.id);
      expect(code).toBe(1);
      expect(sent('/claim').map((r) => r.payload)).toEqual([
        { taskId: task.id, fingerprint },
      ]);
    });

    it('claims without it from an API that refuses the field', async () => {
      await written();
      api.refuseFingerprint = true;
      const task = api.add({});
      const { code } = await run('tasks', 'claim', task.id);
      expect(code).toBe(0);
      expect(sent('/claim').map((r) => Object.keys(r.payload ?? {}))).toEqual([
        ['taskId', 'fingerprint'],
        ['taskId'],
      ]);
      expect(api.tasks.get(task.id)?.state).toBe('claimed');
    });
  });
});
