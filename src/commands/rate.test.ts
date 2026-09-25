// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  RatingRequest,
  readAudience,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import { RATINGS_CLOSED } from './rate.js';

const API_URL = 'https://api.test';

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
const OTHER_AGENT = 'A'.repeat(43);

type RunResult = { code: number; out: string; err: string };

// A stand-in for POST /v1/ratings. Every call is recorded, and a signed
// rating is verified against its kid, which must be the local agent.
class FakeApi {
  calls: { path: string; payload?: RatingRequest }[] = [];
  errors: string[] = [];
  reply: ((payload: RatingRequest) => Response) | null = null;

  constructor(readonly agentId: string) {}

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const call: { path: string; payload?: RatingRequest } = {
      path: url.pathname,
    };
    this.calls.push(call);
    if (url.pathname !== '/v1/ratings' || init?.method !== 'POST') {
      return error(404, 'not_found');
    }
    const { envelope } = JSON.parse(String(init.body)) as { envelope: string };
    const kid = decodeHeader(envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    const payload = unsigned(
      (await verify(envelope, base64urlDecode(kid))).payload,
    );
    call.payload = RatingRequest.parse(payload);
    if (this.reply) return this.reply(call.payload);
    const { issuedAt: _, ...stored } = call.payload;
    return Response.json({ ...stored, raterScoreAtTime: 0.75 });
  }) as typeof fetch;
}

function error(status: number, code: string, headers = {}): Response {
  return Response.json(
    { error: { code, message: `failed with ${code}` } },
    { status, headers },
  );
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('sealkeeper rate', () => {
  let home: string;
  let agentId: string;
  let api: FakeApi;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({ rate: { fetch: api.fetch } });
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
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-rate-'));
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

  it('signs the rating, posts it and prints the stored rating', async () => {
    const before = Date.now();
    const { code, out, err } = await run(
      'rate',
      OTHER_AGENT,
      '--dimension',
      'competence:summarise',
      '--value',
      '4',
    );
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(api.calls).toEqual([
      {
        path: '/v1/ratings',
        payload: {
          rateeAgentId: OTHER_AGENT,
          dimension: 'competence:summarise',
          value: 4,
          issuedAt: expect.any(String),
        },
      },
    ]);
    const issuedAt = Date.parse(api.calls[0]?.payload?.issuedAt ?? '');
    expect(issuedAt).toBeGreaterThanOrEqual(before);
    expect(issuedAt).toBeLessThanOrEqual(Date.now());
    expect(out).toBe(
      [
        `agent      ${OTHER_AGENT}`,
        'dimension  competence:summarise',
        'value      4',
        'weight     0.75',
        '',
      ].join('\n'),
    );
  });

  it('--json prints the stored rating as one object', async () => {
    const { code, out } = await run(
      'rate',
      OTHER_AGENT,
      '--dimension',
      'safety',
      '--value',
      '5',
      '--json',
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      rateeAgentId: OTHER_AGENT,
      dimension: 'safety',
      value: 5,
      raterScoreAtTime: 0.75,
    });
  });

  it.each([
    [
      'a bad dimension',
      [OTHER_AGENT, '--dimension', 'speed', '--value', '3'],
      '--dimension must be',
    ],
    [
      'a value of 6',
      [OTHER_AGENT, '--dimension', 'safety', '--value', '6'],
      '--value must be a whole number from 1 to 5, got 6',
    ],
    [
      'a value that is not a whole number',
      [OTHER_AGENT, '--dimension', 'safety', '--value', '2.5'],
      '--value must be a whole number from 1 to 5, got 2.5',
    ],
    [
      'a bad agent id',
      ['not-an-agent', '--dimension', 'safety', '--value', '3'],
      'not an agent id: not-an-agent',
    ],
  ])(
    'rejects %s locally without a network call',
    async (_label, args, message) => {
      const { code, out, err } = await run('rate', ...args);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain(message);
      expect(err.trim().split('\n')).toHaveLength(1);
      expect(api.calls).toEqual([]);
    },
  );

  it('prints one friendly line when ratings are closed', async () => {
    api.reply = () => error(403, 'ratings_closed');
    const { code, out, err } = await run(
      'rate',
      OTHER_AGENT,
      '--dimension',
      'reliability',
      '--value',
      '3',
    );
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe(`${RATINGS_CLOSED}\n`);
  });

  it.each([
    [error(400, 'self_rating'), 'an agent cannot rate itself'],
    [error(404, 'not_found'), `no agent with id ${OTHER_AGENT}`],
    [
      error(403, 'rater_below_minimum'),
      'your agent needs a higher score before it can rate others',
    ],
    [
      error(429, 'rate_limited', { 'Retry-After': '12' }),
      'too many ratings, try again in 12 seconds',
    ],
    [
      error(409, 'stale_rating'),
      'a newer rating for this agent and dimension is already stored',
    ],
    [
      error(400, 'issued_at_out_of_window'),
      'the API refused the rating time, check this machine clock',
    ],
    [error(418, 'teapot'), 'failed with teapot'],
  ])('prints one line for other refusals (%#)', async (response, line) => {
    api.reply = () => response;
    const { code, err } = await run(
      'rate',
      OTHER_AGENT,
      '--dimension',
      'reliability',
      '--value',
      '3',
    );
    expect(code).toBe(1);
    expect(err).toBe(`${line}\n`);
  });

  it('needs init first', async () => {
    await rm(join(home, 'config.json'));
    const { code, err } = await run(
      'rate',
      OTHER_AGENT,
      '--dimension',
      'reliability',
      '--value',
      '3',
    );
    expect(code).toBe(1);
    expect(err).toBe('not initialised, run npx sealkeeper init\n');
    expect(api.calls).toEqual([]);
  });
});
