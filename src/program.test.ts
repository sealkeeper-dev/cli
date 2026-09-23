// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from './config.js';
import { createProgram } from './program.js';

const AGENT_ID = 'A'.repeat(43);

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

// Runs the CLI in process. Exits become thrown CommanderErrors and the
// process streams are captured instead of printed.
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
    if (error instanceof CommanderError)
      return { code: error.exitCode, out, err };
    throw error;
  } finally {
    vi.restoreAllMocks();
  }
}

const LAUNCH_COMMANDS = [
  'init',
  'emit',
  'sync',
  'card show',
  'card write',
  'status',
  'tasks pull',
  'tasks submit',
  'tasks post',
  'rate',
  'whoami',
  'logout',
];

describe('vouched cli', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vouched-cli-'));
    vi.stubEnv('VOUCHED_HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('is named vouched and has the package version', () => {
    const program = createProgram();
    expect(program.name()).toBe('vouched');
    expect(program.version()).toBe('0.0.1');
  });

  it('--help lists all twelve launch commands', async () => {
    const { code, out } = await run('--help');
    expect(code).toBe(0);
    for (const name of LAUNCH_COMMANDS) {
      expect(out).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
    expect(LAUNCH_COMMANDS).toHaveLength(12);
  });

  it.each([
    { label: 'emit', args: ['emit'] },
    { label: 'sync', args: ['sync'] },
    { label: 'card show', args: ['card', 'show'] },
    { label: 'card write', args: ['card', 'write'] },
    { label: 'status', args: ['status'] },
    { label: 'tasks pull', args: ['tasks', 'pull'] },
    { label: 'tasks submit', args: ['tasks', 'submit', 'task-1'] },
    { label: 'tasks post', args: ['tasks', 'post'] },
    { label: 'rate', args: ['rate', AGENT_ID] },
    { label: 'logout', args: ['logout'] },
  ])('$label is a stub that exits 2', async ({ label, args }) => {
    const { code, out, err } = await run(...args);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toBe(`${label} is not implemented yet\n`);
  });

  it('whoami without config exits 1', async () => {
    const { code, out, err } = await run('whoami');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('not initialised, run vouched init\n');
  });

  it('whoami prints the identity from config', async () => {
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'carelmeyer',
        name: 'scout',
        version: '1.2.0',
        registeredAt: '2026-09-23T10:00:00Z',
      },
      paths(home),
    );
    const { code, out } = await run('whoami');
    expect(code).toBe(0);
    expect(out).toContain(`agentId        ${AGENT_ID}`);
    expect(out).toContain('operatorLogin  carelmeyer');
    expect(out).toContain('name           scout');
    expect(out).toContain('version        1.2.0');
    expect(out).toContain('apiUrl         https://api.vouched.run');
  });

  it('whoami --json prints one JSON object', async () => {
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'carelmeyer',
        name: 'scout',
        version: '1.2.0',
        apiUrl: 'http://localhost:8080',
        registeredAt: '2026-09-23T10:00:00Z',
      },
      paths(home),
    );
    const { code, out } = await run('--json', 'whoami');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      agentId: AGENT_ID,
      operatorLogin: 'carelmeyer',
      name: 'scout',
      version: '1.2.0',
      apiUrl: 'http://localhost:8080',
    });
  });

  it('--json also works after the command name', async () => {
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'carelmeyer',
        name: 'scout',
        version: '1.2.0',
        registeredAt: '2026-09-23T10:00:00Z',
      },
      paths(home),
    );
    const { code, out } = await run('whoami', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ agentId: AGENT_ID });
  });

  it('--version after a command belongs to that command', async () => {
    const { code, out } = await run('--version');
    expect(code).toBe(0);
    expect(out).toBe('0.0.1\n');
    const init = createProgram().commands.find((c) => c.name() === 'init');
    init?.parseOptions(['--version', '2.0.0']);
    expect(init?.opts().version).toBe('2.0.0');
  });

  it('whoami with an invalid config exits 1 with the reason', async () => {
    await writeFile(paths(home).config, '{ nope');
    const { code, err } = await run('whoami');
    expect(code).toBe(1);
    expect(err).toContain('Invalid config');
  });
});
