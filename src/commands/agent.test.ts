// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  RenameAgentRequest,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';

const API_URL = 'https://api.test';

type RunResult = { code: number; out: string; err: string };

// A stand-in for PATCH /v1/agents/:id. A signed rename is verified against
// its kid, which must be the local agent and the agent in the path.
class FakeApi {
  calls: { method: string; path: string; payload?: RenameAgentRequest }[] = [];
  errors: string[] = [];
  reply: ((payload: RenameAgentRequest) => Response) | null = null;

  constructor(readonly agentId: string) {}

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const call: { method: string; path: string; payload?: RenameAgentRequest } =
      { method: init?.method ?? 'GET', path: url.pathname };
    this.calls.push(call);
    if (url.pathname !== `/v1/agents/${this.agentId}`) {
      return error(404, 'not_found', 'Agent not found');
    }
    const { envelope } = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const { payload } = await verify(envelope, base64urlDecode(kid));
    call.payload = RenameAgentRequest.parse(payload);
    if (this.reply) return this.reply(call.payload);
    return Response.json({
      id: this.agentId,
      name: call.payload.name,
      version: '1.0.0',
      operator: { login: 'alice' },
      createdAt: '2026-09-23T10:00:00.000Z',
      operatedByVouched: false,
      handle: `alice/${call.payload.name}`,
      previousName: 'scout',
    });
  }) as typeof fetch;
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('sealkeeper agent rename', () => {
  let home: string;
  let agentId: string;
  let api: FakeApi;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({ agent: { fetch: api.fetch } });
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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-agent-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    api = new FakeApi(agentId);
  });

  afterEach(async () => {
    expect(api.errors).toEqual([]);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('signs the rename, stores the new name and prints the handle and URL', async () => {
    const before = Date.now();
    const { code, out, err } = await run('agent', 'rename', 'ranger');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(api.calls).toEqual([
      {
        method: 'PATCH',
        path: `/v1/agents/${agentId}`,
        payload: { name: 'ranger', issuedAt: expect.any(String) },
      },
    ]);
    const issuedAt = Date.parse(api.calls[0]?.payload?.issuedAt ?? '');
    expect(issuedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(out).toBe(
      [
        'handle   alice/ranger',
        'profile  https://sealkeeper.run/agents/alice/ranger',
        '',
      ].join('\n'),
    );
    expect((await readConfig())?.name).toBe('ranger');
  });

  it('prints JSON with --json', async () => {
    const { code, out } = await run('agent', 'rename', 'ranger', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      agentId,
      handle: 'alice/ranger',
      profileUrl: 'https://sealkeeper.run/agents/alice/ranger',
    });
  });

  it('refuses an invalid name before signing or sending', async () => {
    for (const name of ['Ranger', 'my agent', 'x', 'a--b', 'admin']) {
      const { code, err } = await run('agent', 'rename', name);
      expect(code, name).toBe(1);
      expect(err).toContain(`invalid agent name ${name}`);
    }
    expect(api.calls).toEqual([]);
    expect((await readConfig())?.name).toBe('scout');
  });

  it('prints the API message on a clash and keeps the old name', async () => {
    api.reply = () =>
      error(409, 'name_taken', 'alice/claude-code is taken, try claude-code-2');
    const { code, out, err } = await run('agent', 'rename', 'claude-code');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('alice/claude-code is taken, try claude-code-2');
    expect((await readConfig())?.name).toBe('scout');
  });

  it('says to run init without a config', async () => {
    await rm(join(home, 'config.json'));
    const { code, err } = await run('agent', 'rename', 'ranger');
    expect(code).toBe(1);
    expect(err).toContain('not initialised, run npx sealkeeper init');
    expect(api.calls).toEqual([]);
  });
});
