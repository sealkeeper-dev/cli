// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '@vouched-dev/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { appendEvent, dayOf, writeCursor } from '../log.js';
import { createProgram } from '../program.js';

const AGENT_ID = 'A'.repeat(43);
const API_URL = 'http://api.test';
const LAST_SYNC = '2026-09-23T09:00:00.000Z';

type RunResult = { code: number; out: string; err: string; ms: number };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

function scoreFetch(scores: { dimension: string; value: number | null }[]) {
  return (async (input: string | URL | Request) => {
    expect(String(input)).toBe(`${API_URL}/v1/agents/${AGENT_ID}/score`);
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
    sync: { fetch: fetchFn, sleep: async () => {} },
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
    home = await mkdtemp(join(tmpdir(), 'vouched-status-'));
    vi.stubEnv('VOUCHED_HOME', home);
    vi.stubEnv('VOUCHED_API_URL', '');
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
      'profile           https://vouched.run/agents/carelmeyer/scout',
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
    expect(lines).toContain('pending           4');
    expect(lines).toContain(`last sync         ${LAST_SYNC}`);
    expect(lines).toContain(
      'auto-sync         off, run vouched sync to review and send',
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
      profileUrl: 'https://vouched.run/agents/carelmeyer/scout',
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
    expect(err).toBe('not initialised, run vouched init\n');
  });
});
