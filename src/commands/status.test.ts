// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Event } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_UNKNOWN_INTRO, wasAskedRuntime } from '../agent-runtime.js';
import type { Input } from '../ask.js';
import { hookCommand } from '../claude-code-settings.js';
import {
  defaultRoutineConfig,
  paths,
  readRoutineConfig,
  writeConfig,
  writeRoutineConfig,
} from '../config.js';
import { createKey } from '../identity.js';
import { appendEvent, dayOf, writeCursor } from '../log.js';
import { readOperatorSlug } from '../operator-slug.js';
import { createProgram } from '../program.js';
import { copyPaths, writeCopy } from '../routine-copy.js';
import { VERSION } from '../version.js';
import {
  dormancyLine,
  HOOKS_MISSING,
  minutesToNextScoring,
  NO_ADAPTER,
  nextScoringLine,
  sealWithheld,
  TOOL_HOOKS_LEFT,
} from './status.js';

const AGENT_ID = 'A'.repeat(43);
const API_URL = 'https://api.test';
const LAST_SYNC = '2026-09-23T09:00:00.000Z';

type RunResult = { code: number; out: string; err: string; ms: number };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

// addressed is how many open tasks the API lists for this agent.
type Live = {
  level?: string;
  dormantDays?: number | null;
  addressed?: number;
  // The goal answer, 404 when left out.
  goal?: Record<string, unknown>;
  // standing.held on the agent answer, and the SEAL route's answer.
  held?: boolean;
  seal?: () => Response;
  // The agent answer's fingerprint, left out when undefined (VB-4).
  fingerprint?: unknown;
};

