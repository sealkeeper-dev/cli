// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_API_URL,
  isSecureApiUrl,
  paths,
  readConfig,
  readNudge,
  readRoutineConfig,
  sealkeeperHome,
  writeConfig,
  writeNudge,
  writeRoutineConfig,
} from './config.js';

const VALID = {
  agentId: 'A'.repeat(43),
  operatorLogin: 'alice',
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
      inbox: '/h/inbox.json',
      postPrompt: '/h/post-prompt.json',
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

  it('keeps keys it does not know, and writes them back', async () => {
    const p = paths(root);
    await writeFile(p.config, JSON.stringify({ ...VALID, extra: true }));
    const config = await readConfig(p);
    expect(config).toMatchObject({ extra: true });
    if (config === null) throw new Error('no config');
    await writeConfig({ ...config, autoSync: true }, p);
    expect(JSON.parse(await readFile(p.config, 'utf8'))).toEqual({
      ...VALID,
      apiUrl: DEFAULT_API_URL,
      extra: true,
      autoSync: true,
    });
  });

  // The keys CLI 0.4.4 reads config.json with, strictly. A key outside
  // them fails every command of a copy pinned to 0.4.4, the adapters too.
  const KEYS_0_4_4 = [
    'agentId',
    'operatorLogin',
    'name',
    'version',
    'apiUrl',
    'registeredAt',
    'autoSync',
  ];

  it('moves nudge and routine out of config.json once, keeping them', async () => {
    const p = paths(root);
    const routine = {
      limits: {
        claimsPerDay: 4,
        postsPerDay: 3,
        confirmsPerDay: 10,
        minutesPerRun: 15,
        tokensPerRun: 300_000,
      },
      allow: ['bob'],
    };
    await writeFile(
      p.config,
      JSON.stringify({ ...VALID, nudge: true, routine }),
    );
    const config = await readConfig(p);
    expect(config).not.toHaveProperty('nudge');
    expect(config).not.toHaveProperty('routine');
    const written = JSON.parse(await readFile(p.config, 'utf8'));
    expect(Object.keys(written).every((k) => KEYS_0_4_4.includes(k))).toBe(
      true,
    );
    expect(await readNudge(p)).toBe(true);
    // The post limit of the first routine build is dropped on read.
    expect(await readRoutineConfig(p)).toEqual({
      limits: {
        claimsPerDay: 4,
        confirmsPerDay: 10,
        minutesPerRun: 15,
        tokensPerRun: 300_000,
      },
      allow: ['bob'],
    });
  });

  it('never overwrites nudge.json or routine.json when moving', async () => {
    const p = paths(root);
    await writeNudge(false, p);
    await writeRoutineConfig(
      {
        limits: {
          claimsPerDay: 1,
          confirmsPerDay: 1,
          minutesPerRun: 1,
          tokensPerRun: 1000,
        },
        allow: [],
      },
      p,
    );
    await writeFile(
      p.config,
      JSON.stringify({ ...VALID, nudge: true, routine: { allow: ['bob'] } }),
    );
    await readConfig(p);
    expect(await readNudge(p)).toBe(false);
    expect((await readRoutineConfig(p)).limits.claimsPerDay).toBe(1);
    expect(JSON.parse(await readFile(p.config, 'utf8'))).not.toHaveProperty(
      'nudge',
    );
  });

  it('keeps a key in config.json when its own file cannot be written', async () => {
    const p = paths(root);
    // A link to nowhere, so nudge.json can be neither read nor created.
    await symlink(join(root, 'missing', 'nudge.json'), p.nudge);
    await writeFile(p.config, JSON.stringify({ ...VALID, nudge: true }));
    const config = await readConfig(p);
    expect(config).toMatchObject({ nudge: true });
    if (config === null) throw new Error('no config');
    await writeConfig({ ...config, autoSync: true }, p);
    expect(JSON.parse(await readFile(p.config, 'utf8'))).toMatchObject({
      nudge: true,
      autoSync: true,
    });
  });

  it('never writes nudge or routine to config.json', async () => {
    const p = paths(root);
    await writeConfig({ ...VALID, nudge: true, routine: {} }, p);
    const written = JSON.parse(await readFile(p.config, 'utf8'));
    expect(Object.keys(written).every((k) => KEYS_0_4_4.includes(k))).toBe(
      true,
    );
  });

  it('reads the routine defaults without routine.json and refuses a broken one', async () => {
    const p = paths(root);
    expect(await readRoutineConfig(p)).toEqual({
      limits: {
        claimsPerDay: 10,
        confirmsPerDay: 10,
        minutesPerRun: 15,
        tokensPerRun: 300_000,
      },
      allow: [],
    });
    await writeFile(
      p.routine,
      JSON.stringify({ limits: { claimsPerDay: -1 } }),
    );
    await expect(readRoutineConfig(p)).rejects.toThrow(ConfigError);
    await writeFile(p.routine, '{ nope');
    await expect(readRoutineConfig(p)).rejects.toThrow(/not valid JSON/);
  });

  it('reads the nudge as unset when nudge.json is missing or broken', async () => {
    const p = paths(root);
    expect(await readNudge(p)).toBeUndefined();
    await writeFile(p.nudge, '{ nope');
    expect(await readNudge(p)).toBeUndefined();
    await writeNudge(true, p);
    expect(await readNudge(p)).toBe(true);
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
