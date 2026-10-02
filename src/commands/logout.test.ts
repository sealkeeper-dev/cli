// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentsMapPath,
  bindFolder,
  LEGACY_POST_PROMPT_FILE,
  namedHome,
  type Paths,
  paths,
  readRoutineConfig,
  writeConfig,
  writeRoutineConfig,
} from '../config.js';
import { createKey, loadKey } from '../identity.js';
import { appendEvent, writeCursor } from '../log.js';
import { saveOperatorSlug } from '../operator-slug.js';
import { createProgram } from '../program.js';
import { copyPaths } from '../routine-copy.js';
import { jobName, launchdPath, type Runner } from '../routine-scheduler.js';

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

// The scheduler calls the routine job removal makes, as file and args.
const calls: string[] = [];
const runner: Runner = async (file, args) => {
  calls.push([file, ...args].join(' '));
  return { code: 0, stdout: '', stderr: '' };
};

async function run(...args: string[]): Promise<RunResult> {
  const program = createProgram({
    routine: {
      fetch: (() => {
        throw new Error('no network');
      }) as unknown as typeof fetch,
      run: runner,
      platform: () => 'darwin',
      homedir: () => paths().home,
      uid: () => 501,
    },
  });
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

  // A full local session. Config, key, cursor, credential, score, inbox,
  // the post prompt time and a log.
  async function initialise(): Promise<void> {
    ({ agentId } = (await loadKey(p)) ?? (await createKey({}, p)));
    await writeConfig(
      {
        agentId,
        operatorLogin: 'alice',
        name: 'scout',
        version: '1.0.0',
        registeredAt: '2026-09-23T08:00:00Z',
      },
      p,
    );
    await writeCursor({ v: 1, lastAcked: null }, p);
    await writeFile(p.credential, '{}\n');
    await writeFile(p.score, '{}\n');
    await writeFile(p.inbox, '{}\n');
    await writeFile(join(p.home, LEGACY_POST_PROMPT_FILE), '{}\n');
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

  const SESSION = () => [
    p.config,
    p.credential,
    p.score,
    p.inbox,
    join(p.home, LEGACY_POST_PROMPT_FILE),
  ];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-logout-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    p = paths(home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('removes the session files and keeps the key, the log and the cursor', async () => {
    await initialise();
    const { code, out, err } = await run('logout');
    expect(code).toBe(0);
    expect(err).toBe('');
    for (const file of SESSION()) expect(await exists(file)).toBe(false);
    expect(await exists(p.key)).toBe(true);
    expect(await exists(p.cursor)).toBe(true);
    expect(await readdir(p.log)).toHaveLength(1);
    expect(out).toContain(
      'logged out, removed credential.json, score.json, inbox.json, post-prompt.json, config.json',
    );
    expect(out).toContain(`kept the key at ${p.key}`);
    expect(out).toContain('run npx sealkeeper init to sign in again');
  });

  it('--delete-key without --yes deletes nothing and exits 1', async () => {
    await initialise();
    const { code, out, err } = await run('logout', '--delete-key');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain(`--delete-key would delete the key at ${p.key}`);
    expect(err).toContain(agentId);
    expect(err).toContain(
      'Nothing was deleted. Run npx sealkeeper logout --delete-key --yes to go ahead.',
    );
    for (const file of [...SESSION(), p.key]) {
      expect(await exists(file)).toBe(true);
    }
  });

  it('--delete-key --yes removes the key, the cursor and the log too (cli-core-6)', async () => {
    await initialise();
    const { code, out } = await run('logout', '--delete-key', '--yes');
    expect(code).toBe(0);
    for (const file of [...SESSION(), p.key, p.cursor, p.log]) {
      expect(await exists(file)).toBe(false);
    }
    expect(out).toContain(`the identity of agent ${agentId} is gone for good`);
    expect(out).toContain(`deleted the log at ${p.log}\n`);
  });

  it('--delete-key --yes removes every copy of the key and names each (cli-core-13)', async () => {
    await initialise();
    // Two forced keys leave the first two behind as backups.
    const first = await createKey({ force: true }, p);
    await new Promise((done) => setTimeout(done, 5));
    const second = await createKey({ force: true }, p);
    const tmp = `${p.key}.${randomUUID()}.tmp`;
    await writeFile(tmp, 'seed\n');
    // Not a copy of the key, so it stays.
    await writeFile(join(home, 'keyring.bak'), 'other\n');
    const copies = [first.backup, second.backup, tmp].sort();
    const { code, out } = await run(
      'logout',
      '--delete-key',
      '--yes',
      '--json',
    );
    expect(code).toBe(0);
    const printed = JSON.parse(out);
    expect(printed.keyCopies).toEqual(copies);
    expect(printed.removed).toEqual(
      expect.arrayContaining([
        'key',
        ...copies.map((c) => c?.slice(home.length + 1)),
      ]),
    );
    for (const file of copies) expect(await exists(String(file))).toBe(false);
    expect(await exists(join(home, 'keyring.bak'))).toBe(true);

    await initialise();
    const again = await createKey({ force: true }, p);
    const text = await run('logout', '--delete-key', '--yes');
    expect(text.out).toContain(`deleted the key copy at ${again.backup}\n`);
    expect(await exists(String(again.backup))).toBe(false);
  });

  it('removes the stored operator slug', async () => {
    await initialise();
    await saveOperatorSlug(agentId, 'alice-2', new Date(), p);
    const { code, out } = await run('logout', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out).removed).toContain('operator-slug.json');
    expect(await exists(p.operatorSlug)).toBe(false);
  });

  it('keeps the cursor offset file with the key, and removes it with the key', async () => {
    await initialise();
    await writeFile(p.cursorOffset, '{}\n');
    const kept = await run('logout', '--json');
    expect(kept.code).toBe(0);
    expect(JSON.parse(kept.out).removed).not.toContain('cursor-offset.json');
    expect(await exists(p.cursorOffset)).toBe(true);

    await initialise();
    await writeFile(p.cursorOffset, '{}\n');
    const { code, out } = await run(
      'logout',
      '--delete-key',
      '--yes',
      '--json',
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).removed).toContain('cursor-offset.json');
    expect(await exists(p.cursorOffset)).toBe(false);
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
      removed: ['score.json', 'inbox.json', 'post-prompt.json', 'config.json'],
      keyDeleted: false,
      routineJob: null,
      folders: [],
    });
    expect(calls).toEqual([]);
  });

  it('removes the job of this home by name without routine.json', async () => {
    await initialise();
    calls.length = 0;
    const env = { platform: 'darwin' as const, homedir: p.home, uid: 501 };
    // The job name for a home other than ~/.sealkeeper carries a hash.
    const job = jobName(p.home, join(p.home, '.sealkeeper'));
    const plist = launchdPath(job, env);
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, '<?xml?>\n<!-- managed-by: sealkeeper -->\n');
    const { code, out } = await run('logout', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out).routineJob).toEqual({ removed: [plist], kept: [] });
    expect(calls).toEqual([`launchctl bootout gui/501/${job}`]);
  });

  it('says the job was kept, and keeps it recorded, when none of it is ours', async () => {
    await initialise();
    const env = { platform: 'darwin' as const, homedir: p.home, uid: 501 };
    const job = 'run.sealkeeper.routine';
    const plist = launchdPath(job, env);
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, '<plist/>\n');
    await writeRoutineConfig(
      {
        limits: {
          claimsPerDay: 10,
          confirmsPerDay: 10,
          minutesPerRun: 15,
          tokensPerRun: 300_000,
        },
        allow: [],
        schedule: {
          time: '10:00',
          scheduler: 'launchd',
          agent: 'claude-code',
          agentCommand: '/usr/local/bin/claude',
          job,
          files: [plist],
          installedAt: new Date().toISOString(),
        },
      },
      p,
    );
    const { code, out } = await run('logout');
    expect(code).toBe(0);
    expect(out).not.toContain('removed the daily routine job');
    expect(out).toContain('the daily routine job was kept');
    expect(await exists(plist)).toBe(true);
    expect((await readRoutineConfig(p)).schedule?.job).toBe(job);
  });

  it('removes the daily routine job and says so, keeping the allowlist', async () => {
    await initialise();
    calls.length = 0;
    const env = { platform: 'darwin' as const, homedir: p.home, uid: 501 };
    const job = 'run.sealkeeper.routine';
    const plist = launchdPath(job, env);
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, '<?xml?>\n<!-- managed-by: sealkeeper -->\n');
    await writeRoutineConfig(
      {
        limits: {
          claimsPerDay: 10,
          confirmsPerDay: 10,
          minutesPerRun: 15,
          tokensPerRun: 300_000,
        },
        allow: ['bob'],
        schedule: {
          time: '10:00',
          scheduler: 'launchd',
          agent: 'claude-code',
          agentCommand: '/usr/local/bin/claude',
          job,
          files: [plist],
          installedAt: new Date().toISOString(),
        },
      },
      p,
    );
    // The last run's transcript goes with the copy (RS-10).
    const transcript = copyPaths(p).transcript;
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, '{"type":"result"}\n');
    const { code, out } = await run('logout');
    expect(code).toBe(0);
    expect(out).toContain('removed the daily routine job');
    expect(out).toContain(`removed ${transcript}`);
    expect(calls).toEqual([`launchctl bootout gui/501/${job}`]);
    expect(await exists(plist)).toBe(false);
    expect(await exists(transcript)).toBe(false);
    const routine = await readRoutineConfig(p);
    expect(routine.schedule).toBeUndefined();
    expect(routine.allow).toEqual(['bob']);
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
      `deleted the key at ${p.key}, the identity of this agent is gone for good\ndeleted the log at ${p.log}\n`,
    );
    expect(await exists(p.key)).toBe(false);
    expect(await exists(p.log)).toBe(false);
    expect(await exists(p.cursor)).toBe(false);
  });

  describe('in a named home', () => {
    let root: string;
    let project: string;

    // The agent in agents/scout under a temp root, with a project folder
    // bound to it, and no SEALKEEPER_HOME.
    beforeEach(async () => {
      root = join(home, 'root');
      p = paths(namedHome('scout', root));
      project = await realpath(await mkdtemp(join(home, 'project-')));
      vi.stubEnv('SEALKEEPER_HOME', p.home);
      vi.stubEnv('SEALKEEPER_ROOT', root);
      await initialise();
      await bindFolder(project, p.home, root);
    });

    const mapped = async () =>
      JSON.parse(await readFile(agentsMapPath(root), 'utf8')).folders;

    it('plain logout keeps the folder bound', async () => {
      const { code, out } = await run('logout', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).folders).toEqual([]);
      expect(await mapped()).toEqual({ [project]: 'agents/scout' });
    });

    it('--delete-key --yes unbinds the folder, says so and removes the empty home', async () => {
      const { code, out } = await run('logout', '--delete-key', '--yes');
      expect(code).toBe(0);
      expect(out).toContain(`${project} no longer uses this agent`);
      expect(await mapped()).toEqual({});
      // The key, the log and the cursor went with it, so nothing is left
      // and the named home goes too.
      await expect(readdir(p.home)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('--delete-key --yes removes the home once nothing is left in it', async () => {
      await rm(p.log, { recursive: true });
      const { code, out } = await run(
        'logout',
        '--delete-key',
        '--yes',
        '--json',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).folders).toEqual([project]);
      expect(await exists(p.home)).toBe(false);
    });

    it('after a plain logout, --delete-key --yes still unbinds', async () => {
      expect((await run('logout')).code).toBe(0);
      const { code, out } = await run('logout', '--delete-key', '--yes');
      expect(code).toBe(0);
      expect(out).toContain(`${project} no longer uses this agent`);
      expect(await mapped()).toEqual({});
    });
  });

  it('without config, --delete-key alone refuses as before a logout and keeps the key (VOU-300)', async () => {
    await initialise();
    expect((await run('logout')).code).toBe(0);
    const { code, out, err } = await run('logout', '--delete-key');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe(
      [
        `--delete-key would delete the key at ${p.key}, any copies of it and the log at ${p.log} along with the local session.`,
        'The identity of this agent would be gone for good and its track record could not be extended.',
        'Nothing was deleted. Run npx sealkeeper logout --delete-key --yes to go ahead.',
        '',
      ].join('\n'),
    );
    expect(await exists(p.key)).toBe(true);
    expect(await exists(p.log)).toBe(true);
  });

  it('without config or key, --delete-key alone says there is nothing to log out', async () => {
    const { code, out } = await run('logout', '--delete-key');
    expect(code).toBe(0);
    expect(out).toBe('not initialised, nothing to log out\n');
  });
});
