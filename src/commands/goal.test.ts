// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { goalActionText, goalStepText, loadGoal } from '../goal.js';
import { resetInvocation } from '../invocation.js';
import { COUNTED_RULE, COUNTED_STEPS } from '../ladder.js';
import { saveOperatorSlug } from '../operator-slug.js';
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

// POST-6. 30 taken and 2 posted toward bronze, so posting is the step.
const POSTING_BEHIND = answer({
  level: 'none',
  nextLevel: 'bronze',
  thresholds: [
    { name: 'verified_tasks', current: 30, required: 25, met: true, raw: 34 },
    { name: 'posted_tasks', current: 2, required: 5, met: false, raw: 2 },
    {
      name: 'posted_distinct_operators',
      current: 1,
      required: 1,
      met: true,
      raw: null,
    },
    { name: 'history_days', current: 4, required: 3, met: true, raw: null },
  ],
  taken: { current: 30, required: 25 },
  posted: { current: 2, required: 5 },
  actions: [{ code: 'post_task', count: 3 }],
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

// Gold as an API with the ladder (VOU-184) answers it. nextLevel stays null
// at gold, and platinum is reserved.
const AT_GOLD = answer({
  level: 'gold',
  nextLevel: null,
  ladder: [
    { level: 'none', state: 'reached' },
    { level: 'bronze', state: 'reached' },
    { level: 'silver', state: 'reached' },
    { level: 'gold', state: 'reached' },
    { level: 'platinum', state: 'reserved' },
  ],
  thresholds: [],
  steps: [],
  actions: [],
});

// Silver with every gold count met and no verified operator.
const ONE_STEP_FROM_GOLD = answer({
  level: 'silver',
  nextLevel: 'gold',
  ladder: [
    { level: 'none', state: 'reached' },
    { level: 'bronze', state: 'reached' },
    { level: 'silver', state: 'reached' },
    { level: 'gold', state: 'next' },
    { level: 'platinum', state: 'reserved' },
  ],
  thresholds: [
    {
      name: 'operator_verified',
      current: 0,
      required: 1,
      met: false,
      raw: null,
    },
  ],
  steps: [
    { code: 'operator_verified', done: false, progress: null },
    {
      code: 'confirmed_operators',
      done: true,
      progress: { current: 3, required: 3 },
    },
    {
      code: 'confirmed_tasks',
      done: true,
      progress: { current: 25, required: 25 },
    },
    {
      code: 'clean_days',
      done: true,
      progress: { current: 180, required: 180 },
    },
    {
      code: 'history_days',
      done: true,
      progress: { current: 60, required: 60 },
    },
    {
      code: 'history_span_days',
      done: true,
      progress: { current: 90, required: 90 },
    },
    {
      code: 'verified_tasks',
      done: true,
      progress: { current: 200, required: 200 },
    },
    {
      code: 'reliability',
      done: true,
      progress: { current: 0.97, required: 0.95 },
    },
    { code: 'safety', done: true, progress: { current: 0.96, required: 0.95 } },
  ],
  actions: [{ code: 'operator_unverified', count: null }],
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
        'Ladder  bronze next > silver > gold > platinum coming later',
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
        '  Claim 12 more seed tasks. npx sealkeeper run',
        '  Work on tasks on 1 more day. Only days with a task claimed, submitted, verified, posted or reported on count.',
        '',
        'As of the scoring run at 2026-09-25T10:15:00.000Z.',
        '',
      ].join('\n'),
    );
  });

  // POST-6. Taken and Posted side by side, and post a task first.
  it('prints Taken and Posted side by side and post a task first', async () => {
    const { code, out } = await run(serve(POSTING_BEHIND), 'goal');
    expect(code).toBe(0);
    expect(out).toContain(
      [
        'Level none. Next bronze.',
        'Ladder  bronze next > silver > gold > platinum coming later',
        'Taken 30 of 25   Posted 2 of 5',
        '',
      ].join('\n'),
    );
    expect(out).toContain(
      [
        'Next',
        "  Post 3 more tasks for other operators' agents to complete, every level needs them. Adopt a ready made one in a category, or post a template with npx sealkeeper tasks post --template <id>. npx sealkeeper tasks post --adopt <category>",
      ].join('\n'),
    );
  });

  it('reads Taken and Posted from the thresholds when the API sends no pair', async () => {
    const {
      taken: _,
      posted: __,
      ...older
    } = POSTING_BEHIND as Record<string, unknown>;
    const { code, out } = await run(serve(older), 'goal');
    expect(code).toBe(0);
    expect(out).toContain('Taken 30 of 25   Posted 2 of 5\n');
  });

  // VOU-503. Every level reads Trust Score beside the counted tasks, so it
  // shows beside Taken and Posted, from trustScore or else the trust_score
  // threshold.
  it('prints Trust Score beside Taken and Posted', async () => {
    const trust = answer({
      level: 'none',
      nextLevel: 'bronze',
      thresholds: [
        {
          name: 'verified_tasks',
          current: 8,
          required: 25,
          met: false,
          raw: 9,
        },
        {
          name: 'trust_score',
          current: 30.5,
          required: 50,
          met: false,
          raw: null,
        },
        { name: 'posted_tasks', current: 2, required: 5, met: false, raw: 2 },
      ],
      taken: { current: 8, required: 25 },
      posted: { current: 2, required: 5 },
      trustScore: { current: 30.5, required: 50 },
      actions: [
        { code: 'post_task', count: 3 },
        { code: 'earn_trust', count: 20 },
      ],
    });
    const { code, out } = await run(serve(trust), 'goal');
    expect(code).toBe(0);
    expect(out).toContain(
      'Taken 8 of 25   Posted 2 of 5   Trust Score 30.50 of 50\n',
    );
    expect(out).toContain(
      '  Earn 20 more Trust Score with verified tasks. A harder task earns more. npx sealkeeper run',
    );
    const { trustScore: _, ...older } = trust as Record<string, unknown>;
    const again = await run(serve(older), 'goal');
    expect(again.out).toContain(
      'Taken 8 of 25   Posted 2 of 5   Trust Score 30.50 of 50\n',
    );
  });

  it('names the agent by the stored operator slug', async () => {
    await saveOperatorSlug(AGENT_ID, 'alice-2', new Date(), paths(home));
    const { code, out } = await run(serve(AT_NONE), 'goal');
    expect(code).toBe(0);
    expect(out.split('\n')[0]).toBe('SealKeeper goal   alice-2/scout');
  });

  it('prints what waits and other operators work at bronze', async () => {
    const { code, out } = await run(serve(AT_BRONZE), 'goal');
    expect(code).toBe(0);
    expect(out).toContain('Level bronze. Next silver.\n');
    expect(out).toContain(
      [
        'Next',
        '  Report the outcome of 1 counterparty task waiting on this agent. npx sealkeeper tasks outcome <id> success',
        '  2 tasks are addressed to this agent. Their specs come from other operators, read them first. npx sealkeeper run --addressed',
        "  Verify 190 more tasks posted by other operators' agents. npx sealkeeper run --any-poster",
        '  Do tasks for 3 more operators besides your own. npx sealkeeper run --any-poster',
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
    expect(out).toContain(
      'Level silver. Next gold.\nLadder  bronze reached > silver reached > gold next > platinum coming later\n',
    );
    // An API from before the checklist sends no steps, so the table stays.
    expect(out).toContain(
      '  operator_verified         0                   1  no\n',
    );
    // A today this CLI cannot read is left out.
    expect(out).not.toContain('Today');
    expect(out).toContain(
      '  Get 300 more counterparty tasks confirmed by other operators. sealkeeper run --any-poster\n',
    );
    expect(out).toContain(
      '  Needs a verified operator. Your operator verifies a domain with a DNS TXT record at https://sealkeeper.run/me/account.\n',
    );
  });

  it('at gold says it is the highest level issued today and platinum comes later', async () => {
    const { code, out } = await run(serve(AT_GOLD), 'goal');
    expect(code).toBe(0);
    expect(out).toBe(
      [
        'SealKeeper goal   alice/scout',
        '',
        'Level gold, the highest level issued today.',
        'Ladder  bronze reached > silver reached > gold reached > platinum coming later',
        'Platinum is coming later. The standard names it and SealKeeper does not issue it yet.',
        '',
        'Nothing to do right now.',
        '',
        'As of the scoring run at 2026-09-25T10:15:00.000Z.',
        '',
      ].join('\n'),
    );
    expect(out).not.toContain('top level');
  });

  it('shows platinum as coming later at gold from an API before the ladder', async () => {
    const old = Object.fromEntries(
      Object.entries(AT_GOLD).filter(([k]) => k !== 'ladder' && k !== 'steps'),
    );
    const { out } = await run(serve(old), 'goal');
    expect(out).toContain('Level gold, the highest level issued today.\n');
    expect(out).toContain(
      'Ladder  bronze reached > silver reached > gold reached > platinum coming later\n',
    );
    expect(out).toContain('Platinum is coming later.');
  });

  it('shows the gold checklist and names the one step left', async () => {
    const { code, out } = await run(serve(ONE_STEP_FROM_GOLD), 'goal');
    expect(code).toBe(0);
    expect(out).toContain(
      [
        'Level silver. Next gold.',
        'Ladder  bronze reached > silver reached > gold next > platinum coming later',
        '',
        'Gold checklist',
        '  [ ] Verified operator, a domain checked by DNS TXT',
        '  [x] Other operators behind confirmed tasks, 3 of 3',
        '  [x] Confirmed tasks, no template or routine, 25 of 25',
        '  [x] Safety record, 180 of 180 days',
        '  [x] Active on 60 of 60 days',
        '  [x] Record spans, 90 of 90 days',
        '  [x] Counted verified tasks, 200 of 200',
        '  [x] Reliability, 0.97 of 0.95',
        '  [x] Safety, 0.96 of 0.95',
        '',
        'One step left for gold. Verified operator, a domain checked by DNS TXT.',
        '',
        'Next',
        '  Needs a verified operator. Your operator verifies a domain with a DNS TXT record at https://sealkeeper.run/me/account.',
      ].join('\n'),
    );
    // The checklist stands in for the table.
    expect(out).not.toContain('threshold');
  });

  it('shows the checklist progress while several steps are open', async () => {
    const early = {
      ...ONE_STEP_FROM_GOLD,
      steps: [
        {
          code: 'clean_days',
          done: false,
          progress: { current: 72, required: 180 },
        },
        {
          code: 'history_days',
          done: false,
          progress: { current: 41, required: 60 },
        },
        {
          code: 'posted_distinct_operators',
          done: false,
          progress: { current: 3, required: 5 },
        },
        { code: 'new_rule', done: false, progress: null },
      ],
    };
    const { out } = await run(serve(early), 'goal');
    expect(out).toContain('  [ ] Safety record, 72 of 180 days\n');
    expect(out).toContain('  [ ] Active on 41 of 60 days\n');
    // VOU-516. The operators whose completed posts still count.
    expect(out).toContain(
      '  [ ] Other operators whose completed posts count, 3 of 5\n',
    );
    expect(out).toContain('  [ ] New rule\n');
    expect(out).not.toContain('One step left');
  });

  it('prints the API answer as it came with --json', async () => {
    for (const goal of [
      AT_NONE,
      AT_BRONZE,
      AT_SILVER,
      AT_GOLD,
      ONE_STEP_FROM_GOLD,
    ]) {
      const { code, out } = await run(serve(goal), 'goal', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual(goal);
      expect(out.trim().split('\n')).toHaveLength(1);
    }
  });

  it('reads a level it does not know and a count that is not whole, and shows neither', async () => {
    const newer = answer({
      level: 'diamond',
      nextLevel: 'diamond\u001b[2J',
      thresholds: [],
      // A ladder level and a state this CLI does not know are left out.
      ladder: [
        { level: 'bronze', state: 'reached' },
        { level: 'diamond\u001b[2J', state: 'next' },
        { level: 'gold', state: 'glowing' },
        { level: 'platinum', state: 'reserved' },
      ],
      actions: [{ code: 'claim_tasks', count: 2.5 }],
      pending: { addressed: 0, outcomes: 0, posterOutcomes: 1 },
    });
    const { code, out, err } = await run(serve(newer), 'goal');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('Level unknown. Next unknown.');
    expect(out).toContain('Ladder  bronze reached > platinum coming later\n');
    expect(out).not.toContain('diamond');
    expect(out).not.toContain('glowing');
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

  it('caches the answer for status and run', async () => {
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

  // VOU-503. The levels read Trust Score and silver its categories.
  it('says the Trust steps in plain words with their commands', () => {
    expect(goalActionText({ code: 'earn_trust', count: 250 })).toEqual({
      text: 'Earn 250 more Trust Score with verified tasks. A harder task earns more.',
      command: 'sealkeeper run',
    });
    expect(goalActionText({ code: 'trust_categories', count: 1 })).toEqual({
      text: 'Verify 5 or more tasks in 1 more category. Silver needs work in more than one.',
      command: 'sealkeeper run --any-poster',
    });
    expect(
      goalStepText({
        code: 'trust_score',
        done: true,
        progress: { current: 512.25, required: 400 },
      }),
    ).toBe('Trust Score, 512.25 of 400');
  });

  it('says a step in plain words with its command', () => {
    expect(goalActionText({ code: 'claim_seed_tasks', count: 12 })).toEqual({
      text: 'Claim 12 more seed tasks.',
      command: 'sealkeeper run',
    });
    expect(goalActionText({ code: 'claim_seed_tasks', count: 1 }).text).toBe(
      'Claim 1 more seed task.',
    );
    expect(goalActionText({ code: 'dormant', count: 40 })).toEqual({
      text: 'No accepted event for 40 days, so the level has dropped. Send events again.',
      command: 'sealkeeper sync',
    });
  });

  // VOU-386. Silver reads the model the CLI captures into the fingerprint,
  // or a usage event with a model, never the card.
  it('says how to declare the model the CLI captures', () => {
    expect(goalActionText({ code: 'declare_model', count: null })).toEqual({
      text: 'Declare the model. Set ANTHROPIC_MODEL or model in the Claude Code settings, which the hooks read at the next session, use the Mastra or OpenClaw adapter, or send a usage event that names the model with emit, then sync.',
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

  it('says what the new level steps need, with the day a hold ends', () => {
    expect(goalActionText({ code: 'clean_days', count: 108 })).toEqual({
      text: 'Keep a clean safety record for 108 more days. Gold needs 180 days since the first accepted event or the last incident, whichever is later.',
      command: null,
    });
    expect(
      goalActionText({
        code: 'operator_silver_cap',
        count: 12,
        until: '2026-10-08T09:00:00.000Z',
      }).text,
    ).toBe(
      "Every silver threshold holds, and this operator's agents took all 5 silver slots of the last 30 days. The agent stays at bronze until one frees in 12 days, on 2026-10-08.",
    );
    expect(
      goalActionText({
        code: 'operator_verification_lapsing',
        count: 1,
        until: '2026-10-01T00:00:00.000Z',
      }).text,
    ).toBe(
      "The operator's domain record was missing at its last check. Verification lapses in 1 day, on 2026-10-01, unless the TXT record is back. Gold needs it.",
    );
    // An API that sends no until still reads.
    expect(
      goalActionText({ code: 'operator_silver_cap', count: 3 }).text,
    ).toContain('in 3 days.');
  });

  it('says post a task with the adopt command and the template post beside it', () => {
    expect(goalActionText({ code: 'post_task', count: 1 })).toEqual({
      text: "Post 1 more task for other operators' agents to complete, every level needs them. Adopt a ready made one in a category, or post a template with sealkeeper tasks post --template <id>.",
      command: 'sealkeeper tasks post --adopt <category>',
    });
  });

  it('says a posted confirmed task is a counterparty post by hand with its outcome report', () => {
    expect(goalActionText({ code: 'post_confirmed_task', count: 2 })).toEqual({
      text: "Post 2 more counterparty tasks by hand for other operators' agents, then report each outcome once it is done. Template and adopted posts never count here.",
      command:
        'sealkeeper tasks post --type <type> --spec <json> --verify counterparty',
    });
  });

  it('says what a report as poster is for', () => {
    expect(goalActionText({ code: 'report_as_poster', count: 2 })).toEqual({
      text: 'Report the outcome of 2 tasks this agent posted. A confirmed task counts for both agents.',
      command: 'sealkeeper tasks outcome <id> success',
    });
  });
});

// COL-7. goal names the steps of counted evidence the way the SEAL
// standard, section 4, names them, in the order SealKeeper applies them,
// one sentence each, with the numbers from COUNTED_EVIDENCE. The README's
// goal sample shows the same lines, and apps/web/seal-page.test.ts in the
// monorepo checks the README's step names against the standard.
describe('the counted evidence steps', () => {
  it('names every step of the standard, in order, one sentence each', () => {
    expect(COUNTED_STEPS.map((step) => step.split('. ')[0])).toEqual([
      'Daily ceiling',
      'Diminishing returns per group',
      'Confirmer weight',
      'Check method and size',
      'Pass rate',
      'Pair curve',
      'Task weight',
      'Share cap',
      'Gold origin',
    ]);
    for (const step of COUNTED_STEPS) {
      // The name, then one sentence.
      expect(step.split('. ')).toHaveLength(2);
      expect(step.endsWith('.')).toBe(true);
    }
    expect(COUNTED_STEPS[0]).toContain('At most 20 verified tasks a day count');
    expect(COUNTED_STEPS[1]).toContain('25 of one group count about 17');
    expect(COUNTED_RULE).toContain(
      'The SEAL standard, section 4, has the numbers for steps 3 to 8, at https://sealkeeper.run/seal/standard.',
    );
  });

  it('is what the README shows under goal', () => {
    const readme = readFileSync(
      new URL('../../README.md', import.meta.url),
      'utf8',
    );
    expect(readme).toContain(`Today 14 of 20 counted.\n${COUNTED_RULE}\n`);
  });
});
