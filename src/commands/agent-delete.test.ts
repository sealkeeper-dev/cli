// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  base64urlDecode,
  DeleteAgentRequest,
  decodeHeader,
  readAudience,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandPaths } from '../claude-code-command.js';
import { installClaudeCode } from '../claude-code-install.js';
import { hookCommand } from '../claude-code-settings.js';
import { skillPath } from '../claude-code-skill.js';
import {
  agentsMapPath,
  bindFolder,
  LEGACY_FILES,
  namedHome,
  paths,
  readRoutineConfig,
  writeConfig,
  writeNudge,
  writeRoutineConfig,
} from '../config.js';
import { createKey } from '../identity.js';
import { saveOperatorSlug } from '../operator-slug.js';
import { createProgram } from '../program.js';
import { appendRoutine } from '../routine.js';
import { copyPaths } from '../routine-copy.js';
import { jobName, type Runner } from '../routine-scheduler.js';

const API_URL = 'https://api.test';
const DELETE_LINE_START = 'the key and any copies of it, config.json, the log';
// What the hooks of these tests run.
const HOOK = hookCommand(
  '/usr/local/bin/node',
  '/usr/local/lib/node_modules/sealkeeper/dist/index.js',
);

// Every signed payload names the API it is for (VOU-111). The fake takes
// aud off before it parses, and a payload without the right aud fails the
// test that sent it.
const audErrors: unknown[] = [];
const unsigned = (payload: unknown) => {
  const check = readAudience(payload, [API_URL]);
  if (check.result !== 'match') audErrors.push(payload);
  return check.payload;
};
afterEach(() => {
  expect(audErrors.splice(0)).toEqual([]);
});

type RunResult = { code: number; out: string; err: string };
type Call = { method: string; path: string; payload?: DeleteAgentRequest };

// A stand-in for DELETE /v1/agents/:id and GET /v1/agents/:id. The signed
// delete is verified against its kid, which must be the local agent.
class FakeApi {
  calls: Call[] = [];
  errors: string[] = [];
  deleteStatus = 204;
  // What GET by id answers, asked only after a 404 on the delete.
  getStatus = 404;

