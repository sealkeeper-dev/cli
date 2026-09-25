// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_API_URL,
  isSecureApiUrl,
  paths,
  readConfig,
  sealkeeperHome,
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
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-config-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses SEALKEEPER_HOME when set, else ~/.sealkeeper', () => {
    expect(sealkeeperHome({ SEALKEEPER_HOME: '/x/y' })).toBe('/x/y');
    expect(sealkeeperHome({})).toBe(join(homedir(), '.sealkeeper'));
    expect(sealkeeperHome({ SEALKEEPER_HOME: '' })).toBe(
      join(homedir(), '.sealkeeper'),
    );
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

  it('round trips and fills the default api url, auto-sync unset', async () => {
    const p = paths(join(root, 'home'));
    const written = await writeConfig(VALID, p);
    expect(written.apiUrl).toBe(DEFAULT_API_URL);
    expect(written.autoSync).toBeUndefined();
    expect(await readConfig(p)).toEqual({ ...VALID, apiUrl: DEFAULT_API_URL });
  });

  it('reads a config written before autoSync existed as unset', async () => {
    const p = paths(root);
    await writeFile(p.config, JSON.stringify(VALID));
    expect((await readConfig(p))?.autoSync).toBeUndefined();
  });

  it('round trips autoSync on and off', async () => {
    const p = paths(root);
    await writeConfig({ ...VALID, autoSync: true }, p);
    expect((await readConfig(p))?.autoSync).toBe(true);
    await writeConfig({ ...VALID, autoSync: false }, p);
    expect((await readConfig(p))?.autoSync).toBe(false);
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

describe('isSecureApiUrl', () => {
  it('accepts https anywhere and http only to this machine', () => {
    expect(isSecureApiUrl('https://api.sealkeeper.run')).toBe(true);
    expect(isSecureApiUrl('http://localhost:8787')).toBe(true);
    expect(isSecureApiUrl('http://127.0.0.1')).toBe(true);
    expect(isSecureApiUrl('http://[::1]:3000')).toBe(true);
    expect(isSecureApiUrl('http://api.sealkeeper.run')).toBe(false);
    expect(isSecureApiUrl('http://localhost.evil.test')).toBe(false);
    expect(isSecureApiUrl('ftp://api.test')).toBe(false);
    expect(isSecureApiUrl('not a url')).toBe(false);
  });
});
