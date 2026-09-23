// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckResponse } from '@vouched-dev/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../program.js';

const ID = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const JWS = 'eyJh.eyJi.c2ln';

const failing: CheckResponse = {
  ok: false,
  id: ID,
  handle: 'carelmeyer/claude-code',
  checks: [
    { name: 'minVerified', required: 1, actual: 0, ok: false },
    { name: 'maxIncidents', required: 0, actual: 0, ok: true },
    { name: 'minReliability', required: 0.8, actual: null, ok: false },
  ],
  credential: JWS,
};

const passing: CheckResponse = {
  ok: true,
  id: ID,
  handle: 'carelmeyer/claude-code',
  checks: [
    { name: 'minVerified', required: 0, actual: 0, ok: true },
    { name: 'maxIncidents', required: 0, actual: 0, ok: true },
  ],
  credential: JWS,
};

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('vouched check', () => {
  let home: string;
  let urls: string[];
  let reply: () => Response | Promise<Response>;

  async function run(...args: string[]): Promise<RunResult> {
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
    process.exitCode = undefined;
    try {
      await program.parseAsync(args, { from: 'user' });
      return { code: Number(process.exitCode ?? 0), out, err };
    } catch (e) {
      if (e instanceof CommanderError) return { code: e.exitCode, out, err };
      throw e;
    } finally {
      process.exitCode = undefined;
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  beforeEach(async () => {
    // No config and no key here. check needs neither.
    home = await mkdtemp(join(tmpdir(), 'vouched-check-'));
    vi.stubEnv('VOUCHED_HOME', home);
    vi.stubEnv('VOUCHED_API_URL', 'http://api.test');
    urls = [];
    reply = () => Response.json(passing);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input));
        expect(init?.method ?? 'GET').toBe('GET');
        expect(init?.body).toBeUndefined();
        return reply();
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('prints each check and PASS, exit 0', async () => {
    const r = await run(
      'check',
      'carelmeyer/claude-code',
      '--min-verified',
      '0',
    );
    expect(r).toEqual({
      code: 0,
      out: [
        'ok   verified tasks 0, need at least 0',
        'ok   incidents 0, allow at most 0',
        'PASS carelmeyer/claude-code',
        '',
      ].join('\n'),
      err: '',
    });
    expect(urls).toEqual([
      'http://api.test/v1/check/carelmeyer/claude-code?minVerified=0',
    ]);
  });

  it('prints FAIL lines and exits 1 when a check fails', async () => {
    reply = () => Response.json(failing);
    const r = await run(
      'check',
      'carelmeyer/claude-code',
      '--min-reliability',
      '0.8',
      '--max-incidents',
      '0',
    );
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      [
        'FAIL verified tasks 0, need at least 1',
        'ok   incidents 0, allow at most 0',
        'FAIL reliability none yet, need at least 0.8',
        'FAIL carelmeyer/claude-code',
        '',
      ].join('\n'),
    );
    expect(urls).toEqual([
      'http://api.test/v1/check/carelmeyer/claude-code?maxIncidents=0&minReliability=0.8',
    ]);
  });

  it('--json prints the CheckResponse and keeps the exit code', async () => {
    reply = () => Response.json(failing);
    const r = await run('check', 'carelmeyer/claude-code', '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual(failing);
    reply = () => Response.json(passing);
    const ok = await run('--json', 'check', 'carelmeyer/claude-code');
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual(passing);
  });

  it('exits 2 with the message for an unknown agent', async () => {
    reply = () =>
      Response.json(
        { error: { code: 'not_found', message: 'Agent not found' } },
        { status: 404 },
      );
    const r = await run('check', 'carelmeyer/nobody');
    expect(r).toEqual({
      code: 2,
      out: '',
      err: 'no agent carelmeyer/nobody\n',
    });
  });

  it('exits 2 and names the new handle for a renamed agent', async () => {
    reply = () =>
      Response.json(
        {
          error: { code: 'renamed', message: 'This agent is now x' },
          id: ID,
          handle: 'carelmeyer/ranger',
        },
        { status: 404 },
      );
    const r = await run('check', 'carelmeyer/scout');
    expect(r.code).toBe(2);
    expect(r.err).toBe('carelmeyer/scout is now carelmeyer/ranger\n');
  });

  it('exits 2 when the API cannot be reached', async () => {
    reply = () => {
      throw new TypeError('fetch failed');
    };
    const r = await run('check', 'carelmeyer/claude-code');
    expect(r.code).toBe(2);
    expect(r.err).toBe(
      'could not reach the Vouched API at http://api.test: fetch failed\n',
    );
  });

  it('exits 2 without a request for a bad handle or flag', async () => {
    const handle = await run('check', 'carelmeyer');
    expect(handle.code).toBe(2);
    expect(handle.err).toContain('invalid handle carelmeyer');
    const flag = await run(
      'check',
      'carelmeyer/claude-code',
      '--min-safety',
      '1.5',
    );
    expect(flag.code).toBe(2);
    expect(flag.err).toContain('invalid minSafety 1.5');
    const empty = await run(
      'check',
      'carelmeyer/claude-code',
      '--min-verified',
      '',
    );
    expect(empty.code).toBe(2);
    expect(urls).toEqual([]);
  });
});
