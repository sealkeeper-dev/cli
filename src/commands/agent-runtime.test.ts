// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  readAudience,
  UpdateAgentRequest,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wasAskedRuntime } from '../agent-runtime.js';
import { writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import { takePurpose } from '../test-purpose.js';

const API_URL = 'https://api.test';

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('sealkeeper agent runtime', () => {
  let home: string;
  let agentId: string;
  let patches: UpdateAgentRequest[];
  let refusal: Response | null;

  // PATCH /v1/agents/:id. The envelope is verified against its kid, which
  // must be the local agent, and signed for this API.
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url !== `${API_URL}/v1/agents/${agentId}` || init?.method !== 'PATCH') {
      throw new TypeError('fetch failed');
    }
    const { envelope } = JSON.parse(String(init.body)) as { envelope: string };
    const { kid } = decodeHeader(envelope);
    expect(kid).toBe(agentId);
    const check = readAudience(
      (await verify(envelope, base64urlDecode(kid))).payload,
      [API_URL],
    );
    expect(check.result).toBe('match');
    const named = takePurpose(check.payload, 'PATCH', url);
    expect(named.ok).toBe(true);
    const payload = UpdateAgentRequest.parse(named.payload);
    patches.push(payload);
    if (refusal !== null) return refusal;
    return Response.json({
      id: agentId,
      name: 'scout',
      version: '1.0.0',
      operator: { login: 'alice', slug: 'alice', displayName: 'alice' },
      createdAt: '2026-09-23T10:00:00.000Z',
      handle: 'alice/scout',
      previousName: null,
      runtime: payload.runtime,
    });
  }) as typeof fetch;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({ agent: { fetch: fetchFn } });
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
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-agent-runtime-'));
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
    patches = [];
    refusal = null;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('sends the runtime signed and counts as the question answered', async () => {
    const result = await run('agent', 'runtime', 'Gemini-CLI');
    expect(result.code).toBe(0);
    expect(result.out).toBe('runtime set to Gemini CLI\n');
    expect(patches).toEqual([
      { runtime: 'gemini-cli', issuedAt: expect.any(String) },
    ]);
    expect(await wasAskedRuntime(agentId)).toBe(true);
  });

  it('prints JSON with --json', async () => {
    const result = await run('agent', 'runtime', 'codex', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ agentId, runtime: 'codex' });
  });

  it('refuses a runtime that is not one before anything is signed', async () => {
    const result = await run('agent', 'runtime', 'cursor-agent');
    expect(result.code).toBe(1);
    expect(result.err).toContain('invalid runtime cursor-agent, use one of');
    expect(patches).toEqual([]);
  });

  it('says a refusal on one line', async () => {
    refusal = Response.json(
      { error: { code: 'stale_runtime', message: 'stale' } },
      { status: 409 },
    );
    const result = await run('agent', 'runtime', 'codex');
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'a newer runtime change of this agent is already stored',
    );
    expect(await wasAskedRuntime(agentId)).toBe(false);
  });
});
