// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  type TaskResponse,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { appendEvent } from '../log.js';
import { createProgram } from '../program.js';
import { closing, MAX_COUNT, relative, SUBMIT_HINT } from './prove.js';

const API_URL = 'http://api.test';
const SEED_AGENT = `${'S'.repeat(42)}A`;
const OTHER_AGENT = `${'O'.repeat(42)}A`;
// Another agent of the same operator as the one running prove.
const SIBLING_AGENT = `${'M'.repeat(42)}A`;

const loginOf = (id: string) =>
  id === SEED_AGENT
    ? 'sealkeeper-dev'
    : id === SIBLING_AGENT
      ? 'CarelMeyer'
      : 'someone';
const PROFILE = 'https://sealkeeper.run/agents/carelmeyer/scout';
const HOUR = 3_600_000;

type RunResult = { code: number; out: string; err: string };
type ClaimReply = 'ok' | 409 | 'claim_cap' | 'unknown_agent';

// The task and agent routes prove uses. Claims are verified against the
// local agent's key and must name the task in the path.
class FakeApi {
  tasks = new Map<string, TaskResponse>();
  claims = new Map<string, ClaimReply>();
  claimed: string[] = [];
  errors: string[] = [];
  requests: string[] = [];
  // Agent answers sent as they are, in place of the made up ones below.
  agents = new Map<string, Record<string, unknown>>();

  constructor(readonly agentId: string) {}