  constructor(readonly agentId: string) {}

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname };
    this.calls.push(call);
    if (url.pathname !== `/v1/agents/${this.agentId}`) {
      return error(404, 'not_found', 'Not found');
    }
    if (call.method === 'GET') {
      if (this.getStatus === 404) {
        return error(404, 'not_found', 'Agent not found');
      }
      return Response.json({
        id: this.agentId,
        name: 'app',
        version: '1.0.0',
        operator: { login: 'alice' },
        createdAt: '2026-09-23T10:00:00.000Z',
      });
    }
    const { envelope } = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const payload = unsigned(
      (await verify(envelope, base64urlDecode(kid))).payload,
    );
    call.payload = DeleteAgentRequest.parse(payload);
    if (this.deleteStatus === 204) return new Response(null, { status: 204 });
    if (this.deleteStatus === 404) {
      return error(404, 'not_found', 'Agent not found');
    }
    if (this.deleteStatus === 403) {
      return error(403, 'forbidden', 'An agent can only delete itself');
    }
    return error(this.deleteStatus, 'internal', 'Internal error');
  }) as typeof fetch;
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('sealkeeper agent delete', () => {
  let home: string;
  // The Claude Code config dir and the project folder agent delete takes
  // the SealKeeper files out of, and the root whose agents it counts.
  // Never the real ones.
  let elsewhere: string;
  const claudeDir = () => join(elsewhere, 'claude');
  const project = () => join(elsewhere, 'project');
  let agentId: string;
  let api: FakeApi;
  // What the terminal answers. isTTY false means no one could type.
  let input: { isTTY: boolean; answers: string[]; asked: number };
  // The scheduler calls, and the crontab they see.
  let calls: string[];
  let crontab: string;
  const runner: Runner = async (file, args, options) => {
    calls.push([file, ...args].join(' '));
    if (file === 'crontab' && args[0] === '-l') {
      return { code: 0, stdout: crontab, stderr: '' };
    }
    if (file === 'crontab' && args[0] === '-') crontab = options?.input ?? '';
    return { code: 0, stdout: '', stderr: '' };
  };

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({
      routine: {
        fetch: api.fetch,
        run: runner,
        platform: () => 'linux',
        homedir: () => home,
        uid: () => 501,
      },
      agent: {
        fetch: api.fetch,
        claudeDir,
        cwd: project,
        hookCommand: () => HOOK,
        stdin: () => ({
          isTTY: input.isTTY,
          readLine: async () => {
            input.asked++;
            return input.answers.shift() ?? null;
          },
        }),
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
    } catch (e) {
      if (e instanceof CommanderError) return { code: e.exitCode, out, err };
      throw e;
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  // Every file agent delete removes, written as a real run would leave them.
  const localFiles = () => {
    const p = paths(home);
    return [
      p.key,
      p.config,
      p.log,
      p.credential,
      p.wellKnown,
      p.cursor,
      p.cursorOffset,
      p.status,
      ...LEGACY_FILES.map((file) => join(p.home, file)),
      p.sessions,
    ];
  };

  const remaining = async () => {
    const left: string[] = [];
    for (const f of localFiles()) if (await exists(f)) left.push(f);
    return left;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-agent-delete-'));
    elsewhere = await mkdtemp(join(tmpdir(), 'sealkeeper-agent-delete-cc-'));
    await mkdir(project());
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_ROOT', join(elsewhere, 'root'));
    vi.stubEnv('SEALKEEPER_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'app',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    const p = paths(home);
    await mkdir(p.log, { recursive: true });
    await writeFile(p.logFile('2026-09-24'), '{}\n');
    await mkdir(p.sessions, { recursive: true });
    await writeFile(join(p.sessions, 's1'), '1');
    for (const f of [
      p.credential,
      p.wellKnown,
      p.cursor,
      p.cursorOffset,
      p.status,
      ...LEGACY_FILES.map((file) => join(p.home, file)),
    ]) {
      await writeFile(f, '{}');
    }
    api = new FakeApi(agentId);
    input = { isTTY: true, answers: [], asked: 0 };
    calls = [];
    crontab = '0 1 * * * /usr/bin/backup\n';
  });

  afterEach(async () => {
    expect(api.errors).toEqual([]);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('prints what goes, asks for the name, deletes on the server, then the files', async () => {
    expect(await remaining()).toEqual(localFiles());
    input.answers = ['app'];
    const before = Date.now();
    const { code, out, err } = await run('agent', 'delete');
    expect(code).toBe(0);
    expect(input.asked).toBe(1);
    expect(err).toBe('Delete alice/app? Type the name to confirm: ');
    expect(out).toBe(
      [
        'handle           alice/app',
        'profile          https://sealkeeper.run/agents/alice/app',
        'on SealKeeper    the agent, its events, the tasks it posted, its claims, its scores and its SEAL',
        `on this machine  the key and any copies of it, config.json, the log, the routine settings and log, the agent card, the SEAL cache and the well-known cache, in ${home}`,
        'in Claude Code   the SealKeeper hooks, slash commands and skill, when no other agent on this machine is left',
        'deleted alice/app',
        '',
      ].join('\n'),
    );
    expect(api.calls).toEqual([
      {
        method: 'DELETE',
        path: `/v1/agents/${agentId}`,
        payload: { issuedAt: expect.any(String) },
      },
    ]);
    const issuedAt = Date.parse(api.calls[0]?.payload?.issuedAt ?? '');
    expect(issuedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(await remaining()).toEqual([]);
    // The home directory itself stays, empty.
    expect(await readdir(home)).toEqual([]);
  });

  it('names the daily routine job first, then removes it with the rest', async () => {
    const job = 'run.sealkeeper.routine.abc';
    crontab = `0 1 * * * /usr/bin/backup\n# BEGIN ${job} (managed-by: sealkeeper, removed by sealkeeper routine remove)\n0 10 * * * sk routine run\n# END ${job}\n`;
    const p = paths(home);
    await writeRoutineConfig({
      limits: {
        claimsPerDay: 10,
        confirmsPerDay: 10,
        minutesPerRun: 15,
        tokensPerRun: 300_000,
      },
      allow: ['bob'],
      schedule: {
        time: '10:00',
        scheduler: 'cron',
        agent: 'claude-code',
        agentCommand: '/usr/local/bin/claude',
        job,
        files: [],
        installedAt: new Date().toISOString(),
      },
    });
    await writeNudge(true);
    await appendRoutine({
      kind: 'limit',
      runId: 'r1',
      limit: 'minutesPerRun',
      used: 15,
      cap: 15,
    });
    // The last run's transcript goes with the copy (RS-10).
    const transcript = copyPaths(p).transcript;
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, '{"type":"result"}\n');

    input.answers = ['nope'];
    const refused = await run('agent', 'delete');
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(`routine job      the daily cron job ${job}`);
    expect(calls).toEqual([]);
    expect((await readRoutineConfig()).schedule?.job).toBe(job);

    input.answers = ['app'];
    const { code, out } = await run('agent', 'delete');
    expect(code).toBe(0);
    expect(out).toContain('removed the daily routine job');
    expect(crontab).toBe('0 1 * * * /usr/bin/backup\n');
    for (const f of [
      p.routine,
      p.nudge,
      join(home, 'routine.jsonl'),
      transcript,
    ]) {
      expect(await exists(f)).toBe(false);
    }
  });

  it('refuses a name that does not match and sends nothing', async () => {
    for (const answer of ['alice/app', 'App', '']) {
      input.answers = [answer];
      const { code, err } = await run('agent', 'delete');
      expect(code, answer).toBe(1);
      expect(err).toContain('nothing deleted, the name did not match app');
    }
    expect(api.calls).toEqual([]);
    expect(await remaining()).toEqual(localFiles());
  });

  it('refuses without a terminal unless --yes', async () => {
    input.isTTY = false;
    const { code, out, err } = await run('agent', 'delete');
    expect(code).toBe(1);
    expect(out).toContain('handle           alice/app');
    expect(err).toContain(
      'nothing deleted. There is no terminal to ask, so run npx sealkeeper agent delete --yes to delete alice/app',
    );
    expect(input.asked).toBe(0);
    expect(api.calls).toEqual([]);
    expect(await remaining()).toEqual(localFiles());
  });

  it('deletes without asking with --yes', async () => {
    input.isTTY = false;
    const { code, out } = await run('agent', 'delete', '--yes');
    expect(code).toBe(0);
    expect(input.asked).toBe(0);
    expect(out.trim().split('\n').at(-1)).toBe('deleted alice/app');
    expect(api.calls.map((c) => c.method)).toEqual(['DELETE']);
    expect(await remaining()).toEqual([]);
  });

  it('deletes every copy of the key and names each (cli-core-13)', async () => {
    const p = paths(home);
    const bak = join(home, 'key.2026-09-20T10-00-00-000Z.bak');
    const tmp = join(home, `key.${'0'.repeat(8)}.tmp`);
    await writeFile(bak, 'old seed\n');
    await writeFile(tmp, 'seed\n');
    const { code, out } = await run('agent', 'delete', '--yes');
    expect(code).toBe(0);
    expect(out).toContain(
      `deleted the key copy at ${tmp}\ndeleted the key copy at ${bak}\ndeleted alice/app\n`,
    );
    expect(await exists(bak)).toBe(false);
    expect(await exists(tmp)).toBe(false);
    expect(await exists(p.key)).toBe(false);
  });

  it('keeps every local file when the API fails', async () => {
    for (const status of [500, 403]) {
      api.deleteStatus = status;
      const { code, out, err } = await run('agent', 'delete', '--yes');
      expect(code, String(status)).toBe(1);
      expect(out).not.toContain('deleted alice/app');
      expect(err).toContain(
        status === 403
          ? 'the API refused, the key on this machine is not this agent'
          : 'Internal error',
      );
    }
    expect(await remaining()).toEqual(localFiles());
  });

  it('removes the local files when the agent is already gone, and says so', async () => {
    api.deleteStatus = 404;
    const { code, out } = await run('agent', 'delete', '--yes');
    expect(code).toBe(0);
    expect(out).toContain(
      'alice/app was already gone from SealKeeper, removed the files on this machine\ndeleted alice/app\n',
    );
    expect(api.calls.map((c) => c.method)).toEqual(['DELETE', 'GET']);
    expect(await remaining()).toEqual([]);
  });

  it('keeps the files on a 404 when the agent still reads as registered', async () => {
    api.deleteStatus = 404;
    api.getStatus = 200;
    const { code, err } = await run('agent', 'delete', '--yes');
    expect(code).toBe(1);
    expect(err).toContain(
      'the API did not delete the agent and it is still registered, nothing deleted',
    );
    expect(await remaining()).toEqual(localFiles());
  });

  it('prints { handle, deleted } with --json and the summary on stderr', async () => {
    const { code, out, err } = await run('agent', 'delete', '--yes', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      handle: 'alice/app',
      deleted: true,
      keyCopies: [],
      routineJob: null,
      folders: [],
      // No other agent is left, so both settings files were looked at, and
      // neither held anything of SealKeeper's.
      claudeCode: [
        join(claudeDir(), 'settings.json'),
        join(project(), '.claude', 'settings.local.json'),
      ].map((path) => ({
        path,
        removed: 0,
        removedFromShared: 0,
        commands: [],
        skill: false,
      })),
    });
    expect(err).toContain('handle           alice/app');
    expect(await remaining()).toEqual([]);
  });

  it('unbinds the folders of a named home and removes the home once empty', async () => {
    // The agent lives in a named home the current folder is bound to, and
    // no SEALKEEPER_HOME is set, as after init in a project folder.
    const root = join(home, 'root');
    const named = namedHome('app', root);
    await mkdir(named, { recursive: true });
    for (const name of await readdir(home)) {
      if (name !== 'root') await rename(join(home, name), join(named, name));
    }
    await writeFile(join(named, 'background-sync.stamp'), '');
    const project = await realpath(await mkdtemp(join(home, 'project-')));
    const here = await bindFolder(process.cwd(), named, root);
    await bindFolder(project, named, root);
    await bindFolder(join(home), root, root);
    vi.stubEnv('SEALKEEPER_HOME', '');
    vi.stubEnv('SEALKEEPER_ROOT', root);

    const { code, out } = await run('agent', 'delete', '--yes');
    expect(code).toBe(0);
    expect(out).toContain(`on this machine  ${DELETE_LINE_START}`);
    expect(out).toContain(`in ${named}`);
    expect(out).toContain(`folders          ${here}, ${project}`);
    expect(out).toContain(`${here} no longer uses this agent`);
    expect(out).toContain(`${project} no longer uses this agent`);
    expect(out.trim().split('\n').at(-1)).toBe('deleted alice/app');
    expect(await exists(named)).toBe(false);
    // Only the other folder's binding is left.
    expect(JSON.parse(await readFile(agentsMapPath(root), 'utf8'))).toEqual({
      version: 1,
      folders: { [await realpath(home)]: '.' },
    });
  });

  it('lists the unbound folders with --json', async () => {
    const root = join(home, 'root');
    const named = namedHome('app', root);
    await mkdir(named, { recursive: true });
    for (const name of await readdir(home)) {
      if (name !== 'root') await rename(join(home, name), join(named, name));
    }
    const project = await realpath(await mkdtemp(join(home, 'project-')));
    await bindFolder(project, named, root);
    vi.stubEnv('SEALKEEPER_HOME', named);
    vi.stubEnv('SEALKEEPER_ROOT', root);
    const { code, out } = await run('agent', 'delete', '--yes', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out).folders).toEqual([project]);
    expect(await exists(named)).toBe(false);
  });

  it('keeps the root home and deletes with a broken folder map', async () => {
    const root = await realpath(home);
    await writeFile(agentsMapPath(root), '{ nope');
    vi.stubEnv('SEALKEEPER_ROOT', root);
    const { code, out, err } = await run('agent', 'delete', '--yes', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out).folders).toEqual([]);
    expect(err).toContain('could not be unbound');
    expect(await exists(root)).toBe(true);
  });

  it('names the agent by the stored operator slug and removes the slug file', async () => {
    const p = paths(home);
    await saveOperatorSlug(agentId, 'alice-2', new Date(), p);
    const { code, out, err } = await run('agent', 'delete', '--yes', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out).handle).toBe('alice-2/app');
    expect(err).toContain('handle           alice-2/app');
    expect(err).toContain(
      'profile          https://sealkeeper.run/agents/alice-2/app',
    );
    expect(await exists(p.operatorSlug)).toBe(false);
    expect(await remaining()).toEqual([]);
  });

  it('removes the job of this home by name when routine.json names none', async () => {
    // The job name for a home other than ~/.sealkeeper carries a hash.
    const job = jobName(home, join(home, '.sealkeeper'));
    crontab = `# BEGIN ${job} (managed-by: sealkeeper, removed by sealkeeper routine remove)\n0 10 * * * sk routine run\n# END ${job}\n`;
    const { code, out } = await run('agent', 'delete', '--yes', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out).routineJob).toEqual({
      removed: [`crontab entry ${job}`],
      kept: [],
    });
    expect(crontab).toBe('');
  });

  it('says in --json when the routine job could not be removed', async () => {
    const job = jobName(home, join(home, '.sealkeeper'));
    crontab = `# BEGIN ${job} (managed-by: sealkeeper, removed by sealkeeper routine remove)\n0 10 * * * sk routine run\n`;
    const { code, out, err } = await run('agent', 'delete', '--yes', '--json');
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.routineJob).toBeNull();
    expect(json.routineJobError).toContain('crontab -e');
    expect(err).toContain('could not be removed');
  });

  // VOU-603. agent delete runs the Claude Code uninstall init's install is
  // undone by, once no other agent on this machine is left. Only what
  // SealKeeper wrote goes.
  describe('the Claude Code files', () => {
    const userFile = () => join(claudeDir(), 'settings.json');
    const projectFile = () => join(project(), '.claude', 'settings.local.json');
    const FOREIGN = { type: 'command', command: 'other-tool stop' };

    async function installed(file: string): Promise<void> {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({ hooks: { Stop: [{ hooks: [FOREIGN] }] } }),
      );
      await installClaudeCode(file, HOOK, () => {});
    }

    it('go with the last agent, hooks, slash commands and skill, and a foreign hook stays', async () => {
      await installed(userFile());
      await installed(projectFile());
      // A command of the same name the operator wrote stays.
      const [mine = ''] = commandPaths(projectFile());
      await writeFile(mine, 'my own run command\n');
      const { code, out } = await run('agent', 'delete', '--yes');
      expect(code).toBe(0);
      for (const file of [userFile(), projectFile()]) {
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
          hooks: { Stop: [{ hooks: [FOREIGN] }] },
        });
        expect(await exists(skillPath(file))).toBe(false);
        expect(out).toContain(`removed 3 sealkeeper hooks from ${file}\n`);
        expect(out).toContain(
          `removed the sealkeeper skill from ${skillPath(file)}\n`,
        );
      }
      for (const path of commandPaths(userFile())) {
        expect(await exists(path)).toBe(false);
      }
      expect(await readFile(mine, 'utf8')).toBe('my own run command\n');
      expect(out.trim().split('\n').at(-1)).toBe('deleted alice/app');
    });

    it('stay while another agent on this machine is left', async () => {
      await installed(userFile());
      const root = join(elsewhere, 'root');
      await mkdir(root, { recursive: true });
      await writeConfig(
        {
          agentId: `${'B'.repeat(42)}A`,
          operatorLogin: 'alice',
          name: 'other',
          version: '1.0.0',
          registeredAt: new Date().toISOString(),
        },
        paths(root),
      );
      const before = await readFile(userFile(), 'utf8');
      const { code, out } = await run('agent', 'delete', '--yes', '--json');
      expect(code).toBe(0);
      expect(JSON.parse(out).claudeCode).toEqual([]);
      expect(await readFile(userFile(), 'utf8')).toBe(before);
      expect(await exists(skillPath(userFile()))).toBe(true);
    });

    it('are left alone in a project folder that links outside the project', async () => {
      await installed(userFile());
      const outside = join(elsewhere, 'outside');
      await mkdir(outside);
      await installed(join(outside, 'settings.local.json'));
      await symlink(outside, join(project(), '.claude'));
      const { code, err } = await run('agent', 'delete', '--yes', '--json');
      expect(code).toBe(0);
      expect(err).toContain('the Claude Code files were left as they are');
      expect(
        await exists(skillPath(join(outside, 'settings.local.json'))),
      ).toBe(true);
      expect(await exists(skillPath(userFile()))).toBe(false);
    });
  });

  it('says to run init without a config', async () => {
    await rm(join(home, 'config.json'));
    const { code, err } = await run('agent', 'delete', '--yes');
    expect(code).toBe(1);
    expect(err).toContain('not initialised, run npx sealkeeper init');
    expect(api.calls).toEqual([]);
  });
});
