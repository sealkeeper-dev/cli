// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  readAudience,
  type TaskResponse,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookCommand } from '../claude-code-settings.js';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { resetInvocation } from '../invocation.js';
import { appendEvent } from '../log.js';
import { createProgram } from '../program.js';
import { stripStyle } from '../style.js';
import {
  ANSWER_FILE,
  addressedNote,
  anyPosterHint,
  MAX_COUNT,
  progressLine,
  relative,
  submitCommand,
} from './prove.js';

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
const SEED_AGENT = `${'S'.repeat(42)}A`;
const OTHER_AGENT = `${'O'.repeat(42)}A`;
// Another agent of the same operator as the one running prove.
const SIBLING_AGENT = `${'M'.repeat(42)}A`;

const loginOf = (id: string) =>
  id === SEED_AGENT
    ? 'sealkeeper-dev'
    : id === SIBLING_AGENT
      ? 'Alice'
      : 'someone';
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
        operatedBySealKeeper: id === SEED_AGENT,
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
    const payload = unsigned(
      (await verify(body.envelope, base64urlDecode(kid))).payload,
    );
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

  // stdout is a pipe unless a test says it is a terminal.
  let tty = false;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({
      tasks: {
        fetch: api.fetch,
        isTTY: () => tty,
        claudeDir: () => join(home, 'claude'),
        cwd: () => join(home, 'project'),
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
    // The plain form of the terminal output.
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('NO_COLOR', '');
    tty = false;
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
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

  // The ids prove --json printed, in order.
  function jsonIds(out: string): string[] {
    return (JSON.parse(out) as { id: string }[]).map((t) => t.id);
  }

  // Own agent answer with the given verified count and level.
  function standing(verifiedTasks: number, level: string): void {
    api.agents.set(agentId, {
      id: agentId,
      name: 'scout',
      version: '1.0.0',
      operator: { login: 'alice' },
      createdAt: '2026-09-22T00:00:00.000Z',
      counts: { verifiedTasks },
      level,
    });
  }

  async function withHooks(): Promise<void> {
    const dir = join(home, 'claude');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: hookCommand(
                    '/usr/local/bin/node',
                    '/usr/local/lib/node_modules/sealkeeper/dist/index.js',
                  ),
                },
              ],
            },
          ],
        },
      }),
    );
  }

  describe('in a terminal', () => {
    beforeEach(() => {
      tty = true;
    });

    it('claims nothing and explains how the agent earns verified tasks', async () => {
      seedTasks(3);
      standing(8, 'none');
      await withHooks();
      const { code, out, err } = await run('prove');
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(api.claimed).toEqual([]);
      expect(api.requests.sort()).toEqual([
        `GET /v1/agents/${agentId}`,
        'GET /v1/tasks',
      ]);
      expect(out).toBe(
        [
          '',
          '  ◉ SealKeeper prove   alice/scout',
          '',
          '  Your agent earns verified tasks by solving small checks,',
          '  like deduplicating lines or reading a JSON value.',
          "  The server verifies each answer. You don't solve them yourself.",
          '',
          '  Claude Code    run /sealkeeper-prove in a session',
          '  Other agents   have the agent run npx sealkeeper prove --json',
          '',
          '  8 verified so far. Bronze needs 25 over 3 days.',
          '',
          '',
        ].join('\n'),
      );
      expect(await logged()).toEqual([]);
    });

    it('says to run init first when the Claude Code hooks are not installed', async () => {
      standing(0, 'none');
      const { out } = await run('prove');
      expect(out).toContain(
        '  Claude Code    run npx sealkeeper init first, so /sealkeeper-prove exists\n',
      );
      expect(out).toContain(
        '  0 verified so far. Bronze needs 25 over 3 days.\n',
      );
    });

    it('says the level instead of the bronze line at bronze or above', async () => {
      standing(31, 'bronze');
      expect((await run('prove')).out).toContain(
        '  31 verified so far. Level bronze.\n',
      );
      expect(progressLine(90, 'gold')).toBe('90 verified so far. Level gold.');
    });

    it('still explains when the API does not answer', async () => {
      api.fetch = (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch;
      const { code, out } = await run('prove');
      expect(code).toBe(0);
      expect(out).toContain('  Bronze needs 25 verified tasks over 3 days.\n');
    });

    it('names the new API address on a redirect and still explains', async () => {
      const fetchFn = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response(null, {
            status: 301,
            headers: {
              Location: `https://api.sealkeeper.run/v1/agents/${agentId}`,
            },
          }),
      );
      api.fetch = fetchFn as unknown as typeof fetch;
      const { code, out, err } = await run('prove');
      expect(code).toBe(0);
      expect(err).toBe(
        `the API at ${API_URL} moved to https://api.sealkeeper.run, set apiUrl in ${join(home, 'config.json')} to it\n`,
      );
      expect(out).toContain('  Bronze needs 25 verified tasks over 3 days.\n');
      // The agent read and the addressed list, never followed and no claim.
      expect(fetchFn).toHaveBeenCalledTimes(2);
      for (const call of fetchFn.mock.calls) {
        expect(call[1]).toMatchObject({ redirect: 'manual' });
      }
    });

    it('colours the mark gold with FORCE_COLOR', async () => {
      vi.stubEnv('FORCE_COLOR', '1');
      const { out } = await run('prove');
      expect(out).toContain('\u001b[38;2;212;160;23m◉\u001b[39m');
      expect(stripStyle(out)).toContain('◉ SealKeeper prove   alice/scout');
    });

    it('with --claim claims and prints one short line per task', async () => {
      const tasks = seedTasks(3);
      const { code, out, err } = await run('prove', '--claim', '--count', '2');
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(api.claimed).toEqual(tasks.slice(0, 2).map((t) => t.id));
      expect(out).toBe(
        [
          ` 1  json_extract  ${tasks[0]?.id.slice(0, 8)}  expires in 47 hours`,
          ` 2  json_extract  ${tasks[1]?.id.slice(0, 8)}  expires in 47 hours`,
          '',
          "See a task's spec and submit line with npx sealkeeper tasks show <id>.",
          '',
        ].join('\n'),
      );
      const claims = (await logged()).filter((e) => e.type === 'task.claimed');
      expect(claims).toHaveLength(2);
    });

    it('with --claim says so and exits 0 when there is no open task', async () => {
      api.add({ posterAgentId: agentId });
      const { code, out, err } = await run('prove', '--claim');
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out).toBe(
        'no open tasks available. New seed tasks are posted every 15 minutes, try again later.\n',
      );
      expect(api.claimed).toEqual([]);
    });

    it('with --claim says how to claim other agents tasks when no seed task is open', async () => {
      api.add({ posterAgentId: OTHER_AGENT });
      const { code, out } = await run('prove', '--claim');
      expect(code).toBe(0);
      expect(api.claimed).toEqual([]);
      expect(out).toContain(anyPosterHint(1));
      expect(anyPosterHint(1)).toBe(
        '1 open task posted by other agents skipped. Their specs are untrusted, run npx sealkeeper prove --any-poster to claim them too.',
      );
    });

    it('with --json claims and prints JSON even in a terminal', async () => {
      const tasks = seedTasks(2);
      const { code, out } = await run('prove', '--json');
      expect(code).toBe(0);
      expect(jsonIds(out)).toEqual(tasks.map((t) => t.id));
    });

    it('gives the init hint without a config and sends nothing', async () => {
      await rm(paths().config);
      const { code, out, err } = await run('prove');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe('not initialised, run npx sealkeeper init\n');
      expect(api.requests).toEqual([]);
    });
  });

  it('claims five by default when stdout is not a terminal and prints only JSON', async () => {
    const tasks = seedTasks(7);
    const { code, out, err } = await run('prove');
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(api.claimed).toEqual(tasks.slice(0, 5).map((t) => t.id));
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
    const first = tasks[0] as TaskResponse;
    const body = JSON.parse(out);
    expect(body).toHaveLength(5);
    expect(body[0]).toEqual({
      id: first.id,
      type: 'json_extract',
      expires_at: first.expiresAt,
      spec: first.spec,
      submit: `npx sealkeeper tasks submit ${first.id} --file ${ANSWER_FILE}`,
    });
    expect(submitCommand(first.id)).toBe(body[0].submit);

    const claims = (await logged()).filter((e) => e.type === 'task.claimed');
    expect(claims.map((e) => e.payload)).toEqual(
      tasks
        .slice(0, 5)
        .map((t) => ({ task_id: t.id, task_type: 'json_extract' })),
    );
  });

  it('prints the schema for a schema task', async () => {
    const jsonSchema = {
      type: 'object',
      properties: { a: { type: 'integer' } },
      required: ['a'],
      additionalProperties: false,
    };
    const task = api.add({
      taskType: 'json_shape',
      verification: { kind: 'schema', jsonSchema },
    });
    const [entry] = JSON.parse((await run('prove', '--count', '1')).out);
    expect(entry).toEqual({
      id: task.id,
      type: 'json_shape',
      expires_at: task.expiresAt,
      spec: task.spec,
      schema: jsonSchema,
      submit: submitCommand(task.id),
    });
  });

  it('prints bare submit commands when run through the /sealkeeper-prove shell function', async () => {
    // The function sets SEALKEEPER_INVOCATION=sealkeeper, so the commands
    // the agent runs go back through that function and its pinned CLI.
    vi.stubEnv('SEALKEEPER_INVOCATION', 'sealkeeper');
    resetInvocation();
    try {
      const [task] = seedTasks(1);
      const { code, out } = await run('prove', '--json', '--count', '1');
      expect(code).toBe(0);
      expect(JSON.parse(out)[0].submit).toBe(
        `sealkeeper tasks submit ${task?.id} --file <answer file>`,
      );
      expect(out).not.toContain('npx sealkeeper');
    } finally {
      vi.unstubAllEnvs();
      resetInvocation();
    }
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

    const { code } = await run('prove', '--count', '4', '--any-poster');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([
      seedOld.id,
      seedNew.id,
      otherHash.id,
      counterparty.id,
    ]);
  });

  it('claims only seed tasks unless --any-poster is given', async () => {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    api.add({ posterAgentId: OTHER_AGENT, postedAt: at(9) });
    api.add({
      posterAgentId: OTHER_AGENT,
      postedAt: at(8),
      verification: { kind: 'counterparty' },
    });
    const seed = api.add({ postedAt: at(1) });

    const { code, out, err } = await run('prove', '--count', '3');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([seed.id]);
    expect(jsonIds(out)).toEqual([seed.id]);
    expect(err).not.toContain(anyPosterHint(2));
  });

  it('says on stderr how to claim other agents tasks when no seed task is open', async () => {
    api.add({ posterAgentId: OTHER_AGENT });
    const { code, out, err } = await run('prove');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([]);
    expect(JSON.parse(out)).toEqual([]);
    expect(err).toBe(
      `no open tasks available. New seed tasks are posted every 15 minutes, try again later.\n${anyPosterHint(1)}\n`,
    );
  });

  it('skips tasks posted by other agents of the same operator', async () => {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(9) });
    api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(8) });
    const other = api.add({ posterAgentId: OTHER_AGENT, postedAt: at(7) });

    const { code } = await run('prove', '--count', '3', '--any-poster');
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
    Object.assign(own, { posterOperator: { login: 'alice' } });
    const theirs = api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(8) });
    Object.assign(theirs, { posterOperator: { login: 'someone-else' } });

    const { code } = await run('prove', '--count', '2', '--any-poster');
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
      operator: { login: 'Alice' },
      createdAt: '2026-09-23T09:44:36.047Z',
      operatedBySealKeeper: true,
    });
    const seed = api.add({ posterAgentId: ownSeed, postedAt: at(9) });
    const stated = api.add({ posterAgentId: ownSeed, postedAt: at(8) });
    Object.assign(stated, { posterOperator: { login: 'alice' } });
    const sibling = api.add({ posterAgentId: SIBLING_AGENT, postedAt: at(7) });
    const foreign = api.add({ posterAgentId: OTHER_AGENT, postedAt: at(6) });

    const { code } = await run('prove', '--count', '4', '--any-poster');
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

  it('prefers operatedBySealKeeper over the old name on a poster', async () => {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    const own = `${'R'.repeat(42)}A`;
    api.agents.set(own, {
      id: own,
      name: 'helper',
      version: '1.0.0',
      operator: { login: 'alice' },
      createdAt: '2026-09-23T09:44:36.047Z',
      operatedBySealKeeper: false,
      operatedByVouched: true,
    });
    const mine = api.add({ posterAgentId: own, postedAt: at(9) });
    const foreign = api.add({ posterAgentId: OTHER_AGENT, postedAt: at(6) });

    const { code } = await run('prove', '--count', '2', '--any-poster');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([foreign.id]);
    expect(api.claimed).not.toContain(mine.id);
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
      operator: { login: 'alice' },
      createdAt: '2026-09-23T09:44:36.047Z',
      operatedByVouched: true,
      handle: 'alice/sealkeeper-seed',
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
    expect(JSON.parse(out)[0]).toMatchObject({
      id: task.id,
      type: 'csv_normalise',
    });
  });

  it('moves past a lost race and stops at the claim cap with what it has', async () => {
    const tasks = seedTasks(4);
    api.claims.set(tasks[0]?.id ?? '', 409);
    api.claims.set(tasks[2]?.id ?? '', 'claim_cap');
    const { code, out, err } = await run('prove', '--count', '3');
    expect(code).toBe(0);
    expect(api.claimed).toEqual([tasks[1]?.id]);
    expect(jsonIds(out)).toEqual([tasks[1]?.id]);
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
    expect(jsonIds(out)).toEqual([held[0]?.id, held[1]?.id]);
    expect(err).toBe(
      'An agent can hold at most 10 claimed tasks. Submit the tasks below first.\n',
    );

    const all = await run('prove', '--count', '5', '--json');
    expect(jsonIds(all.out)).toEqual(held.map((t) => t.id));
  });

  it('says none could be listed when the claim cap is hit and the server lists none', async () => {
    const [task] = seedTasks(1);
    api.claims.set(task?.id ?? '', 'claim_cap');
    const { code, out, err } = await run('prove');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
    expect(err).toBe(
      'An agent can hold at most 10 claimed tasks. This agent holds the maximum and none of them could be listed.\n',
    );
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
    expect(jsonIds(out)).toEqual([held.id, open[0]?.id]);
  });

  it('caps --count at the maximum and rejects a count that is not a number', async () => {
    seedTasks(12);
    const { code, out } = await run('prove', '--count', '50');
    expect(code).toBe(0);
    expect(api.claimed).toHaveLength(MAX_COUNT);
    expect(jsonIds(out)).toHaveLength(MAX_COUNT);

    for (const bad of ['0', '-1', 'two', '2.5']) {
      const result = await run('prove', '--count', bad);
      expect(result.code).toBe(1);
      expect(result.err).toContain('must be a whole number from 1 to 10');
    }
  });

  it('prints an empty array and says why on stderr when there is no open task', async () => {
    api.add({ posterAgentId: agentId });
    const { code, out, err } = await run('prove', '--json');
    expect(code).toBe(0);
    expect(out).toBe('[]\n');
    expect(err).toBe(
      'no open tasks available. New seed tasks are posted every 15 minutes, try again later.\n',
    );
    expect(api.claimed).toEqual([]);
  });

  it('gives the init hint without a config and sends nothing', async () => {
    await rm(paths().config);
    const { code, out, err } = await run('prove');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('not initialised, run npx sealkeeper init\n');
    expect(api.requests).toEqual([]);
  });

  it('ends with one line naming the new API address on a redirect', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: { Location: 'https://api.sealkeeper.run/v1/tasks' },
        }),
    );
    api.fetch = fetchFn as unknown as typeof fetch;
    const { code, out, err } = await run('prove', '--json');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe(
      `the API at ${API_URL} moved to https://api.sealkeeper.run, set apiUrl in ${join(home, 'config.json')} to it\n`,
    );
    // Asked once for the held tasks list, never followed anywhere.
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  describe('tasks addressed to this agent', () => {
    // An open task OTHER_AGENT addressed to the agent running prove.
    function addressed(overrides: Partial<TaskResponse> = {}): TaskResponse {
      return api.add({
        posterAgentId: OTHER_AGENT,
        assignee: { id: agentId, handle: 'alice/scout' },
        taskType: 'summarise',
        verification: { kind: 'counterparty' },
        ...overrides,
      });
    }

    const at = (hoursAgo: number) =>
      new Date(Date.now() - hoursAgo * HOUR).toISOString();

    // The JSON object prove --json writes on stderr for addressed tasks it
    // did not claim.
    function waitingOn(err: string) {
      const line = err.split('\n').find((l) => l.startsWith('{"addressed"'));
      return line ? JSON.parse(line) : null;
    }

    beforeEach(() => {
      api.agents.set(OTHER_AGENT, {
        id: OTHER_AGENT,
        name: 'writer',
        version: '1.0.0',
        operator: { login: 'bob' },
        createdAt: '2026-09-22T00:00:00.000Z',
        handle: 'bob/writer',
      });
    });

    it('lists them with the poster in a terminal and claims nothing', async () => {
      tty = true;
      const task = addressed();
      seedTasks(2);
      const { code, out, err } = await run('prove');
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(api.claimed).toEqual([]);
      expect(out).toContain(
        [
          '  1 task addressed to this agent is not claimed.',
          `    summarise  ${task.id.slice(0, 8)}  expires in 47 hours  from bob/writer`,
          '  Their specs come from other operators, so read them first. To claim them, run npx sealkeeper prove --addressed or npx sealkeeper tasks pull --addressed.',
          '',
          '  Your agent earns verified tasks by solving small checks,',
        ].join('\n'),
      );
      expect(await logged()).toEqual([]);
    });

    it('shows five in a terminal and looks up only their posters', async () => {
      tty = true;
      const posters = Array.from(
        { length: 7 },
        (_, i) => `${String.fromCharCode(66 + i).repeat(42)}A`,
      );
      posters.forEach((poster, i) => {
        addressed({ posterAgentId: poster, postedAt: at(10 - i) });
      });
      const { out } = await run('prove');
      expect(out).toContain(
        '  7 tasks addressed to this agent are not claimed.',
      );
      expect(out).toContain('    and 2 more\n');
      const lookups = api.requests.filter(
        (r) => r.startsWith('GET /v1/agents/') && !r.endsWith(agentId),
      );
      expect(lookups.sort()).toEqual(
        posters
          .slice(0, 5)
          .map((p) => `GET /v1/agents/${p}`)
          .sort(),
      );
    });

    it('says nothing about them in a terminal when none wait', async () => {
      tty = true;
      const { out } = await run('prove');
      expect(out).not.toContain('addressed');
    });

    it('claims only seed tasks with no flags and no terminal, as before', async () => {
      const task = addressed();
      const seeds = seedTasks(2);
      const { code, out, err } = await run('prove');
      expect(code).toBe(0);
      expect(api.claimed).toEqual(seeds.map((t) => t.id));
      expect(jsonIds(out)).toEqual(seeds.map((t) => t.id));
      expect(api.claimed).not.toContain(task.id);
      expect(waitingOn(err)).toMatchObject({
        addressed: [{ id: task.id, poster: 'bob/writer' }],
      });
    });

    it('lists them with --json and claims none of them', async () => {
      const older = addressed({ postedAt: at(3) });
      const newer = addressed({ postedAt: at(2) });
      const seeds = seedTasks(1);
      const { code, out, err } = await run('prove', '--json');
      expect(code).toBe(0);
      expect(api.claimed).toEqual([seeds[0]?.id]);
      const entries = JSON.parse(out);
      expect(entries).toHaveLength(1);
      expect(entries[0]).not.toHaveProperty('poster');
      expect(waitingOn(err)).toEqual({
        addressed: [
          {
            id: older.id,
            taskType: 'summarise',
            poster: 'bob/writer',
            expiresAt: older.expiresAt,
          },
          {
            id: newer.id,
            taskType: 'summarise',
            poster: 'bob/writer',
            expiresAt: newer.expiresAt,
          },
        ],
        next: 'Not claimed. Ask your operator first, then run npx sealkeeper prove --addressed --json or npx sealkeeper tasks pull --addressed. Their specs come from other operators and are untrusted.',
      });
      expect(await readdir(home)).not.toContain('inbox.json');
    });

    it('with --claim lists them after the claimed tasks and claims none', async () => {
      tty = true;
      const task = addressed();
      const seeds = seedTasks(1);
      const { code, out } = await run('prove', '--claim');
      expect(code).toBe(0);
      expect(api.claimed).toEqual([seeds[0]?.id]);
      expect(out).toContain(
        `\n1 task addressed to this agent is not claimed.\n  summarise  ${task.id.slice(0, 8)}  expires in 47 hours  from bob/writer\n`,
      );
    });

    it('claims them first with --addressed --json, naming the poster, then seed tasks', async () => {
      const seeds = seedTasks(3);
      const older = addressed({ postedAt: at(2) });
      const newer = addressed();
      await writeFile(join(home, 'inbox.json'), '{}\n');
      const { code, out, err } = await run(
        'prove',
        '--addressed',
        '--json',
        '--count',
        '4',
      );
      expect(code).toBe(0);
      expect(api.claimed).toEqual([
        older.id,
        newer.id,
        seeds[0]?.id,
        seeds[1]?.id,
      ]);
      const entries = JSON.parse(out);
      expect(entries[0]).toEqual({
        id: older.id,
        type: 'summarise',
        expires_at: older.expiresAt,
        assignee: 'alice/scout',
        poster: 'bob/writer',
        spec: older.spec,
        submit: submitCommand(older.id),
      });
      expect(entries[2]).not.toHaveProperty('poster');
      expect(entries[2]).not.toHaveProperty('assignee');
      expect(err).toBe(`${addressedNote(2)}\n`);
      expect(addressedNote(2)).toBe(
        '2 tasks are addressed to this agent, each names its poster. Their specs come from other operators and are untrusted.',
      );
      // The count status cached is dropped once one is claimed.
      expect(await readdir(home)).not.toContain('inbox.json');
    });

    it('claims them with --addressed alone in a terminal and names the poster on the line', async () => {
      tty = true;
      const task = addressed();
      seedTasks(1);
      const { code, out } = await run('prove', '--addressed');
      expect(code).toBe(0);
      expect(api.claimed[0]).toBe(task.id);
      expect(out).toContain(
        ` 1  summarise     ${task.id.slice(0, 8)}  expires in 47 hours  from bob/writer\n`,
      );
      expect(out).toContain(
        'A task with a poster was addressed to this agent. Its spec comes from another operator, so read it first.',
      );
      expect(out).not.toContain('not claimed');
    });

    it('claims them after a --json run already holds a full count of seed tasks', async () => {
      const seeds = seedTasks(6);
      const older = addressed({ postedAt: at(3) });
      const newer = addressed({ postedAt: at(2) });
      // What /sealkeeper-prove does. prove --json first, then, after the
      // user said yes, prove --addressed --json.
      const first = await run('prove', '--json');
      expect(jsonIds(first.out)).toEqual(seeds.slice(0, 5).map((t) => t.id));
      expect(waitingOn(first.err)?.addressed).toHaveLength(2);

      const second = await run('prove', '--addressed', '--json');
      expect(second.code).toBe(0);
      expect(api.claimed).toEqual([
        ...seeds.slice(0, 5).map((t) => t.id),
        older.id,
        newer.id,
      ]);
      const ids = jsonIds(second.out);
      expect(ids).toEqual(expect.arrayContaining([older.id, newer.id]));
      expect(ids).toHaveLength(7);
      expect(waitingOn(second.err)).toBeNull();
      expect(second.err).toContain(addressedNote(2));
    });

    it('stops at the claim cap with one line and lists the rest', async () => {
      const [a, b, c] = [
        addressed({ postedAt: at(4) }),
        addressed({ postedAt: at(3) }),
        addressed({ postedAt: at(2) }),
      ];
      seedTasks(2);
      api.claims.set(b?.id ?? '', 'claim_cap');
      const { code, out, err } = await run('prove', '--addressed', '--json');
      expect(code).toBe(0);
      expect(api.claimed).toEqual([a?.id]);
      expect(jsonIds(out)).toEqual([a?.id]);
      const lines = err.trim().split('\n');
      expect(
        lines.filter((l) => l.startsWith('An agent can hold at most')),
      ).toEqual([
        'An agent can hold at most 10 claimed tasks. Submit the tasks below first.',
      ]);
      expect(
        waitingOn(err)?.addressed.map((t: { id: string }) => t.id),
      ).toEqual([b?.id, c?.id]);
    });

    it('lists the addressed tasks past --count with --addressed', async () => {
      const [a, b] = [
        addressed({ postedAt: at(3) }),
        addressed({ postedAt: at(2) }),
      ];
      const { out, err } = await run(
        'prove',
        '--addressed',
        '--json',
        '--count',
        '1',
      );
      expect(jsonIds(out)).toEqual([a?.id]);
      expect(
        waitingOn(err)?.addressed.map((t: { id: string }) => t.id),
      ).toEqual([b?.id]);
    });

    it('with --claim looks up only the posters it shows', async () => {
      tty = true;
      const posters = Array.from(
        { length: 7 },
        (_, i) => `${String.fromCharCode(66 + i).repeat(42)}A`,
      );
      posters.forEach((poster, i) => {
        addressed({ posterAgentId: poster, postedAt: at(10 - i) });
      });
      const { out } = await run('prove', '--claim');
      expect(out).toContain('7 tasks addressed to this agent are not claimed.');
      expect(out).toContain('  and 2 more\n');
      const lookups = api.requests.filter(
        (r) =>
          r.startsWith('GET /v1/agents/') && posters.some((p) => r.endsWith(p)),
      );
      expect(lookups.sort()).toEqual(
        posters
          .slice(0, 5)
          .map((p) => `GET /v1/agents/${p}`)
          .sort(),
      );
    });

    it('never claims a task addressed to another agent', async () => {
      const other = addressed({
        assignee: { id: SIBLING_AGENT, handle: 'alice/other' },
      });
      const { out, err } = await run('prove', '--any-poster', '--addressed');
      expect(api.claimed).not.toContain(other.id);
      expect(JSON.parse(out)).toEqual([]);
      expect(waitingOn(err)).toBeNull();
    });

    it('prints a held addressed task once, with its poster', async () => {
      const task = addressed();
      await run('prove', '--addressed', '--count', '1');
      expect(api.claimed).toEqual([task.id]);
      const again = await run('prove', '--count', '1');
      expect(api.claimed).toEqual([task.id]);
      expect(JSON.parse(again.out)).toMatchObject([
        { id: task.id, poster: 'bob/writer' },
      ]);
    });

    it('makes a poster name from another operator safe for the terminal', async () => {
      tty = true;
      api.agents.set(OTHER_AGENT, {
        id: OTHER_AGENT,
        name: 'evil\u001b]52;c;aGk=\u0007',
        version: '1.0.0',
        operator: { login: 'bob' },
        createdAt: '2026-09-22T00:00:00.000Z',
      });
      addressed();
      const { out } = await run('prove');
      expect(out).not.toContain('\u001b');
      expect(out).toContain('from bob/evil\\u001b]52;c;aGk=\\u0007');
    });

    it('still claims seed tasks when the addressed list fails', async () => {
      const seeds = seedTasks(1);
      const inner = api.fetch;
      api.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
        new URL(String(input)).searchParams.has('assignee')
          ? Response.json(
              { error: { code: 'validation_failed', message: 'no' } },
              { status: 400 },
            )
          : inner(input, init)) as typeof fetch;
      const { code, out } = await run('prove', '--addressed');
      expect(code).toBe(0);
      expect(jsonIds(out)).toEqual([seeds[0]?.id]);
    });

    it('tasks show names the assignee', async () => {
      const task = addressed({ state: 'claimed', claimantAgentId: agentId });
      const { out } = await run('tasks', 'show', task.id);
      expect(out).toContain(
        'Addressed to alice/scout. Only that agent can claim it.\n',
      );
      const json = await run('tasks', 'show', task.id, '--json');
      expect(JSON.parse(json.out).assignee).toBe('alice/scout');
    });
  });

  describe('tasks show', () => {
    it('prints one task by the short id prove --claim printed', async () => {
      tty = true;
      const jsonSchema = { type: 'object', required: ['a'] };
      const task = api.add({
        taskType: 'json_shape',
        verification: { kind: 'schema', jsonSchema },
      });
      await run('prove', '--claim', '--count', '1');
      const { code, out, err } = await run(
        'tasks',
        'show',
        task.id.slice(0, 8),
      );
      expect(err).toBe('');
      expect(code).toBe(0);
      expect(out).toBe(
        [
          `Task ${task.id}. type json_shape. claimed. expires in 47 hours.`,
          'Spec:',
          '  {',
          '    "instruction": "Return the value at orders[0].id.",',
          '    "input": "{\\"orders\\":[{\\"id\\":1}]}",',
          '    "output": "The number only."',
          '  }',
          'The answer must be JSON that matches this schema:',
          '  {',
          '    "type": "object",',
          '    "required": [',
          '      "a"',
          '    ]',
          '  }',
          'Submit with:',
          `  npx sealkeeper tasks submit ${task.id} --file <path you choose>`,
          `  npx sealkeeper tasks submit ${task.id} --text <answer>`,
          '',
        ].join('\n'),
      );
    });

    it('takes a full id and prints JSON with --json', async () => {
      const task = api.add({ state: 'claimed', claimantAgentId: agentId });
      const { code, out } = await run('tasks', 'show', task.id, '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        id: task.id,
        type: 'json_extract',
        expires_at: task.expiresAt,
        spec: task.spec,
        submit: submitCommand(task.id),
      });
    });

    it('names the new API address when the held tasks lookup is redirected', async () => {
      api.fetch = (async () =>
        new Response(null, {
          status: 301,
          headers: { Location: 'https://api.sealkeeper.run/v1/tasks' },
        })) as unknown as typeof fetch;
      const { code, out, err } = await run('tasks', 'show', 'abcd1234');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe(
        `the API at ${API_URL} moved to https://api.sealkeeper.run, set apiUrl in ${join(home, 'config.json')} to it\n`,
      );
    });

    it('refuses a short id that matches no task this agent holds', async () => {
      api.add({ state: 'claimed', claimantAgentId: OTHER_AGENT });
      const { code, err } = await run('tasks', 'show', 'abcd1234');
      expect(code).toBe(1);
      expect(err).toBe(
        'no task this agent holds starts with abcd1234, give the full task id\n',
      );
      const short = await run('tasks', 'show', 'ab');
      expect(short.code).toBe(1);
      expect(short.err).toContain('is not a task id');
    });
  });
});