// An open task addressed to the agent, as GET /v1/tasks answers it.
function addressedTask() {
  return {
    id: randomUUID(),
    posterAgentId: `${'B'.repeat(42)}A`,
    claimantAgentId: null,
    assignee: { id: AGENT_ID, handle: 'alice/scout' },
    taskType: 'summarise',
    spec: { words: 100 },
    verification: { kind: 'counterparty' },
    state: 'open',
    postedAt: '2026-09-23T08:00:00.000Z',
    claimedAt: null,
    submittedAt: null,
    verifiedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

function agentAnswer(verifiedTasks: number, live: Live = {}) {
  return {
    ...(live.level === undefined ? {} : { level: live.level }),
    ...(live.fingerprint === undefined
      ? {}
      : { fingerprint: live.fingerprint }),
    ...(live.dormantDays === undefined && live.held === undefined
      ? {}
      : {
          standing: {
            counts: {},
            history_days: 3,
            last_active: null,
            dormant_days: live.dormantDays ?? 0,
            quiet: (live.dormantDays ?? 0) >= 14,
            ...(live.held === undefined ? {} : { held: live.held }),
          },
        }),
    id: AGENT_ID,
    name: 'scout',
    version: '1.0.0',
    operator: { login: 'alice' },
    createdAt: '2026-09-23T08:00:00.000Z',
    operatedBySealKeeper: false,
    operatedByVouched: false,
    handle: 'alice/scout',
    previousName: null,
    counts: {
      events: 7,
      verifiedTasks,
      incidents: 1,
      sessions: 1,
      toolCalls: 3,
    },
    lastSeenAt: null,
  };
}

// The score and agent routes. verifiedTasks is the live count the agent
// route answers with.
function scoreFetch(
  scores: {
    dimension: string;
    value: number | null;
    types?: { taskType: string; value: number }[];
  }[],
  verifiedTasks = 2,
  live: Live = {},
) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${API_URL}/v1/agents/${AGENT_ID}`) {
      return Response.json(agentAnswer(verifiedTasks, live));
    }
    if (url.startsWith(`${API_URL}/v1/tasks?`)) {
      const query = new URL(url).searchParams;
      expect(query.get('assignee')).toBe(AGENT_ID);
      expect(query.get('state')).toBe('open');
      return Response.json({
        tasks: Array.from({ length: live.addressed ?? 0 }, addressedTask),
      });
    }
    if (url === `${API_URL}/v1/agents/${AGENT_ID}/seal`) {
      if (!live.seal) throw new Error('no SEAL route answer in this test');
      return live.seal();
    }
    if (url === `${API_URL}/v1/agents/${AGENT_ID}/goal`) {
      return live.goal
        ? Response.json(live.goal)
        : Response.json(
            { error: { code: 'not_found', message: 'Agent not found' } },
            { status: 404 },
          );
    }
    expect(url).toBe(`${API_URL}/v1/agents/${AGENT_ID}/score`);
    return Response.json({
      agentId: AGENT_ID,
      scores: scores.map((s) => ({
        version: '1.0.0',
        windowStart: '2026-09-01T00:00:00.000Z',
        windowEnd: '2026-09-23T00:00:00.000Z',
        computedAt: '2026-09-23T00:00:00.000Z',
        ...s,
      })),
    });
  }) as typeof fetch;
}

// The terminal status reads from. A closed pipe unless a test sets one.
let terminal: Input = { isTTY: false, readLine: async () => null };

async function run(fetchFn: typeof fetch, ...args: string[]) {
  const program = createProgram({
    sync: {
      fetch: fetchFn,
      sleep: async () => {},
      cwd: () => join(String(process.env.SEALKEEPER_HOME), 'project'),
      stdin: () => terminal,
      env: () => ({}),
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
  const start = performance.now();
  const done = (code: number): RunResult => ({
    code,
    out,
    err,
    ms: performance.now() - start,
  });
  try {
    await program.parseAsync(args, { from: 'user' });
    return done(0);
  } catch (error) {
    if (error instanceof CommanderError) return done(error.exitCode);
    throw error;
  } finally {
    vi.restoreAllMocks();
  }
}

function event(type: Event['type'], payload: Event['payload']): Event {
  return {
    event_id: randomUUID(),
    type,
    occurred_at: new Date().toISOString(),
    version: '1.0.0',
    payload,
  } as Event;
}

const TASK = { task_id: randomUUID(), task_type: 'lint' };

// Seven events today, three of them tool calls an older CLI logged, which
// status leaves out (VOU-451). The cursor sits after the third, so the
// three after it that are sent are pending.
async function seedMixedLog(): Promise<Event[]> {
  const events = [
    event('session.start', { session_id: 's1' }),
    event('tool.call', { tool: 'Bash', duration_ms: 10, ok: true }),
    event('tool.call', { tool: 'Read', duration_ms: 5, ok: true }),
    event('tool.call', { tool: 'Bash', duration_ms: 9, ok: false }),
    event('task.claimed', TASK),
    event('task.submitted', TASK),
    event('incident', { kind: 'scope' }),
  ];
  for (const e of events) await appendEvent(e);
  await writeCursor({
    v: 1,
    lastAcked: {
      file: `${dayOf(new Date())}.jsonl`,
      eventId: events[2]?.event_id ?? '',
    },
    lastSyncAt: LAST_SYNC,
  });
  return events;
}

describe('status', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-status-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    // Never the real ~/.claude.
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'alice',
        name: 'scout',
        version: '1.0.0',
        apiUrl: API_URL,
        registeredAt: '2026-09-23T08:00:00Z',
      },
      paths(home),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    terminal = { isTTY: false, readLine: async () => null };
    await rm(home, { recursive: true, force: true });
  });

  describe('the one time runtime question', () => {
    // The agent route answers with runtime unknown, and every PATCH is
    // kept.
    function unknownRuntime(
      patches: string[],
      reads: string[] = [],
    ): typeof fetch {
      const base = scoreFetch([]);
      return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === `${API_URL}/v1/agents/${AGENT_ID}`) {
          if (init?.method === 'PATCH') patches.push(String(init.body));
          else reads.push(url);
          return Response.json({ ...agentAnswer(2), runtime: 'unknown' });
        }
        return base(input, init);
      }) as typeof fetch;
    }

    it('asks on a terminal once, sends the PATCH, and never again', async () => {
      await createKey({}, paths(home));
      const patches: string[] = [];
      terminal = { isTTY: true, readLine: async () => '2' };
      const reads: string[] = [];
      const result = await run(unknownRuntime(patches, reads), 'status');
      expect(result.code).toBe(0);
      expect(result.err).toContain(RUNTIME_UNKNOWN_INTRO);
      // The agent read status makes anyway answers the question too.
      expect(reads).toHaveLength(1);
      expect(result.out).toContain('Runtime set to Codex\n');
      expect(patches).toHaveLength(1);
      expect(await wasAskedRuntime(AGENT_ID, paths(home))).toBe(true);

      const again = await run(unknownRuntime(patches), 'status');
      expect(again.err).not.toContain(RUNTIME_UNKNOWN_INTRO);
      expect(patches).toHaveLength(1);
    });

    it('asks nothing with --json or without a terminal', async () => {
      const patches: string[] = [];
      terminal = { isTTY: true, readLine: async () => '2' };
      const json = await run(unknownRuntime(patches), 'status', '--json');
      expect(json.err).not.toContain(RUNTIME_UNKNOWN_INTRO);
      terminal = { isTTY: false, readLine: async () => '2' };
      const piped = await run(unknownRuntime(patches), 'status');
      expect(piped.err).not.toContain(RUNTIME_UNKNOWN_INTRO);
      expect(patches).toEqual([]);
      expect(await wasAskedRuntime(AGENT_ID, paths(home))).toBe(false);
    });
  });

  describe('the operator slug (VOU-187)', () => {
    // The agent route answers with the slug alice-2, as for an operator
    // whose login was taken as a slug at backfill.
    const suffixed = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === `${API_URL}/v1/agents/${AGENT_ID}`) {
        return Response.json({
          ...agentAnswer(2),
          operator: { login: 'alice', slug: 'alice-2', displayName: 'Alice' },
          handle: 'alice-2/scout',
        });
      }
      return scoreFetch([])(input, init);
    }) as typeof fetch;

    it('builds the handle from the slug, stores it and keeps it offline', async () => {
      const online = await run(suffixed, 'status', '--json');
      expect(JSON.parse(online.out)).toMatchObject({
        handle: 'alice-2/scout',
        profileUrl: 'https://sealkeeper.run/agents/alice-2/scout',
      });
      expect(await readOperatorSlug(AGENT_ID, paths(home))).toBe('alice-2');

      const offlineRun = await run(offline, 'status');
      expect(offlineRun.out.split('\n')).toContain(
        'handle            alice-2/scout',
      );
      expect(offlineRun.out).toContain(
        'https://sealkeeper.run/agents/alice-2/scout',
      );
    });

    it('falls back to the login offline when no slug is stored', async () => {
      const result = await run(offline, 'status');
      expect(result.out.split('\n')).toContain('handle            alice/scout');
      expect(await readOperatorSlug(AGENT_ID, paths(home))).toBeNull();
    });
  });

  it('prints counts, pending, last sync and scores with null as a dash', async () => {
    await seedMixedLog();
    const fetchFn = scoreFetch([
      { dimension: 'reliability', value: 0.8234 },
      { dimension: 'safety', value: null },
      {
        dimension: 'competence:data',
        value: 0.5,
        types: [
          { taskType: 'csv_normalise', value: 1 },
          { taskType: 'json_extract', value: 0.25 },
        ],
      },
      { dimension: 'competence:code', value: 0.75 },
      // Competence by task type, from an API before RT-3, is not shown.
      { dimension: 'competence:lint', value: 0.9 },
    ]);
    const { code, out, err } = await run(fetchFn, 'status');
    expect(code).toBe(0);
    expect(err).toBe('');
    const lines = out.split('\n');
    expect(lines).toContain(`agent             ${AGENT_ID}`);
    expect(lines).toContain('handle            alice/scout');
    expect(lines).toContain(
      'profile           https://sealkeeper.run/agents/alice/scout',
    );
    expect(lines).toContain(`today             ${dayOf(new Date())} UTC`);
    expect(lines).toContain('  session.start   1');
    expect(lines).toContain('  task.claimed    1');
    expect(lines).toContain('  task.submitted  1');
    expect(lines).toContain('  incident        1');
    expect(lines).toContain('  usage           0');
    expect(out).not.toContain('tool.call');
    expect(out).not.toContain('tool calls');
    expect(lines).toContain('tasks             1 claimed, 1 submitted');
    expect(lines).toContain('verified tasks    2');
    expect(out).toMatch(
      /\nNext scoring run in about ([1-9]|1[0-5]) minutes?\n/,
    );
    expect(out).not.toContain('not submitted yet');
    expect(lines).toContain('pending           3');
    expect(lines).toContain(`last sync         ${LAST_SYNC}`);
    expect(lines).toContain(
      'auto-sync         off, run npx sealkeeper sync to review and send',
    );
    expect(out).not.toContain('"event_id"');
    expect(lines).toContain('  reliability     0.82');
    expect(lines).toContain('  safety          -');
    expect(lines).toContain('  cost_latency    -');
    expect(lines).toContain('  provenance      -');
    // Categories in category order, each task type one step further in.
    const at = lines.indexOf('  provenance      -');
    expect(lines.slice(at + 1, at + 5)).toEqual([
      '  competence:code 0.75',
      '  competence:data 0.50',
      '    csv_normalise 1',
      '    json_extract  0.25',
    ]);
    expect(out).not.toContain('competence:lint');
  });

  it('counts a line written twice once, as the API keeps one of them', async () => {
    const start = event('session.start', { session_id: 's1' });
    const claimed = event('task.claimed', TASK);
    for (const e of [start, claimed, start, claimed, claimed]) {
      await appendEvent(e);
    }
    const json = JSON.parse(
      (await run(offline, 'status', '--show', '--json')).out,
    );
    expect(json.counts['session.start']).toBe(1);
    expect(json.counts['task.claimed']).toBe(1);
    expect(json.tasks).toEqual({ claimed: 1, submitted: 0 });
    expect(json.events).toEqual([start, claimed]);
  });

  it('names the new API address once when the API answers a redirect', async () => {
    const moved = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(null, {
        status: 301,
        headers: { Location: `https://api.sealkeeper.run${url.pathname}` },
      });
    }) as typeof fetch;
    const { code, out, err } = await run(moved, 'status');
    expect(code).toBe(0);
    expect(out).toContain('verified tasks    -\n');
    const line = `the API at ${API_URL} moved to https://api.sealkeeper.run, set apiUrl in ${join(home, 'config.json')} to it`;
    expect(err.split(line)).toHaveLength(2);
  });

  it('still exits 0 quickly when offline, with every score a dash', async () => {
    await seedMixedLog();
    const { code, out, ms } = await run(offline, 'status');
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1000);
    expect(out).toContain('pending           3\n');
    expect(out).toContain('  reliability     -\n');
    expect(out).toContain('  provenance      -\n');
    expect(out).toContain('verified tasks    -\n');
  });

  describe('verified tasks and scoring', () => {
    async function claimOnly(): Promise<string> {
      const id = randomUUID();
      await appendEvent(
        event('task.claimed', { task_id: id, task_type: 'json_extract' }),
      );
      return id;
    }

    it('puts the next scoring run on the wall clock quarter hours', () => {
      const at = (iso: string) => minutesToNextScoring(new Date(iso));
      expect(at('2026-09-23T10:00:00.000Z')).toBe(15);
      expect(at('2026-09-23T10:00:01.000Z')).toBe(15);
      expect(at('2026-09-23T10:01:00.000Z')).toBe(14);
      expect(at('2026-09-23T10:14:30.000Z')).toBe(1);
      expect(at('2026-09-23T10:44:59.999Z')).toBe(1);
      expect(at('2026-09-23T10:46:00.000Z')).toBe(14);
      expect(nextScoringLine(1)).toBe('Next scoring run in about 1 minute');
      expect(nextScoringLine(9)).toBe('Next scoring run in about 9 minutes');
    });

    it('hints at unsubmitted claims while nothing is verified', async () => {
      await claimOnly();
      await claimOnly();
      const { code, out } = await run(scoreFetch([], 0), 'status');
      expect(code).toBe(0);
      expect(out).toContain('verified tasks    0\n');
      expect(out).toContain(
        '2 claimed tasks are not submitted yet. Run npx sealkeeper prove --claim to list them again.\n',
      );
      const json = JSON.parse(
        (await run(scoreFetch([], 0), 'status', '--json')).out,
      );
      expect(json).toMatchObject({ verifiedTasks: 0, unsubmittedClaims: 2 });
    });

    it('counts a claim as done once it is submitted, even days later', async () => {
      const id = randomUUID();
      await appendEvent(
        event('task.claimed', { task_id: id, task_type: 'json_extract' }),
        paths(home),
        new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      );
      await appendEvent(
        event('task.submitted', { task_id: id, task_type: 'json_extract' }),
      );
      const { out } = await run(scoreFetch([], 0), 'status');
      expect(out).not.toContain('not submitted yet');
    });

    it('drops the hint once a task is verified, or when the count is unknown', async () => {
      await claimOnly();
      expect((await run(scoreFetch([], 1), 'status')).out).not.toContain(
        'not submitted yet',
      );
      expect((await run(offline, 'status')).out).not.toContain(
        'not submitted yet',
      );
    });

    it('counts claims and today in the newest day file after a clock rollback', async () => {
      // A claim logged while the clock ran two days ahead names a day file
      // still to come. The claim after the rollback lands there too.
      const ahead = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      await appendEvent(
        event('task.claimed', { task_id: randomUUID(), task_type: 'lint' }),
        paths(home),
        ahead,
      );
      await claimOnly();
      const json = JSON.parse(
        (await run(scoreFetch([], 0), 'status', '--json')).out,
      );
      expect(json).toMatchObject({ unsubmittedClaims: 2 });
      expect(json.counts['task.claimed']).toBe(2);
    });

    it('uses one line for a single unsubmitted claim', async () => {
      await claimOnly();
      expect((await run(scoreFetch([], 0), 'status')).out).toContain(
        '1 claimed task is not submitted yet. Run npx sealkeeper prove --claim to list it again.\n',
      );
    });
  });

  describe('level and dormancy', () => {
    it('prints the level and the next rung when dormant', async () => {
      const { code, out } = await run(
        scoreFetch([], 30, { level: 'bronze', dormantDays: 16 }),
        'status',
      );
      expect(code).toBe(0);
      const lines = out.split('\n');
      expect(lines).toContain('level             bronze');
      expect(lines).toContain('dormant           16 days');
      expect(lines).toContain(
        'Quiet for 16 days. At 30 days the level drops one step.',
      );
      expect(out).not.toContain('no SEAL');
    });

    it('prints no dormant row or line when active today', async () => {
      const { out } = await run(
        scoreFetch([], 30, { level: 'none', dormantDays: 0 }),
        'status',
      );
      expect(out).toContain('level             none\n');
      expect(out).not.toContain('dormant');
      expect(out).not.toContain('Quiet');
    });

    it('prints one goal line from the goal answer', async () => {
      const goal = {
        agentId: AGENT_ID,
        version: '1.0.0',
        level: 'bronze',
        nextLevel: 'silver',
        thresholds: [
          { name: 'verified_tasks', current: 60, required: 250, met: false },
          { name: 'reliability', current: 0.95, required: 0.9, met: true },
          { name: 'safety', current: 0.95, required: 0.9, met: true },
        ],
        actions: [{ code: 'claim_tasks', count: 190 }],
        pending: { addressed: 0, outcomes: 0 },
        asOf: '2026-09-25T10:15:00.000Z',
      };
      const { out } = await run(
        scoreFetch([], 60, { level: 'bronze', goal }),
        'status',
      );
      expect(out).toContain(
        'goal              silver next, 2 of 3 thresholds met, see npx sealkeeper goal\n',
      );
      // Cached for fifteen minutes like the score, so offline it still shows.
      expect((await run(offline, 'status')).out).toContain(
        'goal              silver next, 2 of 3 thresholds met',
      );
      const json = await run(offline, 'status', '--json');
      expect(JSON.parse(json.out).goal).toEqual(goal);
    });

    it("prints today's counted tasks from the goal answer", async () => {
      const goal = {
        agentId: AGENT_ID,
        version: '1.0.0',
        level: 'bronze',
        nextLevel: 'silver',
        thresholds: [],
        actions: [],
        pending: { addressed: 0, outcomes: 0 },
        today: {
          day: new Date().toISOString().slice(0, 10),
          counted: 20,
          ceiling: 20,
          remaining: 0,
        },
        asOf: '2026-09-25T10:15:00.000Z',
      };
      const { out } = await run(
        scoreFetch([], 60, { level: 'bronze', goal }),
        'status',
      );
      expect(out).toContain(
        'Today 20 of 20 counted. More tasks today still verify but will not move your level.\n',
      );
    });

    it('prints a dash for the goal when the API has none and nothing is cached', async () => {
      expect((await run(offline, 'status')).out).toContain(
        'goal              -\n',
      );
    });

    it('prints a dash for the level when the API has none or is offline', async () => {
      expect((await run(scoreFetch([]), 'status')).out).toContain(
        'level             -\n',
      );
      expect((await run(offline, 'status')).out).toContain(
        'level             -\n',
      );
    });

    // VB-4. The agent's current fingerprint states, as the profile shows
    // them, never a part hash.
    it('prints the fingerprint states, none declared, or a dash when unknown', async () => {
      const fingerprint = {
        hash: `${'F'.repeat(42)}A`,
        at: '2026-09-28T08:00:00.000Z',
        parts: {
          model_set: 'declared',
          prompt: 'not_declared',
          tools: 'declared',
          framework: 'unstable',
        },
      };
      const withOne = scoreFetch([], 2, { fingerprint });
      expect((await run(withOne, 'status')).out).toContain(
        'fingerprint       model declared, prompt not declared, tools declared, framework unstable\n',
      );
      expect(
        JSON.parse((await run(withOne, 'status', '--json')).out),
      ).toMatchObject({ fingerprint });

      const none = scoreFetch([], 2, { fingerprint: null });
      expect((await run(none, 'status')).out).toContain(
        'fingerprint       none declared\n',
      );
      expect(
        JSON.parse((await run(none, 'status', '--json')).out),
      ).toMatchObject({ fingerprint: null });

      expect((await run(offline, 'status')).out).toContain(
        'fingerprint       -\n',
      );
      expect(
        JSON.parse((await run(offline, 'status', '--json')).out),
      ).not.toHaveProperty('fingerprint');
      // A state this version does not know reads as unknown, not as a guess.
      const unknown = scoreFetch([], 2, {
        fingerprint: {
          ...fingerprint,
          parts: { ...fingerprint.parts, tools: 'drifting' },
        },
      });
      expect((await run(unknown, 'status')).out).toContain(
        'fingerprint       -\n',
      );
    });

    it('keeps the verified count when the level fails to parse', async () => {
      const json = JSON.parse(
        (
          await run(
            scoreFetch([], 7, { level: 'platinum', dormantDays: 3 }),
            'status',
            '--json',
          )
        ).out,
      );
      expect(json).toMatchObject({
        verifiedTasks: 7,
        level: null,
        dormantDays: 3,
      });
    });

    it('names every rung of the ladder in plain words', () => {
      expect(dormancyLine(null)).toBeNull();
      expect(dormancyLine(0)).toBeNull();
      expect(dormancyLine(1)).toBe(
        'No accepted event for 1 day. At 14 days the agent counts as quiet, with no level change.',
      );
      expect(dormancyLine(13)).toBe(
        'No accepted event for 13 days. At 14 days the agent counts as quiet, with no level change.',
      );
      expect(dormancyLine(14)).toBe(
        'Quiet for 14 days. At 30 days the level drops one step.',
      );
      expect(dormancyLine(30)).toBe(
        'Quiet for 30 days, the level is one step down. At 60 days it drops one more.',
      );
      expect(dormancyLine(60)).toBe(
        'Quiet for 60 days, the level is two steps down. At 90 days the level is none and no SEAL is issued.',
      );
      expect(dormancyLine(89)).toContain('At 90 days');
      expect(dormancyLine(90)).toBe(
        'Quiet for 90 days. No SEAL is issued and the level is none until the next scoring run after a new event.',
      );
    });

    const noSeal = (days: number | null) => () =>
      Response.json(
        {
          error: { code: 'no_seal', message: 'dormant' },
          id: AGENT_ID,
          dormant_days: days,
        },
        { status: 404 },
      );
    const heldSeal = (reason: unknown) => () =>
      Response.json(
        {
          error: { code: 'withheld', message: 'withheld for cause' },
          id: AGENT_ID,
          reason,
        },
        { status: 404 },
      );

    it('says no SEAL at 90 dormant days, when the API withholds it', async () => {
      const { code, out } = await run(
        scoreFetch([], 30, {
          level: 'none',
          dormantDays: 95,
          seal: noSeal(95),
        }),
        'status',
      );
      expect(code).toBe(0);
      const lines = out.split('\n');
      expect(lines).toContain('dormant           95 days');
      expect(lines).toContain(
        'SEAL              no SEAL, withheld while the agent is dormant, 95 days',
      );
      expect(lines).toContain(
        'Quiet for 95 days. No SEAL is issued and the level is none until the next scoring run after a new event.',
      );
      expect(sealWithheld(89)).toBe(false);
      expect(sealWithheld(90)).toBe(true);
      expect(sealWithheld(null)).toBe(false);
    });

    it('names the hold reason class when the SEAL is withheld for cause', async () => {
      for (const reason of ['fraud', 'spam_ring']) {
        const { code, out } = await run(
          scoreFetch([], 30, {
            level: 'bronze',
            dormantDays: 0,
            held: true,
            seal: heldSeal(reason),
          }),
          'status',
        );
        expect(code).toBe(0);
        expect(out.split('\n')).toContain(
          `SEAL              no SEAL, withheld for cause, reason ${reason}`,
        );
      }
      const json = JSON.parse(
        (
          await run(
            scoreFetch([], 30, {
              held: true,
              seal: heldSeal('safety'),
            }),
            'status',
            '--json',
          )
        ).out,
      );
      expect(json).toMatchObject({
        sealWithheld: true,
        withheld: { kind: 'held', reason: 'safety' },
      });
    });

    it('says withheld alone when the SEAL route does not say why', async () => {
      for (const seal of [
        heldSeal('Not A Class'),
        () =>
          Response.json(
            { error: { code: 'x', message: 'x' } },
            { status: 500 },
          ),
        () => {
          throw new TypeError('fetch failed');
        },
      ]) {
        const { out } = await run(
          scoreFetch([], 30, { held: true, seal }),
          'status',
        );
        expect(out.split('\n')).toContainEqual(
          expect.stringMatching(/^SEAL {14}no SEAL, withheld( for cause)?$/),
        );
      }
    });

    it('asks the SEAL route only when the SEAL is withheld', async () => {
      const json = JSON.parse(
        (
          await run(
            scoreFetch([], 30, {
              level: 'bronze',
              dormantDays: 3,
              held: false,
            }),
            'status',
            '--json',
          )
        ).out,
      );
      expect(json).toMatchObject({ sealWithheld: false, withheld: null });
    });
  });

  describe('tasks addressed to the agent', () => {
    it('says how many wait and to run prove, when the API answers', async () => {
      const { code, out } = await run(
        scoreFetch([], 2, { addressed: 2 }),
        'status',
      );
      expect(code).toBe(0);
      expect(out).toContain(
        '\n2 tasks addressed to you, run npx sealkeeper prove\n',
      );
      const one = await run(
        scoreFetch([], 2, { addressed: 1 }),
        'status',
        '--json',
      );
      // The cache from the first run answers, so still 2.
      expect(JSON.parse(one.out).addressedTasks).toBe(2);
    });

    it('says nothing when none wait', async () => {
      const { out } = await run(scoreFetch([], 2), 'status');
      expect(out).not.toContain('addressed to you');
    });

    it('says nothing extra offline and caches nothing', async () => {
      const { code, out, err } = await run(offline, 'status');
      expect(code).toBe(0);
      expect(out).not.toContain('addressed');
      expect(err).not.toContain('addressed');
      const json = await run(offline, 'status', '--json');
      expect(JSON.parse(json.out).addressedTasks).toBeNull();
    });

    it('reads the count from the cache for fifteen minutes, then asks again', async () => {
      const calls: string[] = [];
      const counting = (addressed: number) => {
        const inner = scoreFetch([], 2, { addressed });
        return (async (input: string | URL | Request) => {
          calls.push(String(input));
          return inner(input);
        }) as typeof fetch;
      };
      await run(counting(3), 'status');
      const asked = () => calls.filter((c) => c.includes('/v1/tasks?')).length;
      expect(asked()).toBe(1);
      const cached = await run(counting(1), 'status');
      expect(asked()).toBe(1);
      expect(cached.out).toContain('3 tasks addressed to you');

      // Sixteen minutes on, the cache is stale and the API is asked.
      const later = Date.now() + 16 * 60_000;
      vi.useFakeTimers({ now: later, toFake: ['Date'] });
      try {
        const fresh = await run(counting(1), 'status');
        expect(asked()).toBe(2);
        expect(fresh.out).toContain('\n1 task addressed to you, run');
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores a cache written for another agent', async () => {
      await writeFile(
        paths(home).inbox,
        `${JSON.stringify({
          v: 1,
          agentId: `${'B'.repeat(42)}A`,
          fetchedAt: new Date().toISOString(),
          count: 9,
        })}\n`,
      );
      const { out } = await run(scoreFetch([], 2, { addressed: 1 }), 'status');
      expect(out).toContain('\n1 task addressed to you, run');
      expect(out).not.toContain('9 tasks');
      const offlineRun = await run(offline, 'status', '--json');
      // The cache now belongs to this agent and is fresh.
      expect(JSON.parse(offlineRun.out).addressedTasks).toBe(1);
    });

    it('drops a stale cache when the API does not answer', async () => {
      await run(scoreFetch([], 2, { addressed: 2 }), 'status');
      const later = Date.now() + 16 * 60_000;
      vi.useFakeTimers({ now: later, toFake: ['Date'] });
      try {
        const { out } = await run(offline, 'status');
        expect(out).not.toContain('addressed to you');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('prints one JSON object with --json', async () => {
    await seedMixedLog();
    const { code, out } = await run(
      scoreFetch([{ dimension: 'reliability', value: 0.9 }]),
      'status',
      '--json',
    );
    expect(code).toBe(0);
    const status = JSON.parse(out);
    expect(status).toEqual({
      agentId: AGENT_ID,
      handle: 'alice/scout',
      profileUrl: 'https://sealkeeper.run/agents/alice/scout',
      day: dayOf(new Date()),
      counts: {
        'session.start': 1,
        'session.end': 0,
        'task.claimed': 1,
        'task.submitted': 1,
        'task.outcome': 0,
        incident: 1,
        usage: 0,
      },
      tasks: { claimed: 1, submitted: 1 },
      verifiedTasks: 2,
      level: null,
      dormantDays: null,
      sealWithheld: false,
      withheld: null,
      goal: null,
      unsubmittedClaims: 0,
      addressedTasks: 0,
      nextScoringRunMinutes: expect.any(Number),
      pending: 3,
      lastSyncAt: LAST_SYNC,
      autoSync: false,
      scores: {
        reliability: 0.9,
        safety: null,
        cost_latency: null,
        provenance: null,
      },
      competenceTypes: {},
      scoresFetchedAt: expect.any(String),
    });
  });

  it('prints zeros and never when there is no log directory', async () => {
    const { code, out } = await run(offline, 'status');
    expect(code).toBe(0);
    expect(out).not.toContain('tool.call');
    expect(out).not.toContain('tool calls');
    expect(out).toContain('tasks             0 claimed, 0 submitted\n');
    expect(out).toContain('pending           0\n');
    expect(out).toContain('last sync         never\n');

    const json = JSON.parse((await run(offline, 'status', '--json')).out);
    expect(json).toMatchObject({
      pending: 0,
      lastSyncAt: null,
      scoresFetchedAt: null,
    });
    expect(json).not.toHaveProperty('toolCalls');
    expect(json.counts).toEqual({
      'session.start': 0,
      'session.end': 0,
      'task.claimed': 0,
      'task.submitted': 0,
      'task.outcome': 0,
      incident: 0,
      usage: 0,
    });
  });

  it("--show lists today's events in full after the counts", async () => {
    const events = await seedMixedLog();
    const { code, out } = await run(offline, 'status', '--show');
    expect(code).toBe(0);
    const lines = out.split('\n');
    const header = lines.indexOf("today's events, 4, as they are sent");
    expect(header).toBeGreaterThan(lines.indexOf('  usage           0'));
    expect(lines.slice(header + 1, header + 5)).toEqual(
      events
        .filter((e) => e.type !== 'tool.call')
        .map((e) => JSON.stringify(e)),
    );
  });

  it('--show --json adds the events to the object', async () => {
    const events = await seedMixedLog();
    const { out } = await run(offline, 'status', '--show', '--json');
    expect(JSON.parse(out).events).toEqual(
      events.filter((e) => e.type !== 'tool.call'),
    );
  });

  it('shows auto-sync on once it is on', async () => {
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'alice',
        name: 'scout',
        version: '1.0.0',
        apiUrl: API_URL,
        registeredAt: '2026-09-23T08:00:00Z',
        autoSync: true,
      },
      paths(home),
    );
    const { out } = await run(offline, 'status');
    expect(out).toContain('auto-sync         on\n');
  });

  it('exits 1 with the init hint when there is no config', async () => {
    await rm(paths(home).config);
    const { code, out, err } = await run(offline, 'status');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('not initialised, run npx sealkeeper init\n');
  });
  describe('adapter warning', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    // The current form, node and a script by absolute path, shaped like a
    // global install and present on disk, so the hook is ours and not gone.
    async function settingsIn(
      dir: string,
      name = 'settings.json',
    ): Promise<void> {
      const scriptDir = join(home, 'lib', 'node_modules', 'sealkeeper', 'dist');
      await mkdir(scriptDir, { recursive: true });
      const script = join(scriptDir, 'index.js');
      await writeFile(script, '');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, name),
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: hookCommand(process.execPath, script),
                  },
                ],
              },
            ],
          },
        }),
      );
    }

    async function eventDaysAgo(days: number): Promise<void> {
      await appendEvent(
        event('session.start', { session_id: 's1' }),
        paths(home),
        new Date(Date.now() - days * DAY_MS),
      );
    }

    it('warns once on stderr with no hooks and nothing in 7 days', async () => {
      expect(NO_ADAPTER).toBe(
        'No adapter installed and nothing recorded in 7 days. Run npx sealkeeper adapter claude-code install.',
      );
      await eventDaysAgo(8);
      const { code, out, err } = await run(offline, 'status');
      expect(code).toBe(0);
      expect(err).toBe(`${NO_ADAPTER}\n`);
      expect(out).not.toContain(NO_ADAPTER);
      expect(out).toContain('pending ');
    });

    it('keeps --json output one object and still warns on stderr', async () => {
      const { out, err } = await run(offline, 'status', '--json');
      expect(JSON.parse(out)).toMatchObject({ pending: 0 });
      expect(err).toBe(`${NO_ADAPTER}\n`);
    });

    it('does not warn when the user settings hold the hooks', async () => {
      await settingsIn(join(home, 'claude'));
      expect((await run(offline, 'status')).err).toBe('');
    });

    it('does not warn when the project settings hold the hooks', async () => {
      await settingsIn(join(home, 'project', '.claude'));
      expect((await run(offline, 'status')).err).toBe('');
    });

    it('does not warn when the local project settings hold the hooks', async () => {
      await settingsIn(join(home, 'project', '.claude'), 'settings.local.json');
      expect((await run(offline, 'status')).err).toBe('');
    });

    it('does not warn when something was recorded in the last 7 days', async () => {
      await eventDaysAgo(6);
      expect((await run(offline, 'status')).err).toBe('');
    });
  });

  // VOU-451. The hooks record sessions only. An install before 0.4.14 also
  // wrote PreToolUse, PostToolUse and PostToolUseFailure, which record
  // nothing now.
  describe('tool call hooks an older install left', () => {
    async function writeHooks(file: string, events: string[]): Promise<void> {
      const scriptDir = join(home, 'lib', 'node_modules', 'sealkeeper', 'dist');
      await mkdir(scriptDir, { recursive: true });
      const script = join(scriptDir, 'index.js');
      await writeFile(script, '');
      const ours = [
        {
          hooks: [
            { type: 'command', command: hookCommand(process.execPath, script) },
          ],
        },
      ];
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          hooks: Object.fromEntries(events.map((event) => [event, ours])),
        }),
      );
    }
    const THREE = ['SessionStart', 'SessionEnd', 'Stop'];
    const SIX = [...THREE, 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

    it('reads three hooks as complete and says nothing', async () => {
      await writeHooks(join(home, 'claude', 'settings.json'), THREE);
      expect((await run(offline, 'status')).err).toBe('');
    });

    it('says in one line on stderr to run the install again', async () => {
      await writeHooks(join(home, 'claude', 'settings.json'), SIX);
      const { code, out, err } = await run(offline, 'status', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ pending: 0 });
      expect(TOOL_HOOKS_LEFT).toBe(
        'The Claude Code settings still hold the tool call hooks of an older sealkeeper, which record nothing now. Run npx sealkeeper adapter claude-code install again to remove them, with --scope project for a project install.',
      );
      expect(err).toBe(`${TOOL_HOOKS_LEFT}\n`);
    });

    it('finds them in the project settings too', async () => {
      await writeHooks(
        join(home, 'project', '.claude', 'settings.local.json'),
        SIX,
      );
      expect((await run(offline, 'status')).err).toBe(`${TOOL_HOOKS_LEFT}\n`);
    });
  });

  describe('hooks that point at a sealkeeper that is gone', () => {
    function settings(command: string): string {
      return JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] },
      });
    }

    async function writeSettings(dir: string, command: string): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'settings.json'), settings(command));
    }

    // A script shaped like an npx copy, which exists until removed.
    async function npxScript(): Promise<string> {
      const dir = join(
        home,
        '.npm',
        '_npx',
        'abc123',
        'node_modules',
        'sealkeeper',
        'dist',
      );
      await mkdir(dir, { recursive: true });
      const script = join(dir, 'index.js');
      await writeFile(script, '');
      return script;
    }

    it('warns on stderr when the user settings script is gone', async () => {
      const script = await npxScript();
      await writeSettings(
        join(home, 'claude'),
        hookCommand(process.execPath, script),
      );
      expect((await run(offline, 'status')).err).toBe('');

      await rm(join(home, '.npm'), { recursive: true });
      const { code, out, err } = await run(offline, 'status');
      expect(code).toBe(0);
      expect(HOOKS_MISSING).toBe(
        'The Claude Code hooks point at a sealkeeper that is no longer there. Run npx sealkeeper adapter claude-code install again, or npm i -g sealkeeper for a stable path.',
      );
      expect(err).toBe(`${HOOKS_MISSING}\n`);
      expect(out).not.toContain(HOOKS_MISSING);
    });

    it('warns for the project settings too, and with --json', async () => {
      await writeSettings(
        join(home, 'project', '.claude'),
        hookCommand(process.execPath, '/no/such/sealkeeper/dist/index.js'),
      );
      const { out, err } = await run(offline, 'status', '--json');
      expect(JSON.parse(out)).toMatchObject({ pending: 0 });
      expect(err).toBe(`${HOOKS_MISSING}\n`);
    });
  });

  describe("the daily job's copy of the CLI (RS-2)", () => {
    // A job as routine install records it, running the copy in the home.
    async function installed(version: string): Promise<void> {
      const c = copyPaths(paths());
      await writeFile(join(home, 'bundle.js'), '// bundle\n');
      await writeCopy(join(home, 'bundle.js'), paths(), version);
      await writeRoutineConfig({
        ...defaultRoutineConfig(),
        schedule: {
          time: '10:00',
          scheduler: 'cron',
          agent: 'claude-code',
          agentCommand: '/usr/local/bin/claude',
          job: 'run.sealkeeper.routine',
          files: [],
          installedAt: new Date().toISOString(),
          program: [process.execPath, c.script, 'routine', 'run'],
        },
      });
    }

    it('says nothing when the copy is this version', async () => {
      await installed(VERSION);
      expect((await run(offline, 'status')).err).not.toContain('Routine');
    });

    it('says on stderr when the copy is another version', async () => {
      await installed('0.0.1');
      const { code, out, err } = await run(offline, 'status');
      expect(code).toBe(0);
      const line = `Routine runs 0.0.1, this CLI is ${VERSION}, run npx sealkeeper routine install to update it.`;
      expect(err).toContain(`${line}\n`);
      expect(out).not.toContain(line);
    });

    it('warns when the copy or the node the job runs is gone', async () => {
      await installed(VERSION);
      await rm(copyPaths(paths()).script);
      const gone = await run(offline, 'status', '--json');
      expect(gone.err).toContain(
        'The daily routine job points at a sealkeeper that is no longer there. Run npx sealkeeper routine install again.\n',
      );

      await installed(VERSION);
      const routine = await readRoutineConfig();
      await writeRoutineConfig({
        ...routine,
        schedule: {
          ...(routine.schedule as NonNullable<typeof routine.schedule>),
          program: [
            '/no/such/node',
            copyPaths(paths()).script,
            'routine',
            'run',
          ],
        },
      });
      expect((await run(offline, 'status')).err).toContain(
        'points at a sealkeeper that is no longer there',
      );
    });

    it('says nothing for a job an earlier CLI installed, which recorded no command', async () => {
      await installed('0.0.1');
      const routine = await readRoutineConfig();
      const { program: _, ...earlier } = routine.schedule ?? {};
      await writeFile(
        paths().routine,
        `${JSON.stringify({ ...routine, schedule: earlier })}\n`,
      );
      expect((await run(offline, 'status')).err).not.toContain('Routine');
    });
  });
});
