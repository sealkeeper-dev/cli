// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_URL, paths, readConfig, writeConfig } from './config.js';
import {
  HomeMigrationError,
  migrateHome,
  migrationPlan,
  movedLine,
} from './home-migration.js';
import { emit } from './lib.js';
import { createProgram } from './program.js';

const AGENT_ID = 'A'.repeat(43);
const KEY = 'private key bytes';
const LOG_LINE = '{"event_id":"e1"}\n';
const CURSOR = '{"v":1,"line":3}\n';

// The layout an older vouched package leaves in its home.
async function oldHome(dir: string): Promise<void> {
  await writeConfig(
    {
      agentId: AGENT_ID,
      operatorLogin: 'carelmeyer',
      name: 'scout',
      version: '1.0.0',
      registeredAt: '2026-09-23T10:00:00.000Z',
    },
    paths(dir),
  );
  await writeFile(join(dir, 'key'), KEY, { mode: 0o600 });
  await mkdir(join(dir, 'log'), { recursive: true });
  await writeFile(join(dir, 'log', '2026-09-23.jsonl'), LOG_LINE);
  await writeFile(join(dir, 'cursor.json'), CURSOR);
  await mkdir(join(dir, 'sessions'), { recursive: true });
}

// Every file under dir with its content and mode, to show a directory was
// left exactly as it was.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    const full = join(entry.parentPath, entry.name);
    const mode = ((await stat(full)).mode & 0o777).toString(8);
    out[full.slice(dir.length)] = entry.isFile()
      ? `${mode} ${await readFile(full, 'utf8')}`
      : `${mode} dir`;
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('migrationPlan', () => {
  it('copies ~/.vouched to ~/.sealkeeper when no env is set', () => {
    expect(migrationPlan({}, '/u')).toEqual({
      from: '/u/.vouched',
      to: '/u/.sealkeeper',
    });
  });

  it('never picks up ~/.vouched for a SEALKEEPER_HOME set on purpose', () => {
    expect(migrationPlan({ SEALKEEPER_HOME: '/s' }, '/u')).toBeNull();
  });

  it('copies VOUCHED_HOME to SEALKEEPER_HOME when both are set', () => {
    expect(
      migrationPlan({ SEALKEEPER_HOME: '/s', VOUCHED_HOME: '/v' }, '/u'),
    ).toEqual({ from: '/v', to: '/s' });
    expect(
      migrationPlan({ SEALKEEPER_HOME: '/s', VOUCHED_HOME: '/s' }, '/u'),
    ).toBeNull();
  });

  it('moves nothing when only VOUCHED_HOME is set, that is the home', () => {
    expect(migrationPlan({ VOUCHED_HOME: '/v' }, '/u')).toBeNull();
  });
});

