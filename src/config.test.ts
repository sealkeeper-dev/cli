// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_API_URL,
  paths,
  readConfig,
  vouchedHome,
  writeConfig,
} from './config.js';

const VALID = {
  agentId: 'A'.repeat(43),
  operatorLogin: 'carelmeyer',
  name: 'scout',
  version: '1.2.0',
  registeredAt: '2026-09-23T10:00:00Z',
};

describe('config', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vouched-config-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses VOUCHED_HOME when set, else ~/.vouched', () => {
    expect(vouchedHome({ VOUCHED_HOME: '/x/y' })).toBe('/x/y');
    expect(vouchedHome({})).toBe(join(homedir(), '.vouched'));
    expect(vouchedHome({ VOUCHED_HOME: '' })).toBe(join(homedir(), '.vouched'));
  });

  it('builds every path under the home directory', () => {
    const p = paths('/h');
    expect(p).toMatchObject({
      home: '/h',
      config: '/h/config.json',
      key: '/h/key',
      log: '/h/log',
      cursor: '/h/cursor.json',
      credential: '/h/credential.json',
      score: '/h/score.json',
      sessions: '/h/sessions',
    });
    expect(p.logFile('2026-09-23')).toBe('/h/log/2026-09-23.jsonl');
  });

  it('returns null when there is no config', async () => {
    expect(await readConfig(paths(join(root, 'missing')))).toBeNull();
  });

  it('round trips and fills the default api url', async () => {
    const p = paths(join(root, 'home'));
    const written = await writeConfig(VALID, p);
    expect(written.apiUrl).toBe(DEFAULT_API_URL);
    expect(await readConfig(p)).toEqual({ ...VALID, apiUrl: DEFAULT_API_URL });
  });

  it('creates the home directory with mode 700 and leaves no temp file', async () => {
    const p = paths(join(root, 'nested', 'home'));
    await writeConfig(VALID, p);
    expect((await stat(p.home)).mode & 0o777).toBe(0o700);
    expect((await stat(p.config)).mode & 0o777).toBe(0o600);
    expect(await readdir(p.home)).toEqual(['config.json']);
  });

  it('tightens an existing home directory to 700', async () => {
    const p = paths(root);
    await chmod(root, 0o755);
    await writeConfig(VALID, p);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it('refuses to write an invalid config', async () => {
    const p = paths(root);
    await expect(
      writeConfig({ ...VALID, agentId: 'nope' }, p),
    ).rejects.toThrow();
    expect(await readConfig(p)).toBeNull();
  });

  it('throws a clear error for JSON that does not parse', async () => {
    const p = paths(root);
    await writeFile(p.config, '{ nope');
    await expect(readConfig(p)).rejects.toThrow(ConfigError);
    await expect(readConfig(p)).rejects.toThrow(/not valid JSON/);
  });

  it('throws a clear error naming the bad field', async () => {
    const p = paths(root);
    await writeFile(p.config, JSON.stringify({ ...VALID, agentId: 'short' }));
    await expect(readConfig(p)).rejects.toThrow(ConfigError);
    await expect(readConfig(p)).rejects.toThrow(/agentId/);
  });

  it('rejects unknown keys', async () => {
    const p = paths(root);
    await writeFile(p.config, JSON.stringify({ ...VALID, extra: true }));
    await expect(readConfig(p)).rejects.toThrow(/extra/);
  });
});
