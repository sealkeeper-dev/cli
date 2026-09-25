// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookCommand } from '../claude-code-settings.js';
import { paths, writeConfig } from '../config.js';
import { appendEvent, dayOf, writeCursor } from '../log.js';
import { createProgram } from '../program.js';
import {
  dormancyLine,
  HOOKS_MISSING,
  minutesToNextScoring,
  NO_ADAPTER,
  nextScoringLine,
  sealWithheld,
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

type Live = { level?: string; dormantDays?: number | null };

function agentAnswer(verifiedTasks: number, live: Live = {}) {
  return {
    ...(live.level === undefined ? {} : { level: live.level }),
    ...(live.dormantDays === undefined
      ? {}
      : {
          standing: {
            counts: {},
            history_days: 3,
            last_active: null,
            dormant_days: live.dormantDays,
            quiet: (live.dormantDays ?? 0) >= 14,
          },
        }),
    id: AGENT_ID,
    name: 'scout',
    version: '1.0.0',
    operator: { login: 'carelmeyer' },
    createdAt: '2026-09-23T08:00:00.000Z',
    operatedByVouched: false,
    handle: 'carelmeyer/scout',
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
  scores: { dimension: string; value: number | null }[],
  verifiedTasks = 2,
  live: Live = {},
) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${API_URL}/v1/agents/${AGENT_ID}`) {
      return Response.json(agentAnswer(verifiedTasks, live));
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

async function run(fetchFn: typeof fetch, ...args: string[]) {
  const program = createProgram({
    sync: {
      fetch: fetchFn,
      sleep: async () => {},
      cwd: () => join(String(process.env.SEALKEEPER_HOME), 'project'),
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

// Seven events today. The cursor sits after the third, so four are pending.
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
        operatorLogin: 'carelmeyer',
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
    await rm(home, { recursive: true, force: true });
  });

  it('prints counts, pending, last sync and scores with null as a dash', async () => {
    await seedMixedLog();
    const fetchFn = scoreFetch([
      { dimension: 'reliability', value: 0.8234 },
      { dimension: 'safety', value: null },
      { dimension: 'competence:lint', value: 0.5 },
    ]);
    const { code, out, err } = await run(fetchFn, 'status');
    expect(code).toBe(0);
    expect(err).toBe('');
    const lines = out.split('\n');
    expect(lines).toContain(`agent             ${AGENT_ID}`);
    expect(lines).toContain('handle            carelmeyer/scout');
    expect(lines).toContain(
      'profile           https://sealkeeper.run/agents/carelmeyer/scout',
    );
    expect(lines).toContain(`today             ${dayOf(new Date())} UTC`);
    expect(lines).toContain('  session.start   1');
    expect(lines).toContain('  tool.call       3');
    expect(lines).toContain('  task.claimed    1');
    expect(lines).toContain('  task.submitted  1');
    expect(lines).toContain('  incident        1');
    expect(lines).toContain('  usage           0');
    expect(lines).toContain('tool calls        3, 2 ok (67%)');
    expect(lines).toContain('tasks             1 claimed, 1 submitted');
    expect(lines).toContain('verified tasks    2');
    expect(out).toMatch(
      /\nNext scoring run in about ([1-9]|1[0-5]) minutes?\n/,
    );
    expect(out).not.toContain('not submitted yet');
    expect(lines).toContain('pending           4');
    expect(lines).toContain(`last sync         ${LAST_SYNC}`);
    expect(lines).toContain(
      'auto-sync         off, run npx sealkeeper sync to review and send',
    );
    expect(out).not.toContain('"event_id"');
    expect(lines).toContain('  reliability     0.82');
    expect(lines).toContain('  safety          -');
    expect(lines).toContain('  cost_latency    -');
    expect(lines).toContain('  provenance      -');
    expect(lines).toContain('  competence:lint 0.50');
  });

  it('still exits 0 quickly when offline, with every score a dash', async () => {
    await seedMixedLog();
    const { code, out, ms } = await run(offline, 'status');
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1000);
    expect(out).toContain('pending           4\n');
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
        '2 claimed tasks are not submitted yet. Run npx sealkeeper prove to print them again with the submit lines.\n',
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

    it('uses one line for a single unsubmitted claim', async () => {
      await claimOnly();
      expect((await run(scoreFetch([], 0), 'status')).out).toContain(
        '1 claimed task is not submitted yet. Run npx sealkeeper prove to print it again with the submit lines.\n',
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

    it('prints a dash for the level when the API has none or is offline', async () => {
      expect((await run(scoreFetch([]), 'status')).out).toContain(
        'level             -\n',
      );
      expect((await run(offline, 'status')).out).toContain(
        'level             -\n',
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

    it('says no SEAL at 90 dormant days, when the API withholds it', async () => {
      const { code, out } = await run(
        scoreFetch([], 30, { level: 'none', dormantDays: 95 }),
        'status',
      );
      expect(code).toBe(0);
      const lines = out.split('\n');
      expect(lines).toContain('dormant           95 days');
      expect(lines).toContain(
        'SEAL              no SEAL, withheld while dormant',
      );
      expect(lines).toContain(
        'Quiet for 95 days. No SEAL is issued and the level is none until the next scoring run after a new event.',
      );
      expect(sealWithheld(89)).toBe(false);
      expect(sealWithheld(90)).toBe(true);
      expect(sealWithheld(null)).toBe(false);
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
      handle: 'carelmeyer/scout',
      profileUrl: 'https://sealkeeper.run/agents/carelmeyer/scout',
      day: dayOf(new Date()),
      counts: {
        'session.start': 1,
        'session.end': 0,
        'tool.call': 3,
        'task.claimed': 1,
        'task.submitted': 1,
        'task.outcome': 0,
        incident: 1,
        usage: 0,
      },
      toolCalls: { total: 3, ok: 2, okRatio: 2 / 3 },
      tasks: { claimed: 1, submitted: 1 },
      verifiedTasks: 2,
      level: null,
      dormantDays: null,
      unsubmittedClaims: 0,
      nextScoringRunMinutes: expect.any(Number),
      pending: 4,
      lastSyncAt: LAST_SYNC,
      autoSync: false,
      scores: {
        reliability: 0.9,
        safety: null,
        cost_latency: null,
        provenance: null,
      },
      scoresFetchedAt: expect.any(String),
    });
  });

  it('prints zeros and never when there is no log directory', async () => {
    const { code, out } = await run(offline, 'status');
    expect(code).toBe(0);
    expect(out).toContain('  tool.call       0\n');
    expect(out).toContain('tool calls        0, 0 ok (-)\n');
    expect(out).toContain('tasks             0 claimed, 0 submitted\n');
    expect(out).toContain('pending           0\n');
    expect(out).toContain('last sync         never\n');

    const json = JSON.parse((await run(offline, 'status', '--json')).out);
    expect(json).toMatchObject({
      pending: 0,
      lastSyncAt: null,
      toolCalls: { total: 0, ok: 0, okRatio: null },
      scoresFetchedAt: null,
    });
    expect(Object.values(json.counts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("--show lists today's events in full after the counts", async () => {
    const events = await seedMixedLog();
    const { code, out } = await run(offline, 'status', '--show');
    expect(code).toBe(0);
    const lines = out.split('\n');
    const header = lines.indexOf("today's events, 7, as they are sent");
    expect(header).toBeGreaterThan(lines.indexOf('  usage           0'));
    expect(lines.slice(header + 1, header + 8)).toEqual(
      events.map((e) => JSON.stringify(e)),
    );
  });

  it('--show --json adds the events to the object', async () => {
    const events = await seedMixedLog();
    const { out } = await run(offline, 'status', '--show', '--json');
    expect(JSON.parse(out).events).toEqual(events);
  });

  it('shows auto-sync on once it is on', async () => {
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'carelmeyer',
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
    async function settingsIn(dir: string): Promise<void> {
      const scriptDir = join(home, 'lib', 'node_modules', 'sealkeeper', 'dist');
      await mkdir(scriptDir, { recursive: true });
      const script = join(scriptDir, 'index.js');
      await writeFile(script, '');
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

    it('does not warn when something was recorded in the last 7 days', async () => {
      await eventDaysAgo(6);
      expect((await run(offline, 'status')).err).toBe('');
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
});
