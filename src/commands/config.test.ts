// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, readConfig, readNudge, writeConfig } from '../config.js';
import { describeFingerprint } from '../fingerprint.js';
import { NUDGE_ON, nudgeLines } from '../nudge.js';
import { createProgram } from '../program.js';
import { describeTaxonomy } from '../taxonomy.js';
import { describeRequests } from './what-is-shared.js';

const AGENT_ID = 'A'.repeat(43);

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

// What the API answers. Offline unless a test sets it, so no test reaches
// the real API.
let answer: typeof fetch;
const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

async function run(...args: string[]): Promise<RunResult> {
  const program = createProgram({ config: { fetch: answer } });
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
  } catch (error) {
    if (error instanceof CommanderError) {
      return { code: error.exitCode, out, err };
    }
    throw error;
  } finally {
    vi.restoreAllMocks();
  }
}

describe('config', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-config-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    answer = offline;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function initialise(): Promise<void> {
    await writeConfig({
      agentId: AGENT_ID,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      registeredAt: '2026-09-23T08:00:00Z',
    });
  }

  it('auto-sync on and off round trip through config.json', async () => {
    await initialise();
    expect((await readConfig())?.autoSync).toBeUndefined();
    expect((await run('config', 'show')).out).toContain('autoSync       off\n');

    const on = await run('config', 'auto-sync', 'on');
    expect(on.code).toBe(0);
    expect(on.out).toContain('automatic sync is on');
    expect(on.out).toContain('npx sealkeeper config auto-sync off');
    expect((await readConfig())?.autoSync).toBe(true);
    expect((await run('config', 'show')).out).toContain('autoSync       on\n');

    const off = await run('config', 'auto-sync', 'off');
    expect(off.code).toBe(0);
    expect(off.out).toContain('npx sealkeeper sync --dry-run');
    expect((await readConfig())?.autoSync).toBe(false);
    expect((await run('config', 'show')).out).toContain('autoSync       off\n');
  });

  it('leaves the other fields alone', async () => {
    await initialise();
    const before = await readConfig();
    await run('config', 'auto-sync', 'on');
    expect(await readConfig()).toEqual({ ...before, autoSync: true });
  });

  it('show prints every field, and one object with --json', async () => {
    await initialise();
    const { code, out } = await run('config', 'show');
    expect(code).toBe(0);
    expect(out).toContain(`agentId        ${AGENT_ID}\n`);
    expect(out).toContain('apiUrl         https://api.sealkeeper.run\n');
    const json = JSON.parse((await run('config', 'show', '--json')).out);
    expect(json).toEqual({
      ...(await readConfig()),
      autoSync: false,
      nudge: false,
    });
  });

  it('nudge on and off round trip through nudge.json, never config.json', async () => {
    await initialise();
    expect(await readNudge()).toBeUndefined();
    expect((await run('config', 'show')).out).toContain('nudge          off\n');

    const on = await run('config', 'nudge', 'on');
    expect(on.code).toBe(0);
    expect(on.out).toContain('session nudge is on');
    expect(await readNudge()).toBe(true);
    expect(await readConfig()).not.toHaveProperty('nudge');
    expect((await run('config', 'show')).out).toContain('nudge          on\n');

    const off = await run('config', 'nudge', 'off', '--json');
    expect(JSON.parse(off.out)).toEqual({ nudge: false });
    expect(await readNudge()).toBe(false);

    const bad = await run('config', 'nudge', 'maybe');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('nudge takes on or off');
    expect(await readNudge()).toBe(false);
  });

  it('nudge on fills the goal cache once, and says nothing more when it cannot', async () => {
    await initialise();
    const on = await run('config', 'nudge', 'on');
    expect(on).toEqual({ code: 0, out: `${NUDGE_ON}\n`, err: '' });
    await expect(stat(paths().goal)).rejects.toThrow('ENOENT');

    const urls: string[] = [];
    answer = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        agentId: AGENT_ID,
        version: '1.0.0',
        level: 'bronze',
        nextLevel: 'silver',
        thresholds: [],
        actions: [],
        pending: { addressed: 1, outcomes: 0 },
        asOf: '2026-09-25T10:15:00.000Z',
      });
    }) as typeof fetch;
    await run('config', 'nudge', 'on');
    expect(urls).toEqual([
      `https://api.sealkeeper.run/v1/agents/${AGENT_ID}/goal`,
    ]);
    expect(await nudgeLines('/sealkeeper-run')).toContain(
      '1 task addressed to you.',
    );

    await run('config', 'nudge', 'off');
    expect(urls).toHaveLength(1);
  });

  it('rejects a state other than on or off', async () => {
    await initialise();
    const { code, err } = await run('config', 'auto-sync', 'maybe');
    expect(code).toBe(1);
    expect(err).toContain('auto-sync takes on or off');
    expect((await readConfig())?.autoSync).toBeUndefined();
  });

  it('exits 1 with the init hint before init', async () => {
    for (const args of [
      ['config', 'show'],
      ['config', 'auto-sync', 'on'],
    ]) {
      const { code, err } = await run(...args);
      expect(code).toBe(1);
      expect(err).toBe('not initialised, run npx sealkeeper init\n');
    }
  });
});

describe('what-is-shared', () => {
  it('prints the same block as init, then the fingerprint and what each command sends, and is listed in help', async () => {
    const { code, out } = await run('what-is-shared');
    expect(code).toBe(0);
    expect(out).toBe(
      `${describeTaxonomy()}\n\n${describeFingerprint()}\n\n${describeRequests()}\n`,
    );
    for (const part of ['model_set', 'prompt', 'tools', 'framework']) {
      expect(out).toMatch(new RegExp(`^ {2}${part} `, 'm'));
    }
    expect(out).toContain(
      'Only a SHA-256 hash of each part is stored, never what it is hashed from. claim, submit, outcome, run, duel and challenge send those hashes inside the signed request, and so do each step of a routine run and its submits, and each sync beside its events, and each sync and submit sends the model name below with them. The terminal run and a look at the duels or the challenge board send none.',
    );
    // VOU-566. The model name is the one value that leaves as text.
    expect(out).toContain(
      'Model name. Each sync also sends the name of the model your agent runs, as text and not a hash',
    );
    // VOU-615. A submit carries it too.
    expect(out).toContain(
      'Each submit sends the same name with the answer, the one the runtime reported for that answer on a routine run',
    );
    // VOU-656. The profile shows a submit's name too.
    expect(out).toContain(
      "The task keeps it beside the answer, which only the poster and your agent can read, and the agent's profile shows it too, the newest name a sync or a submit sent.",
    );
    expect(out).toContain(
      'Only the name leaves, never a prompt, an input or an output.',
    );
    expect(createProgram().helpInformation()).toMatch(/^ {2}what-is-shared\b/m);
  });
});