  add(overrides: Partial<TaskResponse> = {}): TaskResponse {
    const task: TaskResponse = {
      id: randomUUID(),
      posterAgentId: SEED_AGENT,
      claimantAgentId: null,
      taskType: 'json_extract',
      spec: {
        instruction: 'Return the value at orders[0].id.',
        input: '{"orders":[{"id":1}]}',
        output: 'The number only.',
      },
      verification: { kind: 'hash', sha256: 'a'.repeat(64) },
      state: 'open',
      postedAt: new Date(Date.now() - HOUR).toISOString(),
      claimedAt: null,
      submittedAt: null,
      verifiedAt: null,
      expiresAt: new Date(Date.now() + 47.5 * HOUR).toISOString(),
      ...overrides,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}`);

    if (method === 'GET' && url.pathname === '/v1/tasks') {
      const tasks = [...this.tasks.values()]
        .filter((t) => t.state === url.searchParams.get('state'))
        .slice(0, Number(url.searchParams.get('limit') ?? 50));
      return Response.json({ tasks });
    }
    const agent = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (method === 'GET' && agent) {
      const id = agent[1] ?? '';
      const recorded = this.agents.get(id);
      if (recorded) return Response.json(recorded);
      return Response.json({
        id,
        name: id === SEED_AGENT ? 'sealkeeper-seed' : 'other',
        version: '1.0.0',
        operator: { login: loginOf(id) },
        createdAt: '2026-09-22T00:00:00.000Z',
        operatedByVouched: id === SEED_AGENT,
      });
    }
    const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)(\/claim)?$/);
    const task = this.tasks.get(match?.[1] ?? '');
    if (method === 'GET' && match && !match[2]) {
      return task ? Response.json(task) : error(404, 'not_found');
    }
    if (method !== 'POST' || !match?.[2] || !task) {
      return error(404, 'not_found');
    }

    const body = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(body.envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const { payload } = await verify(body.envelope, base64urlDecode(kid));
    if ((payload as { taskId?: string }).taskId !== task.id) {
      this.errors.push(`taskId ${task.id}`);
    }
    const reply = this.claims.get(task.id) ?? 'ok';
    if (reply === 409) return error(409, 'already_claimed');
    if (reply === 'claim_cap') return error(403, 'claim_cap');
    if (reply === 'unknown_agent') return error(401, 'unknown_agent');
    Object.assign(task, {
      state: 'claimed',
      claimantAgentId: this.agentId,
      claimedAt: new Date().toISOString(),
    });
    this.claimed.push(task.id);
    return Response.json(task);
  }) as typeof fetch;
}

function error(status: number, code: string): Response {
  const messages: Record<string, string> = {
    claim_cap: 'An agent can hold at most 10 claimed tasks',
    unknown_agent: 'Agent is not registered',
  };
  return Response.json(
    { error: { code, message: messages[code] ?? `failed with ${code}` } },
    { status },
  );
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('prove', () => {
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
      vi.restoreAllMocks();
    }
  }

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

  // n seed tasks, oldest first.
  function seedTasks(n: number): TaskResponse[] {
    return Array.from({ length: n }, (_, i) =>
      api.add({
        postedAt: new Date(Date.now() - (n - i + 1) * HOUR).toISOString(),
      }),
    );
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-prove-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'carelmeyer',
      name: 'scout',
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

  it('claims five by default and prints one block per task', async () => {
    const tasks = seedTasks(7);
    const { code, out, err } = await run('prove');
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(api.claimed).toEqual(tasks.slice(0, 5).map((t) => t.id));

    const first = tasks[0] as TaskResponse;
    const block = [
      `Task 1 of 5. id ${first.id}. type json_extract. expires in 47 hours.`,
      'Spec:',
      '  {',
      '    "instruction": "Return the value at orders[0].id.",',
      '    "input": "{\\"orders\\":[{\\"id\\":1}]}",',
      '    "output": "The number only."',
      '  }',
      'Submit with:',
      `  sealkeeper tasks submit ${first.id} --file <path you choose>`,
      `  sealkeeper tasks submit ${first.id} --text <answer>`,
      '',
      `Task 2 of 5. id ${tasks[1]?.id}. type json_extract. expires in 47 hours.`,
    ].join('\n');
    expect(out.startsWith(block)).toBe(true);
    expect(out).toContain(`Task 5 of 5. id ${tasks[4]?.id}.`);
    expect(out.endsWith(`\n\n${closing(PROFILE)}\n`)).toBe(true);
    expect(closing(PROFILE)).toBe(
      `Solve each task, write the answer to a file and run the submit line. Seed tasks are verified by the server within 15 minutes of submission. Run sealkeeper status to watch the verified count. Your profile is ${PROFILE}.`,
    );

    const claims = (await logged()).filter((e) => e.type === 'task.claimed');
    expect(claims.map((e) => e.payload)).toEqual(
      tasks
        .slice(0, 5)
        .map((t) => ({ task_id: t.id, task_type: 'json_extract' })),
    );
  });

  it('prefers seed tasks, then tasks the server checks, then counterparty', async () => {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    const counterparty = api.add({
      posterAgentId: OTHER_AGENT,
      postedAt: at(9),
      verification: { kind: 'counterparty' },
    });
    const otherHash = api.add({ posterAgentId: OTHER_AGENT, postedAt: at(8) });
    api.add({ posterAgentId: agentId, postedAt: at(7) });
    const seedNew = api.add({ postedAt: at(1) });
    const seedOld = api.add({ postedAt: at(2) });

    const { code } = await run('prove', '--count', '4');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([
      seedOld.id,
      seedNew.id,
      otherHash.id,
      counterparty.id,
    ]);
  });

  it('skips tasks posted by other agents of the same operator', async () => {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(9) });
    api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(8) });
    const other = api.add({ posterAgentId: OTHER_AGENT, postedAt: at(7) });

    const { code } = await run('prove', '--count', '3');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([other.id]);
    // The sibling is looked up once, not once per task.
    expect(
      api.requests.filter((r) => r === `GET /v1/agents/${SIBLING_AGENT}`),
    ).toHaveLength(1);
  });

  it('uses the operator on the task when the API sends it', async () => {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    const own = api.add({ posterAgentId: OTHER_AGENT, postedAt: at(9) });
    Object.assign(own, { posterOperator: { login: 'carelmeyer' } });
    const theirs = api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(8) });
    Object.assign(theirs, { posterOperator: { login: 'someone-else' } });

    const { code } = await run('prove', '--count', '2');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([theirs.id]);
  });

  it('claims seed tasks when the seed agent belongs to the same operator', async () => {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    const ownSeed = `${'Q'.repeat(42)}A`;
    api.agents.set(ownSeed, {
      id: ownSeed,
      name: 'sealkeeper-seed',
      version: '1.0.0',
      operator: { login: 'CarelMeyer' },
      createdAt: '2026-09-23T09:44:36.047Z',
      operatedByVouched: true,
    });
    const seed = api.add({ posterAgentId: ownSeed, postedAt: at(9) });
    const stated = api.add({ posterAgentId: ownSeed, postedAt: at(8) });
    Object.assign(stated, { posterOperator: { login: 'carelmeyer' } });
    const sibling = api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(7) });
    const foreign = api.add({ posterAgentId: OTHER_AGENT, postedAt: at(6) });

    const { code } = await run('prove', '--count', '4');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([seed.id, stated.id, foreign.id]);
    expect(api.claimed).not.toContain(sibling.id);
    // One lookup per poster answers both the seed and the operator question.
    for (const poster of [ownSeed, SIBLING_AGENT, OTHER_AGENT]) {
      expect(
        api.requests.filter((r) => r === `GET /v1/agents/${poster}`),
      ).toHaveLength(1);
    }
  });

  it('claims a task from the live seed agent run under the operator login', async () => {
    // Recorded from GET /v1/tasks?state=open and GET /v1/agents/:id on
    // api.sealkeeper.run, 25 September 2026. Times are moved to now so the
    // task is still open.
    const seedAgent = 'fYSHyfojPAeQbYaDOMm3UPw7t4u2Ur2sMabDzrVrFT8';
    api.agents.set(seedAgent, {
      id: seedAgent,
      name: 'sealkeeper-seed',
      version: '1.0.0',
      operator: { login: 'carelmeyer' },
      createdAt: '2026-09-23T09:44:36.047Z',
      operatedByVouched: true,
      handle: 'carelmeyer/sealkeeper-seed',
      previousName: 'vouched-seed',
      lastSeenAt: null,
      level: 'none',
    });
    const task = api.add({
      id: 'e3a1a475-ae0c-4ad5-995b-e92f17055ea6',
      posterAgentId: seedAgent,
      taskType: 'csv_normalise',
      spec: {
        input:
          '  NaME  ,  CiTy,AgE\n Chen , Accra  ,  39 \n Amara , Berlin  ,83\n  Tariq  ,  Oslo,84  \nJonas , Cairo  ,63  ',
        output:
          'Trim spaces around every field. Lowercase the header fields and keep the header row first. Sort the data rows by their first field in ascending code point order. Join fields with a comma and rows with a line feed, and end with exactly one line feed. No field contains a comma or a quote.',
        instruction:
          'Normalise the CSV in input. The first line is the header row.',
      },
      verification: {
        kind: 'hash',
        sha256:
          '041e8c01ad5a354797249fe6d8e0667bc06632dc4704a071ce810cf5b4cf4d01',
      },
    });

    const { code, out } = await run('prove', '--count', '1');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([task.id]);
    expect(out).toContain(`Task 1 of 1. id ${task.id}. type csv_normalise.`);
  });

  it('moves past a lost race and stops at the claim cap with what it has', async () => {
    const tasks = seedTasks(4);
    api.claims.set(tasks[0]?.id ?? '', 409);
    api.claims.set(tasks[2]?.id ?? '', 'claim_cap');
    const { code, out, err } = await run('prove', '--count', '3');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([tasks[1]?.id]);
    expect(out).toContain(`Task 1 of 1. id ${tasks[1]?.id}.`);
    expect(err).toBe(
      'An agent can hold at most 10 claimed tasks. Submit the tasks below first.\n',
    );
  });

  it('lists the tasks the server says it holds when the local log does not know them', async () => {
    const held = Array.from({ length: 3 }, () =>
      api.add({
        state: 'claimed',
        claimantAgentId: agentId,
        claimedAt: new Date().toISOString(),
      }),
    );
    api.add({
      state: 'claimed',
      claimantAgentId: OTHER_AGENT,
      claimedAt: new Date().toISOString(),
    });
    api.add({
      state: 'claimed',
      claimantAgentId: agentId,
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const open = seedTasks(2);
    for (const task of open) api.claims.set(task.id, 'claim_cap');

    const { code, out, err } = await run('prove', '--count', '2');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([]);
    expect(out).toContain(`Task 1 of 2. id ${held[0]?.id}.`);
    expect(out).toContain(`Task 2 of 2. id ${held[1]?.id}.`);
    expect(out).not.toContain(held[2]?.id);
    expect(err).toBe(
      'An agent can hold at most 10 claimed tasks. Submit the tasks below first.\n',
    );

    const json = JSON.parse((await run('prove', '--count', '5', '--json')).out);
    expect(json.tasks.map((t: { id: string }) => t.id)).toEqual(
      held.map((t) => t.id),
    );
  });

  it('says none could be listed when the claim cap is hit and the server lists none', async () => {
    const [task] = seedTasks(1);
    api.claims.set(task?.id ?? '', 'claim_cap');
    const { code, out, err } = await run('prove');
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(err).toContain(
      'An agent can hold at most 10 claimed tasks. This agent holds the maximum and none of them could be listed.',
    );
    expect(err).not.toContain('Submit the tasks below first');
  });

  it('prints tasks it already holds first, without claiming them again', async () => {
    const held = api.add({
      state: 'claimed',
      claimantAgentId: agentId,
      claimedAt: new Date().toISOString(),
    });
    const done = api.add({ state: 'verified', claimantAgentId: agentId });
    for (const task of [held, done]) {
      await appendEvent({
        event_id: randomUUID(),
        type: 'task.claimed',
        occurred_at: new Date().toISOString(),
        version: '1.0.0',
        payload: { task_id: task.id, task_type: task.taskType },
      });
    }
    const open = seedTasks(3);

    const { code, out } = await run('prove', '--count', '2');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([open[0]?.id]);
    expect(out).toContain(`Task 1 of 2. id ${held.id}.`);
    expect(out).toContain(`Task 2 of 2. id ${open[0]?.id}.`);
    expect(out).not.toContain(done.id);
  });

  it('caps --count at the maximum and rejects a count that is not a number', async () => {
    seedTasks(12);
    const { code, out } = await run('prove', '--count', '50');
    expect(code).toBe(0);
    expect(api.claimed).toHaveLength(MAX_COUNT);
    expect(out).toContain(`Task ${MAX_COUNT} of ${MAX_COUNT}.`);

    for (const bad of ['0', '-1', 'two', '2.5']) {
      const result = await run('prove', '--count', bad);
      expect(result.code).toBe(1);
      expect(result.err).toContain('must be a whole number from 1 to 10');
    }
  });

  it('prints one JSON object with --json', async () => {
    const tasks = seedTasks(3);
    const { code, out } = await run('prove', '--count', '2', '--json');
    expect(code).toBe(0);
    const body = JSON.parse(out);
    expect(Object.keys(body)).toEqual(['tasks', 'submitHint']);
    expect(body.submitHint).toBe(SUBMIT_HINT);
    expect(body.tasks).toEqual(
      tasks.slice(0, 2).map((t) => ({
        id: t.id,
        taskType: 'json_extract',
        state: 'claimed',
        verification: t.verification,
        expiresAt: t.expiresAt,
        spec: t.spec,
      })),
    );
  });

  it('prints the schema for a schema task', async () => {
    const jsonSchema = {
      type: 'object',
      properties: { a: { type: 'integer' } },
      required: ['a'],
      additionalProperties: false,
    };
    api.add({
      taskType: 'json_shape',
      verification: { kind: 'schema', jsonSchema },
    });
    const { out } = await run('prove', '--count', '1');
    expect(out).toContain(
      `The answer must be JSON that matches this schema:\n${JSON.stringify(
        jsonSchema,
        null,
        2,
      )
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n')}\nSubmit with:`,
    );
  });

  it('says so and exits 0 when there is no open task', async () => {
    api.add({ posterAgentId: agentId });
    const { code, out, err } = await run('prove');
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toBe(
      'no open tasks available. New seed tasks are posted every 15 minutes, try again later.\n',
    );
    expect(api.claimed).toEqual([]);

    const json = JSON.parse((await run('prove', '--json')).out);
    expect(json).toEqual({ tasks: [], submitHint: SUBMIT_HINT });
  });

  it('gives the init hint without a config and sends nothing', async () => {
    await rm(paths().config);
    const { code, out, err } = await run('prove');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('not initialised, run sealkeeper init\n');
    expect(api.requests).toEqual([]);
  });

  it('ends with the API message when the agent is not registered', async () => {
    const [task] = seedTasks(1);
    api.claims.set(task?.id ?? '', 'unknown_agent');
    const { code, out, err } = await run('prove');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('Agent is not registered\n');
  });

  it('says expiry in plain relative words', () => {
    expect(relative(-1)).toBe('now');
    expect(relative(30_000)).toBe('in under a minute');
    expect(relative(60_000)).toBe('in 1 minute');
    expect(relative(90 * 60_000)).toBe('in 90 minutes');
    expect(relative(47.5 * HOUR)).toBe('in 47 hours');
    expect(relative(5 * 24 * HOUR)).toBe('in 5 days');
  });
});
