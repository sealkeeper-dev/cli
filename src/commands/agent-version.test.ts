// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  ChangeVersionRequest,
  decodeHeader,
  verify,
} from '@vouched-dev/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, readConfig, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';

const API_URL = 'http://api.test';

type RunResult = { code: number; out: string; err: string };
type Call = { method: string; path: string; payload?: ChangeVersionRequest };

// A stand-in for GET and PATCH /v1/agents/:id. A signed change is verified
// against its kid, which must be the local agent, and moves the version it
// holds, as the real API does.
class FakeApi {
  calls: Call[] = [];
  errors: string[] = [];
  reply: ((payload: ChangeVersionRequest) => Response) | null = null;

  constructor(
    readonly agentId: string,
    public version = '1.0.0',
  ) {}

  agent() {
    return {
      id: this.agentId,
      name: 'scout',
      version: this.version,
      operator: { login: 'carelmeyer' },
      createdAt: '2026-09-23T10:00:00.000Z',
      handle: 'carelmeyer/scout',
    };
  }

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname };
    this.calls.push(call);
    if (url.pathname !== `/v1/agents/${this.agentId}`) {
      return error(404, 'not_found', 'Agent not found');
    }
    if (call.method === 'GET') return Response.json(this.agent());
    const { envelope } = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const { payload } = await verify(envelope, base64urlDecode(kid));
    call.payload = ChangeVersionRequest.parse(payload);
    if (this.reply) return this.reply(call.payload);
    this.version = call.payload.version;
    return Response.json(this.agent());
  }) as typeof fetch;
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('vouched agent version', () => {
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
    home = await mkdtemp(join(tmpdir(), 'vouched-agent-version-'));
    vi.stubEnv('VOUCHED_HOME', home);
    vi.stubEnv('VOUCHED_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'carelmeyer',
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

  it('signs the change, stores the version and prints old, new and what carries over', async () => {
    // A cached SEAL names the old version, so it has to go.
    await writeFile(paths(home).credential, '{"v":1}\n');
    const before = Date.now();
    const { code, out, err } = await run('agent', 'version', '2.0.0');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(api.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(api.calls[1]?.payload).toEqual({
      version: '2.0.0',
      issuedAt: expect.any(String),
    });
    const issuedAt = Date.parse(api.calls[1]?.payload?.issuedAt ?? '');
    expect(issuedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(out).toBe(
      [
        'old version  1.0.0',
        'new version  2.0.0',
        "2.0.0 starts from half of 1.0.0's counts, with its level capped one below 1.0.0's, and earns the rest on its own record",
        '',
      ].join('\n'),
    );
    expect((await readConfig())?.version).toBe('2.0.0');
    await expect(readFile(paths(home).credential, 'utf8')).rejects.toThrow();
  });

  it('prints JSON with --json', async () => {
    const { code, out } = await run('agent', 'version', '2.0.0', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      agentId,
      previousVersion: '1.0.0',
      version: '2.0.0',
      changed: true,
    });
  });

  it('says nothing changed for the version Vouched already has', async () => {
    const { code, out } = await run('agent', 'version', '1.0.0');
    expect(code).toBe(0);
    expect(out).toBe('already on version 1.0.0, nothing changed\n');
  });

  it('says config.json was set when only this machine differed', async () => {
    api.version = '2.0.0';
    const { code, out } = await run('agent', 'version', '2.0.0');
    expect(code).toBe(0);
    expect(out).toBe(
      'Vouched is already on version 2.0.0, set config.json from 1.0.0 to 2.0.0\n',
    );
    expect((await readConfig())?.version).toBe('2.0.0');
  });

  it('names the version Vouched had as the old one', async () => {
    api.version = '0.9.0';
    const { code, out } = await run('agent', 'version', '2.0.0');
    expect(code).toBe(0);
    expect(out).toContain('old version  0.9.0');
  });

  it('refuses an invalid version before signing or sending', async () => {
    for (const version of ['', 'x'.repeat(33)]) {
      const { code, err } = await run('agent', 'version', version);
      expect(code, version).toBe(1);
      expect(err).toContain('invalid agent version, use 1 to 32 characters');
    }
    expect(api.calls).toEqual([]);
    expect((await readConfig())?.version).toBe('1.0.0');
  });

  it('keeps the old version on a refusal, one line each', async () => {
    api.reply = () =>
      new Response(
        JSON.stringify({
          error: { code: 'rate_limited', message: 'Too many requests' },
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        },
      );
    const limited = await run('agent', 'version', '2.0.0');
    expect(limited.code).toBe(1);
    expect(limited.err).toContain('too many requests, try again in 60 seconds');

    api.reply = () => error(409, 'stale_version', 'stale');
    const stale = await run('agent', 'version', '2.0.0');
    expect(stale.code).toBe(1);
    expect(stale.err).toContain(
      'a newer version change of this agent is already stored',
    );
    expect((await readConfig())?.version).toBe('1.0.0');
  });
});
