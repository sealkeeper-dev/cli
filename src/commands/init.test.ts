// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  EventType,
  verify,
} from '@vouched-dev/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, readConfig } from '../config.js';
import {
  ACCESS_TOKEN_URL,
  CODE_EXPIRED,
  DEVICE_CODE_URL,
  MISSING_CLIENT_ID,
} from '../github-device.js';
import { loadKey } from '../identity.js';
import { createProgram } from '../program.js';
import { describeTaxonomy, NEVER_LEAVES } from '../taxonomy.js';
import { ALREADY_INITIALISED, CONSENT, NOTHING_SENT } from './init.js';

const TOKEN = 'gho_THIS_TOKEN_MUST_NEVER_LEAK_0123456789';
const API_URL = 'http://api.test';

type RunResult = { code: number; out: string; err: string };

type ApiReply = { status: number; body: unknown };

type World = {
  tokenResponses: unknown[];
  api: (payload: Record<string, unknown>) => ApiReply;
  sleeps: number[];
  registrations: Record<string, unknown>[];
  fetchUrls: string[];
};

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

function created(payload: Record<string, unknown>): ApiReply {
  return {
    status: 201,
    body: {
      id: payload.publicKey,
      name: payload.name,
      version: payload.version,
      operator: { login: 'carelmeyer' },
      createdAt: '2026-09-23T10:00:00.000Z',
    },
  };
}

function apiError(status: number, code: string, message: string): ApiReply {
  return { status, body: { error: { code, message } } };
}

