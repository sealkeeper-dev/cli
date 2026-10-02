// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from './config.js';
import { readOperatorSlug } from './operator-slug.js';
import { createProgram } from './program.js';

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

// whoami reads the agent for the operator slug. Offline unless a test says
// otherwise, so no test reaches the network.
const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;
let whoamiFetch: typeof fetch = offline;

// Runs the CLI in process. Exits become thrown CommanderErrors and the
// process streams are captured instead of printed.
async function run(...args: string[]): Promise<RunResult> {
  const program = createProgram({ whoami: { fetch: whoamiFetch } });
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
  'run',
  'submit',
  'tasks post',
  'rate',
  'whoami',
  'logout',
];

describe('sealkeeper cli', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-cli-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
  });

  afterEach(async () => {
    whoamiFetch = offline;
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('is named sealkeeper and has the package version', () => {
    const program = createProgram();
    expect(program.name()).toBe('sealkeeper');
    expect(program.version()).toBe(PKG_VERSION);
  });

  it('--help lists all twelve launch commands', async () => {
    const { code, out } = await run('--help');
    expect(code).toBe(0);
    for (const name of LAUNCH_COMMANDS) {
      expect(out).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
    expect(LAUNCH_COMMANDS).toHaveLength(12);
  });

  it('--help lists the seal commands and says SEAL', async () => {
    const { code, out } = await run('--help');
    expect(code).toBe(0);
    for (const name of ['seal show', 'seal verify', 'seal write']) {
      expect(out).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
    expect(out).not.toMatch(/credential/i);
  });

  it('whoami without config exits 1', async () => {
    const { code, out, err } = await run('whoami');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('not initialised, run npx sealkeeper init\n');
  });

  it('whoami prints the identity from config', async () => {
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
    const { code, out } = await run('whoami');
    expect(code).toBe(0);
    expect(out).toContain(`agentId        ${AGENT_ID}`);
    expect(out).toContain('handle         alice/scout');
    expect(out).toContain('operatorLogin  alice');
    expect(out).toContain('name           scout');
    expect(out).toContain('version        1.2.0');
    expect(out).toContain('apiUrl         https://api.sealkeeper.run');
    expect(out).toContain(
      'profileUrl     https://sealkeeper.run/agents/alice/scout',
    );
  });

  it('whoami --json prints one JSON object', async () => {
    await writeConfig(
      {
        agentId: AGENT_ID,
        operatorLogin: 'alice',
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
      handle: 'alice/scout',
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.2.0',
      apiUrl: 'http://localhost:8080',
      profileUrl: 'https://sealkeeper.run/agents/alice/scout',
    });
  });

  it('whoami builds the handle from the operator slug and keeps it offline', async () => {
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
    whoamiFetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        `https://api.sealkeeper.run/v1/agents/${AGENT_ID}`,
      );
      return Response.json({
        operator: { login: 'alice', slug: 'wonderland' },
        handle: 'wonderland/scout',
      });
    }) as typeof fetch;
    const online = await run('--json', 'whoami');
    expect(JSON.parse(online.out)).toMatchObject({
      handle: 'wonderland/scout',
      operatorLogin: 'alice',
      profileUrl: 'https://sealkeeper.run/agents/wonderland/scout',
    });
    expect(await readOperatorSlug(AGENT_ID, paths(home))).toBe('wonderland');

    whoamiFetch = offline;
    const off = await run('whoami');
    expect(off.out).toContain('handle         wonderland/scout');
    expect(off.out).toContain(
      'profileUrl     https://sealkeeper.run/agents/wonderland/scout',
    );
  });

  // VB-4. whoami prints the agent's current fingerprint states from the
  // agent answer, as status and the profile do, never a part hash.
  it('whoami prints the fingerprint states from the agent answer', async () => {
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
    const fingerprint = {
      hash: `${'F'.repeat(42)}A`,
      at: '2026-09-28T08:00:00.000Z',
      parts: {
        model_set: 'declared',
        prompt: 'not_declared',
        tools: 'unstable',
        framework: 'declared',
      },
    };
    let answer: unknown = fingerprint;
    whoamiFetch = (async () =>
      Response.json({
        operator: { login: 'alice', slug: 'alice' },
        handle: 'alice/scout',
        fingerprint: answer,
      })) as typeof fetch;
    const text = await run('whoami');
    expect(text.out).toContain(
      'fingerprint    model declared, prompt not declared, tools unstable, framework declared\n',
    );
    expect(JSON.parse((await run('--json', 'whoami')).out)).toMatchObject({
      fingerprint,
    });

    answer = null;
    expect((await run('whoami')).out).toContain(
      'fingerprint    none declared\n',
    );
    expect(JSON.parse((await run('--json', 'whoami')).out)).toMatchObject({
      fingerprint: null,
    });

    whoamiFetch = offline;
    expect((await run('whoami')).out).toContain('fingerprint    -\n');
    expect(JSON.parse((await run('--json', 'whoami')).out)).not.toHaveProperty(
      'fingerprint',
    );
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
    const { code, out } = await run('whoami', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ agentId: AGENT_ID });
  });

  it('--version after a command belongs to that command', async () => {
    const { code, out } = await run('--version');
    expect(code).toBe(0);
    expect(out).toBe(`${PKG_VERSION}\n`);
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
