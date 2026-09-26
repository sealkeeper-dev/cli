// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { goalActionText, loadGoal } from '../goal.js';
import { resetInvocation } from '../invocation.js';
import { COUNTED_RULE } from '../ladder.js';
import { createProgram } from '../program.js';

const API_URL = 'https://api.test';
// The UTC day of the test run, so the answers' today is current.
const TODAY = new Date().toISOString().slice(0, 10);
const AGENT_ID = `${'A'.repeat(42)}A`;

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

const answer = (over: Record<string, unknown>) => ({
  agentId: AGENT_ID,
  version: '1.0.0',
  pending: { addressed: 0, outcomes: 0 },
  asOf: '2026-09-25T10:15:00.000Z',
  ...over,
});

// Goals at none, bronze and silver as the API answers them.
const AT_NONE = answer({
  level: 'none',
  nextLevel: 'bronze',
  // 20 verified tasks that count 13 (VOU-139).
  thresholds: [
    {
      name: 'verified_tasks',
      current: 13,
      required: 25,
      met: false,
      raw: 20,
    },
    {
      name: 'history_days',
      current: 2,
      required: 3,
      met: false,
      raw: null,
    },
    { name: 'reliability', current: 0.85, required: 0.8, met: true, raw: null },
    {
      name: 'safety_incidents_90d',
      current: 0,
      required: 0,
      met: true,
      raw: null,
    },
  ],
  actions: [
    { code: 'claim_seed_tasks', count: 12 },
    { code: 'history_days', count: 1 },
  ],
  today: { day: TODAY, counted: 14, ceiling: 20, remaining: 6 },
});

const AT_BRONZE = answer({
  level: 'bronze',
  nextLevel: 'silver',
  thresholds: [
    { name: 'verified_tasks', current: 60, required: 250, met: false },
    { name: 'distinct_operators', current: 2, required: 5, met: false },
    { name: 'provenance', current: 0.9, required: 0.8, met: true },
  ],
  actions: [
    { code: 'confirm_outcomes', count: 1 },
    { code: 'addressed_waiting', count: 2 },
    { code: 'claim_tasks', count: 190 },
    { code: 'need_operators', count: 3 },
  ],
  pending: { addressed: 2, outcomes: 1 },
});

const AT_SILVER = answer({
  level: 'silver',
  nextLevel: 'gold',
  thresholds: [
    { name: 'confirmed_tasks', current: 200, required: 500, met: false },
    { name: 'operator_verified', current: 0, required: 1, met: false },
  ],
  actions: [
    { code: 'counterparty_tasks', count: 300 },
    { code: 'operator_unverified', count: null },
  ],
  // A field a newer API sends.
  today: { counted: 14, remaining: 6 },
});

