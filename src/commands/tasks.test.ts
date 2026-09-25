// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  PostTaskRequest,
  type TaskResponse,
  type VerificationSpec,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import { MAX_CLAIM_ATTEMPTS, NOTHING_AVAILABLE } from './tasks-pull.js';
import { AWAITING_POSTER } from './tasks-submit.js';

const API_URL = 'http://api.test';
const OTHER_AGENT = 'A'.repeat(43);

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
  outcomeReply: (() => Response) | null = null;
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
      const tasks = [...this.tasks.values()]
        .filter((t) => t.state === url.searchParams.get('state'))
        .filter((t) => !type || t.taskType === type)
        .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt))
        .slice(0, Number(url.searchParams.get('limit') ?? 50));
      return Response.json({ tasks });
    }
    const match = url.pathname.match(
      /^\/v1\/tasks\/([^/]+)(?:\/(claim|submit|outcome))?$/,
    );
    if (method === 'GET' && match && !match[2]) {
      const task = this.tasks.get(match[1] ?? '');
      return task ? Response.json(task) : error(404, 'not_found');
    }

    // Signed writes from here on.
    const body = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(body.envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const { payload } = await verify(body.envelope, base64urlDecode(kid));
    request.payload = payload as Record<string, unknown>;

    if (url.pathname === '/v1/tasks') {
      const parsed = PostTaskRequest.parse(payload);
      const task = this.add({
        id: parsed.taskId,
        posterAgentId: this.agentId,
        taskType: parsed.taskType,
        spec: parsed.spec,
        verification: parsed.verification,
        ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
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
      case 'outcome':
        if (this.outcomeReply) return this.outcomeReply();
        return Response.json(task);
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

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({ tasks: { fetch: api.fetch } });
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
      operatorLogin: 'carelmeyer',
      name: 'summariser',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    api = new FakeApi(agentId);
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
      const file = join(home, 'answer.txt');
      await writeFile(file, 'the answer\n');
      const { code, out } = await run(
        'tasks',
        'submit',
        task.id,
        '--file',
        file,
      );
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
});
