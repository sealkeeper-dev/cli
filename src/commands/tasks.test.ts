// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  PostTaskRequest,
  readAudience,
  type TaskResponse,
  type VerificationSpec,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Input } from '../ask.js';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
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
  assigneeCap,
  assigneeOperatorCap,
  noAssignee,
  sameOperator,
} from './tasks-post.js';
import {
  MAX_CLAIM_ATTEMPTS,
  NOTHING_ADDRESSED,
  NOTHING_AVAILABLE,
} from './tasks-pull.js';
import { AWAITING_POSTER } from './tasks-submit.js';

const API_URL = 'https://api.test';

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

type ClaimReply = 'ok' | 409 | 410 | 'own_task';

type ApiCall = {
  method: string;
  path: string;
  payload?: Record<string, unknown>;
};

// An in-memory stand-in for the task routes. Every signed write is verified
// against the key named by its kid, which must be the local agent, and the
// payload taskId must match the task in the path.
class FakeApi {
  tasks = new Map<string, TaskResponse>();
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

  constructor(readonly agentId: string) {}

  add(
    overrides: Partial<TaskResponse> & { verification?: VerificationSpec },
  ): TaskResponse {
    const task: TaskResponse = {
      id: randomUUID(),
      posterAgentId: OTHER_AGENT,
      claimantAgentId: null,
      taskType: 'summarise',
      spec: { words: 100 },
      verification: { kind: 'counterparty' },
      state: 'open',
      postedAt: new Date(Date.now() - 60_000).toISOString(),
      claimedAt: null,
      submittedAt: null,
      verifiedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  posts(): ApiCall[] {
    return this.requests.filter((r) => r.method === 'POST');
  }

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const request: ApiCall = { method, path: url.pathname };
    this.requests.push(request);

    if (method === 'GET' && url.pathname === '/v1/tasks') {
      const type = url.searchParams.get('taskType');
      // Like the API, the open pool leaves addressed tasks out, and
      // assignee keeps only the tasks addressed to that agent.
      const assignee = url.searchParams.get('assignee');
      const state = url.searchParams.get('state');
      const tasks = [...this.tasks.values()]
        .filter((t) => t.state === state)
        .filter((t) =>
          assignee
            ? t.assignee?.id === assignee
            : state !== 'open' || !t.assignee,
        )
        .filter((t) => !type || t.taskType === type)
        .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt))
        .slice(0, Number(url.searchParams.get('limit') ?? 50));
      return Response.json({ tasks });
    }
    const agent = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (method === 'GET' && agent) {
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
      const { submission: _, ...publicTask } = task;
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
        if (task.assignee && task.assignee.id !== this.agentId) {
          return error(403, 'not_assignee');
        }
        Object.assign(task, {
          state: 'claimed',
          claimantAgentId: this.agentId,
          claimedAt: new Date().toISOString(),
        });
        return Response.json(task);
      }
      case 'submit': {
        if (this.submitReply) return this.submitReply();
        const now = new Date().toISOString();
        Object.assign(task, {
          submittedAt: now,
          submission: request.payload.submission,
          ...(task.verification.kind === 'counterparty'
            ? { state: 'submitted' }
            : { state: 'verified', verifiedAt: now }),
        });
        return Response.json(task);
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
        return Response.json(task);
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

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({
      tasks: {
        fetch: api.fetch,
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
  });

  afterEach(async () => {
    expect(api.errors).toEqual([]);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  describe('without setup', () => {
    it.each([
      ['tasks', 'pull'],
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

    it('prints the task as text', async () => {
      const task = api.add({});
      const { code, out } = await run('tasks', 'pull');
      expect(code).toBe(0);
      expect(out).toContain(`id            ${task.id}`);
      expect(out).toContain('verification  counterparty');
      expect(out).toContain('spec          {"words":100}');
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
          postedAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
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
      expect(api.requests[0]?.path).toBe('/v1/tasks');
      expect(api.posts().map((r) => r.path)).toEqual([
        `/v1/tasks/${other.id}/claim`,
      ]);
    });

    it('reports nothing available as JSON when only own tasks are open', async () => {
      api.add({ posterAgentId: agentId });
      const { code, out } = await run('tasks', 'pull', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ task: null });
      expect(api.posts()).toEqual([]);
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

    it('refuses a hash mismatch locally and sends nothing', async () => {
      const task = claimed({ kind: 'hash', sha256: sha256('right') });
      const { code, err } = await run(
        'tasks',
        'submit',
        task.id,
        '--text',
        'wrong',
      );
      expect(code).toBe(1);
      expect(err).toContain('does not match the expected hash');
      expect(err).toContain(sha256('wrong'));
      expect(api.posts()).toEqual([]);
      expect(await logged()).toEqual([]);
    });

    it('submits a matching hash from a file and prints verified', async () => {
      const task = claimed({ kind: 'hash', sha256: sha256('the answer\n') });
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
      const schemaFile = join(home, 'schema.json');
      const specFile = join(home, 'spec.json');
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
      const ttl = Date.parse(payload.expiresAt ?? '') - Date.now();
      expect(ttl).toBeGreaterThan(1.9 * 3_600_000);
      expect(ttl).toBeLessThanOrEqual(2 * 3_600_000);
      expect(out).toContain(`id       ${payload.taskId}`);
      expect(out).toContain('state    open');
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
      ['bob', 'a handle login/name or an agent id'],
      ['bob/Writer', 'a handle login/name or an agent id'],
      ['bob/writer/x', 'a handle login/name or an agent id'],
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
  });
});
