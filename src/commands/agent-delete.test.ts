// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  DeleteAgentRequest,
  decodeHeader,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';

const API_URL = 'https://api.test';

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
        operator: { login: 'carelmeyer' },
        createdAt: '2026-09-23T10:00:00.000Z',
      });
    }
    const { envelope } = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const { payload } = await verify(envelope, base64urlDecode(kid));
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
  let agentId: string;
  let api: FakeApi;
  // What the terminal answers. isTTY false means no one could type.
  let input: { isTTY: boolean; answers: string[]; asked: number };

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({
      agent: {
        fetch: api.fetch,
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
      p.score,
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
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'carelmeyer',
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
    for (const f of [p.credential, p.wellKnown, p.cursor, p.score]) {
      await writeFile(f, '{}');
    }
    api = new FakeApi(agentId);
    input = { isTTY: true, answers: [], asked: 0 };
  });

  afterEach(async () => {
    expect(api.errors).toEqual([]);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('prints what goes, asks for the name, deletes on the server, then the files', async () => {
    expect(await remaining()).toEqual(localFiles());
    input.answers = ['app'];
    const before = Date.now();
    const { code, out, err } = await run('agent', 'delete');
    expect(code).toBe(0);
    expect(input.asked).toBe(1);
    expect(err).toBe('Delete carelmeyer/app? Type the name to confirm: ');
    expect(out).toBe(
      [
        'handle           carelmeyer/app',
        'profile          https://sealkeeper.run/agents/carelmeyer/app',
        'on SealKeeper    the agent, its events, the tasks it posted, its claims, its scores and its SEAL',
        `on this machine  the key, config.json, the log, the SEAL cache and the well-known cache, in ${home}`,
        'deleted carelmeyer/app',
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

  it('refuses a name that does not match and sends nothing', async () => {
    for (const answer of ['carelmeyer/app', 'App', '']) {
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
    expect(out).toContain('handle           carelmeyer/app');
    expect(err).toContain(
      'nothing deleted. There is no terminal to ask, so run npx sealkeeper agent delete --yes to delete carelmeyer/app',
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
    expect(out.trim().split('\n').at(-1)).toBe('deleted carelmeyer/app');
    expect(api.calls.map((c) => c.method)).toEqual(['DELETE']);
    expect(await remaining()).toEqual([]);
  });

  it('keeps every local file when the API fails', async () => {
    for (const status of [500, 403]) {
      api.deleteStatus = status;
      const { code, out, err } = await run('agent', 'delete', '--yes');
      expect(code, String(status)).toBe(1);
      expect(out).not.toContain('deleted carelmeyer/app');
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
      'carelmeyer/app was already gone from SealKeeper, removed the files on this machine\ndeleted carelmeyer/app\n',
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
      handle: 'carelmeyer/app',
      deleted: true,
    });
    expect(err).toContain('handle           carelmeyer/app');
    expect(await remaining()).toEqual([]);
  });

  it('says to run init without a config', async () => {
    await rm(join(home, 'config.json'));
    const { code, err } = await run('agent', 'delete', '--yes');
    expect(code).toBe(1);
    expect(err).toContain('not initialised, run npx sealkeeper init');
    expect(api.calls).toEqual([]);
  });
});
