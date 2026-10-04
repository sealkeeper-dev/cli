// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from './config.js';
import { CORE_GROUP, createProgram, MORE_GROUP } from './program.js';

const PKG_VERSION = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    ),
  ) as { version: string }
).version;

const AGENT_ID = 'A'.repeat(43);

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

// No test reaches the network.
const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

// Runs the CLI in process. Exits become thrown CommanderErrors and the
// process streams are captured instead of printed.
async function run(...args: string[]): Promise<RunResult> {
  const program = createProgram({ tasks: { fetch: offline } });
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

// VOU-603. sealkeeper --help shows the six core commands first, then the
// rest under More. Hidden commands run when called by name and are in
// neither group.
const CORE = ['init', 'run', 'challenge', 'duel', 'status', 'routine'];
const MORE = [
  'submit',
  'release',
  'claim',
  'post',
  'outcome',
  'seal',
  'check',
  'agent',
  'config',
  'logout',
  'what-is-shared',
  'help',
];
const HIDDEN = ['emit', 'sync', 'hook', 'rate'];
// Removed, with no alias.
const REMOVED = ['game', 'card', 'model', 'adapter', 'tasks', 'prove'];

// The names a group of the root help lists, in order.
function group(help: string, heading: string): string[] {
  const start = help.indexOf(`\n${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const lines = help.slice(start + heading.length + 2).split('\n');
  const end = lines.indexOf('');
  return (end === -1 ? lines : lines.slice(0, end))
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(' ')[0] ?? '');
}

describe('sealkeeper cli', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-cli-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('is named sealkeeper and has the package version', () => {
    const program = createProgram();
    expect(program.name()).toBe('sealkeeper');
    expect(program.version()).toBe(PKG_VERSION);
  });

  it('--help lists the six core commands first, then More', async () => {
    const { code, out } = await run('--help');
    expect(code).toBe(0);
    expect(group(out, CORE_GROUP)).toEqual(CORE);
    expect(group(out, MORE_GROUP)).toEqual(MORE);
    expect(out.indexOf(CORE_GROUP)).toBeLessThan(out.indexOf(MORE_GROUP));
    expect(out).not.toMatch(/credential/i);
    expect(out).toContain('SEAL');
  });

  it('hides emit, sync, hook and rate, which still run by name', async () => {
    const { out } = await run('--help');
    const names = createProgram().commands.map((c) => c.name());
    for (const name of HIDDEN) {
      expect(out).not.toMatch(new RegExp(`^ {2}${name}\\b`, 'm'));
      expect(names).toContain(name);
    }
  });

  it.each(REMOVED)('has no %s command', async (name) => {
    expect(createProgram().commands.map((c) => c.name())).not.toContain(name);
    const { code, err } = await run(name);
    expect(code).toBe(1);
    expect(err).toContain(`unknown command '${name}'`);
  });

  it('seal --help lists the seal commands', async () => {
    const { code, out } = await run('seal', '--help');
    expect(code).toBe(0);
    for (const name of ['show', 'verify', 'write', 'handshake']) {
      expect(out).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
  });

  // VOU-611. The game switch is a config setting, game stays removed.
  it('config --help lists the config commands, game among them', async () => {
    const { code, out } = await run('config', '--help');
    expect(code).toBe(0);
    for (const name of ['show', 'auto-sync', 'nudge', 'game']) {
      expect(out).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
  });

  it('an agent command without config exits 1', async () => {
    const { code, out, err } = await run('status');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('not initialised, run npx sealkeeper init\n');
  });

  it('--json also works after the command name', async () => {
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'alice',
        name: 'scout',
        version: '1.2.0',
        registeredAt: '2026-09-23T10:00:00Z',
      },
      paths(home),
    );
    const { code, out } = await run('status', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ source: { from: 'none' } });
  });

  it('--version after a command belongs to that command', async () => {
    const { code, out } = await run('--version');
    expect(code).toBe(0);
    expect(out).toBe(`${PKG_VERSION}\n`);
    const init = createProgram().commands.find((c) => c.name() === 'init');
    init?.parseOptions(['--version', '2.0.0']);
    expect(init?.opts().version).toBe('2.0.0');
  });

  it('an agent command with an invalid config exits 1 with the reason', async () => {
    await writeFile(paths(home).config, '{ nope');
    const { code, err } = await run('status');
    expect(code).toBe(1);
    expect(err).toContain('Invalid config');
  });
});
