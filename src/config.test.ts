// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentsMapPath,
  bindFolder,
  boundHome,
  ConfigError,
  DEFAULT_API_URL,
  isSecureApiUrl,
  listMachineAgents,
  namedHome,
  paths,
  readConfig,
  readFolderMap,
  readNudge,
  readRoutineConfig,
  relativeHome,
  sealkeeperHome,
  sealkeeperRoot,
  unbindHome,
  writeConfig,
  writeNudge,
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
      cursorOffset: '/h/cursor-offset.json',
      credential: '/h/credential.json',
      status: '/h/status.json',
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

  it('reads the routine defaults without routine.json and refuses a broken one', async () => {
    const p = paths(root);
    expect(await readRoutineConfig(p)).toEqual({
      limits: {
        claimsPerDay: 10,
        networkClaimsPerDay: 2,
        confirmsPerDay: 10,
        postsPerDay: 3,
        minutesPerRun: 15,
        tokensPerRun: 300_000,
      },
      allow: [],
      allowSlugs: [],
      time: '10:00',
      game: false,
    });
    await writeFile(
      p.routine,
      JSON.stringify({ limits: { claimsPerDay: -1 } }),
    );
    await expect(readRoutineConfig(p)).rejects.toThrow(ConfigError);
    // postsPerDay reads from routine.json within 0 to 10 (POST-7).
    await writeFile(p.routine, JSON.stringify({ limits: { postsPerDay: 0 } }));
    expect((await readRoutineConfig(p)).limits.postsPerDay).toBe(0);
    await writeFile(p.routine, JSON.stringify({ limits: { postsPerDay: 11 } }));
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

describe('agent per folder', () => {
  // dir holds the root and the project folders, all after realpath, since
  // the temp directory itself may sit behind a symlink.
  let dir: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let app: string;
  let billing: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'sealkeeper-folders-')));
    root = join(dir, 'root');
    env = { SEALKEEPER_ROOT: root };
    app = join(dir, 'app');
    billing = join(dir, 'billing');
    await mkdir(join(app, 'src', 'deep'), { recursive: true });
    await mkdir(billing, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeMap = (folders: Record<string, string>) =>
    mkdir(root, { recursive: true }).then(() =>
      writeFile(agentsMapPath(root), JSON.stringify({ version: 1, folders })),
    );

  it('puts the root at ~/.sealkeeper whatever SEALKEEPER_HOME says', () => {
    expect(sealkeeperRoot({})).toBe(join(homedir(), '.sealkeeper'));
    expect(sealkeeperRoot({ SEALKEEPER_HOME: '/x/y' })).toBe(
      join(homedir(), '.sealkeeper'),
    );
    expect(sealkeeperRoot(env)).toBe(root);
    expect(agentsMapPath(root)).toBe(join(root, 'agents.json'));
    expect(namedHome('billing', root)).toBe(join(root, 'agents', 'billing'));
  });

  it('gives the root without a map, and for a folder nothing is bound to', async () => {
    expect(sealkeeperHome(env, app)).toBe(root);
    await writeMap({ [billing]: 'agents/billing' });
    expect(sealkeeperHome(env, app)).toBe(root);
    expect(sealkeeperHome(env, dir)).toBe(root);
  });

  it('resolves a bound folder to its home', async () => {
    await writeMap({ [app]: '.', [billing]: 'agents/billing' });
    expect(sealkeeperHome(env, app)).toBe(root);
    expect(sealkeeperHome(env, billing)).toBe(join(root, 'agents', 'billing'));
  });

  it('tells a folder bound to the root apart from one bound to nothing', async () => {
    expect(boundHome(app, root)).toBeNull();
    await writeMap({ [app]: '.', [billing]: 'agents/billing' });
    expect(boundHome(app, root)).toBe(root);
    expect(boundHome(join(app, 'src', 'deep'), root)).toBe(root);
    expect(boundHome(billing, root)).toBe(join(root, 'agents', 'billing'));
    expect(boundHome(dir, root)).toBeNull();
    // A broken map binds nothing.
    await writeFile(agentsMapPath(root), '{ nope');
    expect(boundHome(app, root)).toBeNull();
  });

  it('lets SEALKEEPER_HOME win over a bound folder', async () => {
    await writeMap({ [billing]: 'agents/billing' });
    expect(
      sealkeeperHome({ ...env, SEALKEEPER_HOME: '/elsewhere' }, billing),
    ).toBe('/elsewhere');
  });

  it('resolves a subfolder by the nearest bound folder above it', async () => {
    await writeMap({ [app]: 'agents/app', [join(app, 'src')]: 'agents/src' });
    expect(sealkeeperHome(env, join(app, 'src', 'deep'))).toBe(
      join(root, 'agents', 'src'),
    );
    expect(sealkeeperHome(env, join(app, 'src'))).toBe(
      join(root, 'agents', 'src'),
    );
    await writeMap({ [app]: 'agents/app' });
    expect(sealkeeperHome(env, join(app, 'src', 'deep'))).toBe(
      join(root, 'agents', 'app'),
    );
  });

  it('resolves a symlinked folder through realpath', async () => {
    await writeMap({ [billing]: 'agents/billing' });
    const link = join(dir, 'link');
    await symlink(billing, link);
    expect(sealkeeperHome(env, link)).toBe(join(root, 'agents', 'billing'));
  });

  it('reads a broken map as empty in the resolver, and refuses it in readFolderMap', async () => {
    expect(await readFolderMap(root)).toEqual({ version: 1, folders: {} });
    await mkdir(root, { recursive: true });
    await writeFile(agentsMapPath(root), '{ nope');
    expect(sealkeeperHome(env, app)).toBe(root);
    await expect(readFolderMap(root)).rejects.toThrow(ConfigError);
    await expect(readFolderMap(root)).rejects.toThrow(/not valid JSON/);
    // A value that is not . or agents/<name> never reaches a path.
    await writeMap({ [app]: '../../etc' });
    expect(sealkeeperHome(env, app)).toBe(root);
    await expect(readFolderMap(root)).rejects.toThrow(ConfigError);
    await expect(readFolderMap(root)).rejects.toThrow(/agents\.json/);
  });

  it('names the root and named homes relative to the root, and nothing else', () => {
    expect(relativeHome(root, root)).toBe('.');
    expect(relativeHome(`${root}/`, root)).toBe('.');
    expect(relativeHome(namedHome('billing', root), root)).toBe(
      'agents/billing',
    );
    expect(relativeHome(join(root, 'agents'), root)).toBeNull();
    expect(relativeHome(join(root, 'agents', 'Bad_Name'), root)).toBeNull();
    expect(relativeHome(join(root, 'agents', 'a', 'b'), root)).toBeNull();
    expect(relativeHome('/elsewhere', root)).toBeNull();
  });

  it('binds and unbinds folders, round trip', async () => {
    const billingHome = namedHome('billing', root);
    expect(await bindFolder(app, root, root)).toBe(app);
    expect(await bindFolder(billing, billingHome, root)).toBe(billing);
    const link = join(dir, 'link');
    await symlink(billing, link);
    // Stored after realpath, so binding through the link rebinds billing.
    expect(await bindFolder(link, billingHome, root)).toBe(billing);
    expect(await readFolderMap(root)).toEqual({
      version: 1,
      folders: { [app]: '.', [billing]: 'agents/billing' },
    });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(agentsMapPath(root))).mode & 0o777).toBe(0o600);
    expect(sealkeeperHome(env, billing)).toBe(billingHome);

    // Rebinding replaces the value.
    await bindFolder(billing, root, root);
    expect((await readFolderMap(root)).folders[billing]).toBe('.');
    await bindFolder(billing, billingHome, root);

    await expect(bindFolder(app, '/elsewhere', root)).rejects.toThrow(
      ConfigError,
    );
    expect(await unbindHome(billingHome, root)).toEqual([billing]);
    expect(await unbindHome(billingHome, root)).toEqual([]);
    expect(await readFolderMap(root)).toEqual({
      version: 1,
      folders: { [app]: '.' },
    });
    expect(await unbindHome(root, root)).toEqual([app]);
    expect(await readdir(root)).toEqual(['agents.json']);
  });

  it('writes nothing when there is nothing to unbind', async () => {
    expect(await unbindHome(namedHome('billing', root), root)).toEqual([]);
    await expect(stat(root)).rejects.toThrow();
  });

  it('lists the default agent first, then named homes in map order, then stale ones', async () => {
    const config = (name: string) => ({
      ...VALID,
      name,
    });
    expect(await listMachineAgents(root)).toEqual([]);

    await writeConfig(config('zeta'), paths(namedHome('zeta', root)));
    await writeConfig(config('alpha'), paths(namedHome('alpha', root)));
    await writeConfig(config('billing'), paths(namedHome('billing', root)));
    // An empty directory under agents/ is not an agent.
    await mkdir(namedHome('empty', root), { recursive: true });
    await bindFolder(billing, namedHome('billing', root), root);
    await bindFolder(join(app, 'src'), namedHome('ghost', root), root);
    await bindFolder(app, namedHome('billing', root), root);

    const listed = await listMachineAgents(root);
    expect(
      listed.map((a) => [a.relative, a.config?.name ?? null, a.folders]),
    ).toEqual([
      ['agents/billing', 'billing', [billing, app]],
      ['agents/ghost', null, [join(app, 'src')]],
      ['agents/alpha', 'alpha', []],
      ['agents/zeta', 'zeta', []],
    ]);
    expect(listed.every((a) => !a.isDefault)).toBe(true);

    // The root shows once it has a config, first and as the default.
    await writeConfig(config('scout'), paths(root));
    const withRoot = await listMachineAgents(root);
    expect(withRoot[0]).toMatchObject({
      home: root,
      relative: '.',
      isDefault: true,
      folders: [],
    });
    expect(withRoot[0]?.config?.name).toBe('scout');
    expect(withRoot).toHaveLength(5);

    // A broken config reads as none.
    await writeFile(paths(namedHome('alpha', root)).config, '{ nope');
    expect(
      (await listMachineAgents(root)).find((a) => a.relative === 'agents/alpha')
        ?.config,
    ).toBeNull();
  });

  it('lists the root when only a folder is bound to it', async () => {
    await bindFolder(app, root, root);
    expect(await listMachineAgents(root)).toEqual([
      {
        home: root,
        relative: '.',
        config: null,
        folders: [app],
        isDefault: true,
      },
    ]);
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