describe('migrateHome', () => {
  let root: string;
  let from: string;
  let to: string;
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-migrate-'));
    from = join(root, '.vouched');
    to = join(root, '.sealkeeper');
    lines = [];
  });

  afterEach(async () => {
    await chmod(join(from, 'log', '2026-09-23.jsonl'), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('copies the old home across with the key at 0600 and says so once', async () => {
    await oldHome(from);
    const before = await snapshot(from);

    expect(await migrateHome(from, to, log)).toBe(true);
    expect(lines).toEqual([movedLine(from, to)]);
    expect(lines[0]).toBe(
      `settings moved from ${from} to ${to}, the key and registration carry over`,
    );

    expect(await readFile(join(to, 'key'), 'utf8')).toBe(KEY);
    expect((await stat(join(to, 'key'))).mode & 0o777).toBe(0o600);
    expect((await stat(to)).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(await readFile(join(to, 'config.json'), 'utf8')),
    ).toMatchObject({ agentId: AGENT_ID, name: 'scout' });
    expect(await readFile(join(to, 'log', '2026-09-23.jsonl'), 'utf8')).toBe(
      LOG_LINE,
    );
    expect(await readFile(join(to, 'cursor.json'), 'utf8')).toBe(CURSOR);
    expect(await exists(join(to, 'sessions'))).toBe(true);

    // The old home is untouched.
    expect(await snapshot(from)).toEqual(before);
    // No temp directory is left next to the new home.
    expect((await readdir(root)).sort()).toEqual(['.sealkeeper', '.vouched']);

    // A second run finds the new home and does nothing.
    expect(await migrateHome(from, to, log)).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('leaves both alone when the new home already exists', async () => {
    await oldHome(from);
    await mkdir(to);
    await writeFile(join(to, 'key'), 'newer key', { mode: 0o600 });
    const before = await snapshot(from);

    expect(await migrateHome(from, to, log)).toBe(false);
    expect(lines).toEqual([]);
    expect(await readFile(join(to, 'key'), 'utf8')).toBe('newer key');
    expect(await readdir(to)).toEqual(['key']);
    expect(await snapshot(from)).toEqual(before);
  });

  it('maps the old default API URL in a moved config to the new one', async () => {
    await oldHome(from);
    const file = join(from, 'config.json');
    for (const old of ['https://api.vouched.run', 'https://api.vouched.run/']) {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...raw, apiUrl: old }));
      await rm(to, { recursive: true, force: true });

      expect(await migrateHome(from, to, log)).toBe(true);
      expect((await readConfig(paths(to)))?.apiUrl).toBe(DEFAULT_API_URL);
      expect(DEFAULT_API_URL).toBe('https://api.sealkeeper.run');
    }
  });

  it('keeps a custom API URL in a moved config', async () => {
    await oldHome(from);
    const file = join(from, 'config.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(
      file,
      JSON.stringify({ ...raw, apiUrl: 'http://localhost:8787' }),
    );

    expect(await migrateHome(from, to, log)).toBe(true);
    expect((await readConfig(paths(to)))?.apiUrl).toBe('http://localhost:8787');
  });

  it('does nothing when there is no old home', async () => {
    expect(await migrateHome(from, to, log)).toBe(false);
    expect(lines).toEqual([]);
    expect(await exists(to)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    'a copy that fails part way leaves no new home and the old one intact',
    async () => {
      await oldHome(from);
      const before = await snapshot(from);
      // A log file the copy cannot read, after the key and config are copied.
      await chmod(join(from, 'log', '2026-09-23.jsonl'), 0o000);

      const error = await migrateHome(from, to, log).catch((e) => e);
      expect(error).toBeInstanceOf(HomeMigrationError);
      expect((error as Error).message).toContain(`${from} is unchanged`);
      expect(lines).toEqual([]);
      expect(await exists(to)).toBe(false);
      expect(await readdir(root)).toEqual(['.vouched']);

      await chmod(join(from, 'log', '2026-09-23.jsonl'), 0o644);
      expect(await readFile(join(from, 'key'), 'utf8')).toBe(KEY);
      expect(
        await readFile(join(from, 'log', '2026-09-23.jsonl'), 'utf8'),
      ).toBe(LOG_LINE);
      expect(await snapshot(from)).toEqual(before);

      // Once the cause is fixed the next run moves it.
      expect(await migrateHome(from, to, log)).toBe(true);
    },
  );
});

describe('every command migrates before it reads config', () => {
  let root: string;

  function throwOnExit(cmd: Command): void {
    cmd.exitOverride();
    for (const sub of cmd.commands) throwOnExit(sub);
  }

  async function run(
    ...args: string[]
  ): Promise<{ code: number; out: string; err: string }> {
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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-home-'));
    // os.homedir() reads HOME, so ~ is this temp directory.
    vi.stubEnv('HOME', root);
    vi.stubEnv('SEALKEEPER_HOME', '');
    vi.stubEnv('VOUCHED_HOME', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await chmod(join(root, '.vouched', 'log', '2026-09-23.jsonl'), 0o644).catch(
      () => {},
    );
    await rm(root, { recursive: true, force: true });
  });

  it('whoami on the first run after the rename reads the moved config', async () => {
    await oldHome(join(root, '.vouched'));
    const { code, out, err } = await run('whoami');
    expect(code).toBe(0);
    expect(out).toContain('carelmeyer/scout');
    expect(err).toBe(
      `${movedLine(join(root, '.vouched'), join(root, '.sealkeeper'))}\n`,
    );
    const again = await run('whoami');
    expect(again.err).toBe('');
  });

  it.skipIf(process.getuid?.() === 0)(
    'a failed copy stops the command with exit 1 and writes nothing new',
    async () => {
      await oldHome(join(root, '.vouched'));
      await chmod(join(root, '.vouched', 'log', '2026-09-23.jsonl'), 0o000);
      const { code, out, err } = await run('whoami');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('could not copy the settings from');
      expect(await exists(join(root, '.sealkeeper'))).toBe(false);
    },
  );

  it('--help and --version never touch the disk', async () => {
    await oldHome(join(root, '.vouched'));
    await run('--version');
    await run('--help');
    expect(await exists(join(root, '.sealkeeper'))).toBe(false);
  });

  it('emit from the library migrates before it appends', async () => {
    await oldHome(join(root, '.vouched'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await emit({ type: 'session.start', payload: { session_id: 's1' } });
    vi.restoreAllMocks();
    expect(await readFile(join(root, '.sealkeeper', 'key'), 'utf8')).toBe(KEY);
    const logs = await readdir(join(root, '.sealkeeper', 'log'));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});