describe('sealkeeper goal', () => {
  let home: string;
  let requests: string[];

  const serve = (body: unknown, status = 200) =>
    (async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json(body, { status });
    }) as typeof fetch;

  async function run(fetchFn: typeof fetch, ...args: string[]) {
    const program = createProgram({ tasks: { fetch: fetchFn } });
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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-goal-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    vi.stubEnv('SEALKEEPER_INVOCATION', '');
    resetInvocation();
    requests = [];
    await writeConfig({
      agentId: AGENT_ID,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: '2026-09-23T08:00:00.000Z',
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetInvocation();
    await rm(home, { recursive: true, force: true });
  });

  it('prints the thresholds and the next steps at none', async () => {
    const { code, out, err } = await run(serve(AT_NONE), 'goal');
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(requests).toEqual([`${API_URL}/v1/agents/${AGENT_ID}/goal`]);
    expect(out).toBe(
      [
        'SealKeeper goal   alice/scout',
        '',
        'Level none. Next bronze.',
        '',
        '  threshold              current       raw  required  met',
        '  verified_tasks              13        20        25  no',
        '  history_days                 2                   3  no',
        '  reliability               0.85                0.80  yes',
        '  safety_incidents_90d         0                   0  yes',
        '',
        'Today 14 of 20 counted.',
        COUNTED_RULE,
        '',
        'Next',
        '  Claim 12 more seed tasks. npx sealkeeper prove',
        '  Stay active on 1 more day. Levels need a record over time.',
        '',
        'As of the scoring run at 2026-09-25T10:15:00.000Z.',
        '',
      ].join('\n'),
    );
  });

  it('prints what waits and other operators work at bronze', async () => {
    const { code, out } = await run(serve(AT_BRONZE), 'goal');
    expect(code).toBe(0);
    expect(out).toContain('Level bronze. Next silver.\n');
    expect(out).toContain(
      [
        'Next',
        '  Report the outcome of 1 counterparty task waiting on this agent. npx sealkeeper tasks outcome <id> success',
        '  2 tasks are addressed to this agent. Their specs come from other operators, read them first. npx sealkeeper prove --addressed',
        "  Verify 190 more tasks posted by other operators' agents. npx sealkeeper prove --any-poster",
        '  Do tasks for 3 more operators besides your own. npx sealkeeper prove --any-poster',
        '',
        'Waiting 2 addressed tasks, 1 outcome to report.',
      ].join('\n'),
    );
    expect(out).not.toContain('seed');
  });

  it('prints the gold gap at silver, and a bare command when on PATH', async () => {
    vi.stubEnv('SEALKEEPER_INVOCATION', 'sealkeeper');
    resetInvocation();
    const { code, out } = await run(serve(AT_SILVER), 'goal');
    expect(code).toBe(0);
    expect(out).toContain('Level silver. Next gold.\n');
    expect(out).toContain(
      '  operator_verified         0                   1  no\n',
    );
    // A today this CLI cannot read is left out.
    expect(out).not.toContain('Today');
    expect(out).toContain(
      '  Get 300 more counterparty tasks confirmed by other operators. sealkeeper prove --any-poster\n',
    );
    expect(out).toContain(
      '  Needs a verified operator identity, which is not open yet.\n',
    );
  });

  it('prints the API answer as it came with --json', async () => {
    for (const goal of [AT_NONE, AT_BRONZE, AT_SILVER]) {
      const { code, out } = await run(serve(goal), 'goal', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual(goal);
      expect(out.trim().split('\n')).toHaveLength(1);
    }
  });

  it('reads a level it does not know and a count that is not whole, and shows neither', async () => {
    const newer = answer({
      level: 'platinum',
      nextLevel: 'diamond\u001b[2J',
      thresholds: [],
      actions: [{ code: 'claim_tasks', count: 2.5 }],
      pending: { addressed: 0, outcomes: 0, posterOutcomes: 1 },
    });
    const { code, out, err } = await run(serve(newer), 'goal');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('Level unknown. Next unknown.');
    expect(out).not.toContain('platinum');
    expect(out).toContain(
      "Verify more tasks posted by other operators' agents.",
    );
  });

  it('says the goal needs the API and exits 2 offline', async () => {
    const { code, out, err } = await run(offline, 'goal');
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('the goal needs the SealKeeper API');
    // No cache stands in for the API.
    await writeFile(
      join(home, 'goal.json'),
      JSON.stringify({
        v: 1,
        fetchedAt: new Date().toISOString(),
        goal: AT_NONE,
      }),
    );
    expect((await run(offline, 'goal', '--json')).code).toBe(2);
  });

  it('exits 2 with the API message on an error answer', async () => {
    const { code, err } = await run(
      serve({ error: { code: 'not_found', message: 'Agent not found' } }, 404),
      'goal',
    );
    expect(code).toBe(2);
    expect(err).toContain('Agent not found');
  });

  it('exits 2 without a config, like every agent command', async () => {
    await rm(join(home, 'config.json'));
    expect((await run(serve(AT_NONE), 'goal')).code).not.toBe(0);
  });

  it('caches the answer for status and prove', async () => {
    await run(serve(AT_BRONZE), 'goal');
    const cache = JSON.parse(await readFile(join(home, 'goal.json'), 'utf8'));
    expect(cache.goal).toEqual(AT_BRONZE);
  });
});

describe('loadGoal', () => {
  let home: string;
  const config = { agentId: AGENT_ID, apiUrl: API_URL, version: '1.0.0' };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-goal-load-'));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('reads the API once and the cache for fifteen minutes', async () => {
    const p = paths(home);
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return Response.json(AT_NONE);
    }) as typeof fetch;
    const now = new Date('2026-09-25T10:00:00.000Z');
    expect(await loadGoal({ config, fetch: fetchFn, now, paths: p })).toEqual(
      AT_NONE,
    );
    const later = new Date(now.getTime() + 14 * 60_000);
    expect(
      await loadGoal({ config, fetch: fetchFn, now: later, paths: p }),
    ).toEqual(AT_NONE);
    expect(calls).toBe(1);
    const stale = new Date(now.getTime() + 16 * 60_000);
    await loadGoal({ config, fetch: fetchFn, now: stale, paths: p });
    expect(calls).toBe(2);
  });

  it('never touches the network with cachedOnly', async () => {
    const p = paths(home);
    const fetchFn = vi.fn(async () => Response.json(AT_NONE));
    const now = new Date('2026-09-25T10:00:00.000Z');
    expect(
      await loadGoal({
        cachedOnly: true,
        config,
        fetch: fetchFn as unknown as typeof fetch,
        now,
        paths: p,
      }),
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    await loadGoal({
      config,
      fetch: fetchFn as unknown as typeof fetch,
      now,
      paths: p,
    });
    expect(await loadGoal({ cachedOnly: true, config, now, paths: p })).toEqual(
      AT_NONE,
    );
    // Stale is no answer when only the cache may be read.
    const stale = new Date(now.getTime() + 16 * 60_000);
    expect(
      await loadGoal({ cachedOnly: true, config, now: stale, paths: p }),
    ).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cache offline and ignores another version', async () => {
    const p = paths(home);
    const now = new Date('2026-09-25T10:00:00.000Z');
    await loadGoal({
      config,
      fetch: (async () => Response.json(AT_NONE)) as typeof fetch,
      now,
      paths: p,
    });
    const stale = new Date(now.getTime() + 60 * 60_000);
    expect(
      await loadGoal({ config, fetch: offline, now: stale, paths: p }),
    ).toEqual(AT_NONE);
    expect(
      await loadGoal({
        config: { ...config, version: '2.0.0' },
        fetch: offline,
        now,
        paths: p,
      }),
    ).toBeNull();
  });

  it('is null without a config', async () => {
    expect(await loadGoal({ fetch: offline, paths: paths(home) })).toBeNull();
  });
});