// Stands in for GitHub and the Vouched API. The API side checks the envelope
// signature against the kid, like the real one, before it answers.
function fakeFetch(world: World): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    world.fetchUrls.push(url);
    if (url === DEVICE_CODE_URL) {
      return Response.json({
        device_code: 'dev-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (url === ACCESS_TOKEN_URL) {
      return Response.json(world.tokenResponses.shift());
    }
    if (url === `${API_URL}/v1/agents`) {
      const { envelope } = JSON.parse(String(init.body)) as {
        envelope: string;
      };
      const { kid } = decodeHeader(envelope);
      const { payload } = await verify(envelope, base64urlDecode(kid));
      const registration = payload as Record<string, unknown>;
      world.registrations.push(registration);
      const reply = world.api(registration);
      return Response.json(reply.body, { status: reply.status });
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
}

async function run(world: World, ...args: string[]): Promise<RunResult> {
  const program = createProgram({
    init: {
      fetch: fakeFetch(world),
      sleep: async (ms) => {
        world.sleeps.push(ms);
      },
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
    vi.mocked(process.stdout.write).mockRestore();
    vi.mocked(process.stderr.write).mockRestore();
  }
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

describe('vouched init', () => {
  let home: string;
  let world: World;

  function newWorld(): World {
    return {
      tokenResponses: [
        { error: 'authorization_pending' },
        { access_token: TOKEN },
      ],
      api: created,
      sleeps: [],
      registrations: [],
      fetchUrls: [],
    };
  }

  async function expectNoTokenAnywhere(result: RunResult): Promise<void> {
    expect(result.out).not.toContain(TOKEN);
    expect(result.err).not.toContain(TOKEN);
    expect(await readIfExists(paths(home).config)).not.toContain(TOKEN);
    expect(await readIfExists(paths(home).key)).not.toContain(TOKEN);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vouched-init-'));
    vi.stubEnv('VOUCHED_HOME', home);
    vi.stubEnv('VOUCHED_GITHUB_CLIENT_ID', 'client-abc');
    vi.stubEnv('VOUCHED_API_URL', API_URL);
    world = newWorld();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('registers through the device flow and writes config and key', async () => {
    const result = await run(world, 'init', '--name', 'scout');
    expect(result.code).toBe(0);

    const key = await loadKey(paths(home));
    expect(key).not.toBeNull();
    const agentId = key?.agentId ?? '';

    expect(result.out).toBe(
      [
        `registered agent ${agentId}`,
        'operator carelmeyer',
        `profile https://vouched.run/agents/${agentId}`,
        '',
      ].join('\n'),
    );
    expect(result.err).toContain('Open https://github.com/login/device');
    expect(result.err).toContain('Enter code ABCD-1234');
    expect(world.sleeps).toEqual([5000, 5000]);

    expect(world.registrations).toEqual([
      {
        publicKey: agentId,
        githubToken: TOKEN,
        name: 'scout',
        version: '0.1.0',
      },
    ]);
    expect(await readConfig(paths(home))).toEqual({
      agentId,
      operatorLogin: 'carelmeyer',
      name: 'scout',
      version: '0.1.0',
      apiUrl: API_URL,
      registeredAt: '2026-09-23T10:00:00.000Z',
    });
    expect((await stat(paths(home).key)).mode & 0o777).toBe(0o600);
    await expectNoTokenAnywhere(result);
  });

  it('names the terms and the privacy policy on stderr before the device flow', async () => {
    const result = await run(world, 'init', '--name', 'scout');
    expect(result.code).toBe(0);
    expect(CONSENT).toBe(
      'By continuing you accept https://vouched.run/terms and https://vouched.run/privacy.',
    );
    const lines = result.err.split('\n');
    const consent = lines.indexOf(CONSENT);
    const device = lines.findIndex((l) =>
      l.includes('Open https://github.com/login/device'),
    );
    expect(consent).toBeGreaterThanOrEqual(0);
    expect(device).toBeGreaterThan(consent);
    expect(result.out).not.toContain(CONSENT);
  });

  it('with --json keeps the consent line off stdout', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ name: 'scout' });
    expect(result.err).toContain(CONSENT);
  });

  it('ends with what leaves this machine on stderr and sends no events', async () => {
    const result = await run(world, 'init', '--name', 'scout');
    expect(result.code).toBe(0);
    expect(result.err).toContain('What leaves this machine');
    for (const type of EventType.options) {
      expect(result.err).toMatch(
        new RegExp(`^${type.replace('.', '\\.')}$`, 'm'),
      );
    }
    expect(result.err).toContain(NEVER_LEAVES);
    expect(
      result.err.endsWith(`${describeTaxonomy()}\n\n${NOTHING_SENT}\n`),
    ).toBe(true);
    expect(result.out).not.toContain('What leaves');
    expect(world.fetchUrls.filter((u) => u.endsWith('/v1/events'))).toEqual([]);
  });

  it('with --json keeps stdout one object and still prints the block on stderr', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ name: 'scout' });
    expect(result.err).toContain(NEVER_LEAVES);
  });

  it('defaults the name to the current directory and takes --version', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/work/my-agent');
    const result = await run(world, 'init', '--version', '2.3.4');
    vi.mocked(process.cwd).mockRestore();
    expect(result.code).toBe(0);
    expect(world.registrations[0]).toMatchObject({
      name: 'my-agent',
      version: '2.3.4',
    });
  });

  it('--api-url wins over VOUCHED_API_URL', async () => {
    vi.stubEnv('VOUCHED_API_URL', 'http://unreachable.test');
    const result = await run(world, 'init', '--api-url', API_URL);
    expect(result.code).toBe(0);
    expect((await readConfig(paths(home)))?.apiUrl).toBe(API_URL);
  });

  it('prints JSON with --json after the command', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    const printed = JSON.parse(result.out) as Record<string, string>;
    expect(printed.profileUrl).toBe(
      `https://vouched.run/agents/${printed.agentId}`,
    );
    await expectNoTokenAnywhere(result);
  });

  it('adds five seconds to the poll interval on slow_down', async () => {
    world.tokenResponses = [
      { error: 'slow_down' },
      { error: 'authorization_pending' },
      { access_token: TOKEN },
    ];
    const result = await run(world, 'init');
    expect(result.code).toBe(0);
    expect(world.sleeps).toEqual([5000, 10000, 10000]);
  });

  it('exits 1 with a message when the GitHub code expires', async () => {
    world.tokenResponses = [{ error: 'expired_token' }];
    const result = await run(world, 'init');
    expect(result.code).toBe(1);
    expect(result.err.endsWith(`${CODE_EXPIRED}\n`)).toBe(true);
    expect(result.out).toBe('');
    expect(await readConfig(paths(home))).toBeNull();
  });

  it.each([
    [
      apiError(
        403,
        'account_too_new',
        'GitHub account must be at least 30 days old',
      ),
      'registration refused, your GitHub account is too new (GitHub account must be at least 30 days old)',
    ],
    [
      apiError(
        403,
        'operator_cap_reached',
        'An operator can register at most 100 agents',
      ),
      'registration refused, your GitHub account has reached its agent limit (An operator can register at most 100 agents)',
    ],
    [
      apiError(409, 'conflict', 'This key is registered to another operator'),
      'this key is already registered by another operator, run vouched init --force to create a new key',
    ],
    [
      apiError(401, 'invalid_signature', 'bad signature'),
      'the API rejected the registration signature, check the key file or run vouched init --force',
    ],
    [
      apiError(401, 'github_token_rejected', 'GitHub rejected the token'),
      'the API could not verify your GitHub login, run vouched init again',
    ],
    [
      apiError(400, 'key_mismatch', 'publicKey must equal the kid'),
      'registration failed with key_mismatch, publicKey must equal the kid',
    ],
  ])('API %# prints one line and writes no config', async (reply, message) => {
    world.api = () => reply;
    const result = await run(world, 'init');
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err.endsWith(`\n${message}\n`)).toBe(true);
    expect(await readConfig(paths(home))).toBeNull();
    await expectNoTokenAnywhere(result);
  });

  it('reports a network error on one line', async () => {
    const result = await run(world, 'init', '--api-url', 'http://down.test');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /\ncould not reach the Vouched API at http:\/\/down\.test: fetch failed\n$/,
    );
    expect(await readConfig(paths(home))).toBeNull();
  });

  it('keeps the key after a failed registration and reuses it next time', async () => {
    world.api = () => apiError(403, 'account_too_new', 'too new');
    expect((await run(world, 'init')).code).toBe(1);
    const first = await readFile(paths(home).key, 'utf8');

    world = newWorld();
    expect((await run(world, 'init')).code).toBe(0);
    expect(await readFile(paths(home).key, 'utf8')).toBe(first);
  });

  it('a second init without --force says already initialised and leaves the key', async () => {
    expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
    const keyBefore = await readFile(paths(home).key, 'utf8');
    const keyStat = await stat(paths(home).key);

    world = newWorld();
    const result = await run(world, 'init');
    expect(result.code).toBe(0);
    expect(result.out.split('\n')[0]).toBe(ALREADY_INITIALISED);
    expect(result.err).not.toContain(CONSENT);
    expect(result.out).toContain('operatorLogin  carelmeyer');
    expect(result.out).toContain('name           scout');
    expect(world.fetchUrls).toEqual([]);
    expect(await readFile(paths(home).key, 'utf8')).toBe(keyBefore);
    expect((await stat(paths(home).key)).mtimeMs).toBe(keyStat.mtimeMs);
  });

  it('--force regenerates the key and registers again', async () => {
    expect((await run(world, 'init')).code).toBe(0);
    const before = await loadKey(paths(home));

    world = newWorld();
    const result = await run(world, 'init', '--force');
    expect(result.code).toBe(0);
    const after = await loadKey(paths(home));
    expect(after?.agentId).not.toBe(before?.agentId);
    expect(world.registrations[0]?.publicKey).toBe(after?.agentId);
    expect((await readConfig(paths(home)))?.agentId).toBe(after?.agentId);
    expect(result.out).toContain(`registered agent ${after?.agentId}`);
  });

  it('--force re-registers against the API URL in the existing config', async () => {
    expect((await run(world, 'init')).code).toBe(0);
    expect((await readConfig(paths(home)))?.apiUrl).toBe(API_URL);

    vi.stubEnv('VOUCHED_API_URL', '');
    world = newWorld();
    const result = await run(world, 'init', '--force');
    expect(result.code).toBe(0);
    expect(world.fetchUrls).toContain(`${API_URL}/v1/agents`);
    expect(world.registrations).toHaveLength(1);
    expect((await readConfig(paths(home)))?.apiUrl).toBe(API_URL);
  });

  it('--force goes ahead when the existing config is broken', async () => {
    expect((await run(world, 'init')).code).toBe(0);
    await writeFile(paths(home).config, 'not json');

    world = newWorld();
    const result = await run(world, 'init', '--force');
    expect(result.code).toBe(0);
    expect((await readConfig(paths(home)))?.apiUrl).toBe(API_URL);
  });

  it('exits 1 naming the env var when there is no client id', async () => {
    vi.stubEnv('VOUCHED_GITHUB_CLIENT_ID', '');
    const result = await run(world, 'init');
    expect(result.code).toBe(1);
    expect(result.err).toBe(`${MISSING_CLIENT_ID}\n`);
    expect(result.err).toContain('VOUCHED_GITHUB_CLIENT_ID');
    expect(world.fetchUrls).toEqual([]);
    expect(await readIfExists(paths(home).key)).toBe('');
  });
});
