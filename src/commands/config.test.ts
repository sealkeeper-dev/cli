// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, writeConfig } from '../config.js';
import { createProgram } from '../program.js';
import { describeTaxonomy } from '../taxonomy.js';

const AGENT_ID = 'A'.repeat(43);

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

async function run(...args: string[]): Promise<RunResult> {
  const program = createProgram();
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
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function initialise(): Promise<void> {
    await writeConfig({
      agentId: AGENT_ID,
      operatorLogin: 'carelmeyer',
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
    expect(on.out).toContain('sealkeeper config auto-sync off');
    expect((await readConfig())?.autoSync).toBe(true);
    expect((await run('config', 'show')).out).toContain('autoSync       on\n');

    const off = await run('config', 'auto-sync', 'off');
    expect(off.code).toBe(0);
    expect(off.out).toContain('sealkeeper sync --dry-run');
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
    expect(json).toEqual({ ...(await readConfig()), autoSync: false });
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
      expect(err).toBe('not initialised, run sealkeeper init\n');
    }
  });
});

describe('what-is-shared', () => {
  it('prints the same block as init and is hidden from help', async () => {
    const { code, out } = await run('what-is-shared');
    expect(code).toBe(0);
    expect(out).toBe(`${describeTaxonomy()}\n`);
    expect(createProgram().helpInformation()).not.toContain('what-is-shared');
  });
});
