// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Paths, paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { appendEvent, writeCursor } from '../log.js';
import { createProgram } from '../program.js';

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
    if (error instanceof CommanderError)
      return { code: error.exitCode, out, err };
    throw error;
  } finally {
    vi.restoreAllMocks();
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('logout', () => {
  let home: string;
  let p: Paths;
  let agentId: string;

  // A full local session. Config, key, cursor, credential, score and a log.
  async function initialise(): Promise<void> {
    ({ agentId } = await createKey({}, p));
    await writeConfig(
      {
        agentId,
        operatorLogin: 'carelmeyer',
        name: 'scout',
        version: '1.0.0',
        registeredAt: '2026-09-23T08:00:00Z',
      },
      p,
    );
    await writeCursor({ v: 1, lastAcked: null }, p);
    await writeFile(p.credential, '{}\n');
    await writeFile(p.score, '{}\n');
    await appendEvent(
      {
        event_id: randomUUID(),
        type: 'session.start',
        occurred_at: new Date().toISOString(),
        version: '1.0.0',
        payload: { session_id: 's1' },
      },
      p,
    );
  }

  const SESSION = () => [p.config, p.cursor, p.credential, p.score];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-logout-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    p = paths(home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('removes the four session files and keeps the key and the log', async () => {
    await initialise();
    const { code, out, err } = await run('logout');
    expect(code).toBe(0);
    expect(err).toBe('');
    for (const file of SESSION()) expect(await exists(file)).toBe(false);
    expect(await exists(p.key)).toBe(true);
    expect(await readdir(p.log)).toHaveLength(1);
    expect(out).toContain(
      'logged out, removed cursor.json, credential.json, score.json, config.json',
    );
    expect(out).toContain(`kept the key at ${p.key}`);
  });

  it('--delete-key without --yes deletes nothing and exits 1', async () => {
    await initialise();
    const { code, out, err } = await run('logout', '--delete-key');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain(`--delete-key would delete the key at ${p.key}`);
    expect(err).toContain(agentId);
    expect(err).toContain('Nothing was deleted');
    for (const file of [...SESSION(), p.key]) {
      expect(await exists(file)).toBe(true);
    }
  });

  it('--delete-key --yes removes the key too and keeps the log', async () => {
    await initialise();
    const { code, out } = await run('logout', '--delete-key', '--yes');
    expect(code).toBe(0);
    for (const file of [...SESSION(), p.key]) {
      expect(await exists(file)).toBe(false);
    }
    expect(await readdir(p.log)).toHaveLength(1);
    expect(out).toContain(`the identity of agent ${agentId} is gone for good`);
  });

  it('--yes alone keeps the key', async () => {
    await initialise();
    expect((await run('logout', '--yes')).code).toBe(0);
    expect(await exists(p.key)).toBe(true);
  });

  it('prints what it removed as JSON with --json', async () => {
    await initialise();
    await rm(p.credential);
    const { code, out } = await run('logout', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      loggedOut: true,
      removed: ['cursor.json', 'score.json', 'config.json'],
      keyDeleted: false,
    });
  });

  it('still logs out with a broken config', async () => {
    await initialise();
    await writeFile(p.config, '{ nope');
    const { code } = await run('logout');
    expect(code).toBe(0);
    expect(await exists(p.config)).toBe(false);
    expect(await exists(p.key)).toBe(true);
  });

  it('without config prints not initialised and exits 0', async () => {
    const { code, out, err } = await run('logout');
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toBe('not initialised, nothing to log out\n');
  });

  it('logout then --delete-key --yes still removes the key', async () => {
    await initialise();
    expect((await run('logout')).code).toBe(0);
    expect(await exists(p.key)).toBe(true);
    const { code, out, err } = await run('logout', '--delete-key', '--yes');
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toBe(
      `deleted the key at ${p.key}, the identity of this agent is gone for good\n`,
    );
    expect(await exists(p.key)).toBe(false);
    expect(await readdir(p.log)).toHaveLength(1);
  });

  it('without config, --delete-key alone keeps the key and exits 0', async () => {
    await createKey({}, p);
    const { code, out } = await run('logout', '--delete-key');
    expect(code).toBe(0);
    expect(out).toBe('not initialised, nothing to log out\n');
    expect(await exists(p.key)).toBe(true);
  });
});