describe('goalActionText', () => {
  beforeEach(() => {
    vi.stubEnv('SEALKEEPER_INVOCATION', 'sealkeeper');
    resetInvocation();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetInvocation();
  });

  it('says a step in plain words with its command', () => {
    expect(goalActionText({ code: 'claim_seed_tasks', count: 12 })).toEqual({
      text: 'Claim 12 more seed tasks.',
      command: 'sealkeeper prove',
    });
    expect(goalActionText({ code: 'claim_seed_tasks', count: 1 }).text).toBe(
      'Claim 1 more seed task.',
    );
    expect(goalActionText({ code: 'dormant', count: 40 })).toEqual({
      text: 'No accepted event for 40 days, so the level has dropped. Send events again.',
      command: 'sealkeeper sync',
    });
  });

  it('says something for a code it does not know', () => {
    expect(goalActionText({ code: 'rate_peers', count: 3 })).toEqual({
      text: 'Next step rate_peers, 3.',
      command: null,
    });
    expect(goalActionText({ code: 'rate_peers', count: null }).text).toBe(
      'Next step rate_peers.',
    );
  });

  it('says what a report as poster is for', () => {
    expect(goalActionText({ code: 'report_as_poster', count: 2 })).toEqual({
      text: 'Report the outcome of 2 tasks this agent posted. It helps the other agent, not this one.',
      command: 'sealkeeper tasks outcome <id> success',
    });
  });
});
