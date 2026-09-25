// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  EventType,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Input } from '../ask.js';
import { proveCommandText } from '../claude-code-command.js';
import { hookCommand, invocationOf } from '../claude-code-settings.js';
import { paths, readConfig, writeConfig } from '../config.js';
import {
  ACCESS_TOKEN_URL,
  CODE_EXPIRED,
  DEVICE_CODE_URL,
  MISSING_CLIENT_ID,
} from '../github-device.js';
import { loadKey } from '../identity.js';
import { createProgram } from '../program.js';
import { describeTaxonomy, NEVER_LEAVES } from '../taxonomy.js';
import {
  ALREADY_INITIALISED,
  CONSENT,
  HOOKS_QUESTION,
  isYesByDefault,
  NEXT_HOOKS,
  NEXT_NPX,
  NEXT_PROVE,
  NEXT_WHAT_IS_SHARED,
  NOTHING_SENT,
  versionQuestion,
} from './init.js';

const TOKEN = 'gho_THIS_TOKEN_MUST_NEVER_LEAK_0123456789';
const HOOK_COMMAND = hookCommand(
  '/usr/local/bin/node',
  '/usr/local/lib/node_modules/sealkeeper/dist/index.js',
);
const PROVE_COMMAND_TEXT = proveCommandText(invocationOf(HOOK_COMMAND));
const API_URL = 'http://api.test';

type RunResult = { code: number; out: string; err: string };

type ApiReply = { status: number; body: unknown };

type World = {
  tokenResponses: unknown[];
  api: (payload: Record<string, unknown>) => ApiReply;
  sleeps: number[];
  registrations: Record<string, unknown>[];
  fetchUrls: string[];
  // The terminal the hooks question reads from. None means no stdin at all.
  stdin?: Input;
  // Whether the CLI runs from the npx cache. False when not set.
  npx?: boolean;
  // The project directory init looks in for .claude/settings.json.
  cwd?: string;
  // The version GET /v1/agents/:id answers. Unset means that route fails
  // like an unreachable API. A signed PATCH moves it.
  serverVersion?: string;
  versionChanges: Record<string, unknown>[];
  // When set, a PATCH gets this refusal and nothing moves.
  versionRefusal?: { status: number; code: string; retryAfter?: string };
};

// A terminal, or a pipe when isTTY is false, that answers with the given
// line and records how often it was read.
function answering(
  line: string | null,
  isTTY = true,
): Input & { reads: number } {
  const input = {
    isTTY,
    reads: 0,
    readLine: async () => {
      input.reads++;
      return line;
    },
  };
  return input;
}

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

// Stands in for GitHub and the SealKeeper API. The API side checks the envelope
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
    const agentRoute =
      /^http:\/\/api\.test\/v1\/agents\/([A-Za-z0-9_-]{43})$/.exec(url);
    if (agentRoute && world.serverVersion !== undefined) {
      if (init.method === 'PATCH' && world.versionRefusal !== undefined) {
        const { status, code, retryAfter } = world.versionRefusal;
        return Response.json(
          { error: { code, message: 'refused' } },
          {
            status,
            headers:
              retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
          },
        );
      }
      if (init.method === 'PATCH') {
        const { envelope } = JSON.parse(String(init.body)) as {
          envelope: string;
        };
        const { kid } = decodeHeader(envelope);
        const { payload } = await verify(envelope, base64urlDecode(kid));
        const change = payload as { version: string };
        world.versionChanges.push(change);
        world.serverVersion = change.version;
      }
      return Response.json({
        id: agentRoute[1],
        name: 'scout',
        version: world.serverVersion,
        operator: { login: 'carelmeyer' },
        createdAt: '2026-09-23T10:00:00.000Z',
      });
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
      stdin: world.stdin ? () => world.stdin as Input : undefined,
      hookCommand: () => HOOK_COMMAND,
      isNpx: () => world.npx === true,
      cwd: world.cwd === undefined ? undefined : () => world.cwd as string,
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

describe('sealkeeper init', () => {
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
      versionChanges: [],
    };
  }

  async function expectNoTokenAnywhere(result: RunResult): Promise<void> {
    expect(result.out).not.toContain(TOKEN);
    expect(result.err).not.toContain(TOKEN);
    expect(await readIfExists(paths(home).config)).not.toContain(TOKEN);
    expect(await readIfExists(paths(home).key)).not.toContain(TOKEN);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-init-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_GITHUB_CLIENT_ID', 'client-abc');
    vi.stubEnv('SEALKEEPER_API_URL', API_URL);
    // Never the real ~/.claude. Tests that want Claude Code create it.
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
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
        'handle carelmeyer/scout',
        'profile https://sealkeeper.run/agents/carelmeyer/scout',
        '',
        NEXT_PROVE,
        NEXT_WHAT_IS_SHARED,
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
      'By continuing you accept https://sealkeeper.run/terms and https://sealkeeper.run/privacy.',
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

  it('--api-url wins over SEALKEEPER_API_URL', async () => {
    vi.stubEnv('SEALKEEPER_API_URL', 'http://unreachable.test');
    const result = await run(world, 'init', '--api-url', API_URL);
    expect(result.code).toBe(0);
    expect((await readConfig(paths(home)))?.apiUrl).toBe(API_URL);
  });

  it('prints JSON with --json after the command', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    const printed = JSON.parse(result.out) as Record<string, string>;
    expect(printed.handle).toBe('carelmeyer/scout');
    expect(printed.profileUrl).toBe(
      'https://sealkeeper.run/agents/carelmeyer/scout',
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
      apiError(409, 'name_taken', 'carelmeyer/cli is taken, try cli-2'),
      'carelmeyer/cli is taken, try cli-2',
    ],
    [
      apiError(409, 'conflict', 'This key is registered to another operator'),
      'this key is already registered by another operator, run npx sealkeeper init --force to create a new key',
    ],
    [
      apiError(401, 'invalid_signature', 'bad signature'),
      'the API rejected the registration signature, check the key file or run npx sealkeeper init --force',
    ],
    [
      apiError(401, 'github_token_rejected', 'GitHub rejected the token'),
      'the API could not verify your GitHub login, run npx sealkeeper init again',
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

  it('refuses a --name that is not a valid name before any request', async () => {
    for (const name of ['Scout', 'my agent', 'x', 'admin']) {
      const result = await run(world, 'init', '--name', name);
      expect(result.code, name).toBe(1);
      expect(result.err).toContain(`invalid agent name ${name}`);
    }
    expect(world.fetchUrls).toEqual([]);
    expect(await readConfig(paths(home))).toBeNull();
  });

  it('makes a valid name from the directory name when --name is not given', async () => {
    const dir = join(home, 'My Project_v2');
    await mkdir(dir);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const result = await run(world, 'init').finally(() => cwd.mockRestore());
    expect(result.code).toBe(0);
    expect(world.registrations[0]?.name).toBe('my-project-v2');
    expect(result.out).toContain('handle carelmeyer/my-project-v2');
  });

  it('reports a network error on one line', async () => {
    const result = await run(world, 'init', '--api-url', 'http://down.test');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /\ncould not reach the SealKeeper API at http:\/\/down\.test: fetch failed\n$/,
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

    vi.stubEnv('SEALKEEPER_API_URL', '');
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
    vi.stubEnv('SEALKEEPER_GITHUB_CLIENT_ID', '');
    const result = await run(world, 'init');
    expect(result.code).toBe(1);
    expect(result.err).toBe(`${MISSING_CLIENT_ID}\n`);
    expect(result.err).toContain('SEALKEEPER_GITHUB_CLIENT_ID');
    expect(world.fetchUrls).toEqual([]);
    expect(await readIfExists(paths(home).key)).toBe('');
  });
  describe('version on a repeat init', () => {
    // Registered on 0.1.0, then the version on this machine moved to 2.0.0.
    async function registeredThenMoved(): Promise<void> {
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const config = await readConfig(paths(home));
      if (config === null) throw new Error('no config');
      await writeConfig({ ...config, version: '2.0.0' }, paths(home));
      world = newWorld();
      world.serverVersion = '0.1.0';
    }

    it('offers to move SealKeeper to the version on this machine and does on y', async () => {
      await registeredThenMoved();
      const stdin = answering('y');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(1);
      expect(result.err).toContain(versionQuestion('0.1.0', '2.0.0'));
      expect(versionQuestion('0.1.0', '2.0.0')).toBe(
        'SealKeeper has this agent on version 0.1.0 and this machine on 2.0.0. Move SealKeeper to 2.0.0? [y/N] ',
      );
      expect(world.versionChanges).toEqual([
        { version: '2.0.0', issuedAt: expect.any(String) },
      ]);
      expect(result.out).toContain(
        'moved SealKeeper from version 0.1.0 to 2.0.0',
      );
      expect(result.out).toContain(
        "2.0.0 starts from half of 0.1.0's counts, with its level capped one below 0.1.0's",
      );
      expect((await readConfig(paths(home)))?.version).toBe('2.0.0');
    });

    it('leaves SealKeeper alone on Enter, since no is the default', async () => {
      await registeredThenMoved();
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(world.versionChanges).toEqual([]);
      expect(result.out).toContain(
        'SealKeeper stays on 0.1.0. Run npx sealkeeper agent version 2.0.0 to move it later.',
      );
    });

    it('asks nothing when the versions match', async () => {
      await registeredThenMoved();
      world.serverVersion = '2.0.0';
      const stdin = answering('y');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain('[y/N]');
      expect(world.versionChanges).toEqual([]);
    });

    it('asks nothing and reads nothing without a terminal', async () => {
      await registeredThenMoved();
      const stdin = answering('y', false);
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(world.fetchUrls).toEqual([]);
    });

    it('goes on to the hooks offer when SealKeeper refuses the move', async () => {
      await registeredThenMoved();
      await mkdir(join(home, 'claude'), { recursive: true });
      world.versionRefusal = {
        status: 429,
        code: 'rate_limited',
        retryAfter: '3600',
      };
      const stdin = answering('y');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.err).toContain(versionQuestion('0.1.0', '2.0.0'));
      expect(result.err).toContain(
        'version not moved, too many requests, try again in 3600 seconds. Run npx sealkeeper agent version 2.0.0 to try again.',
      );
      expect(result.out).not.toContain('registration failed');
      expect(result.out).not.toContain('moved SealKeeper');
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(stdin.reads).toBe(2);
      expect((await readConfig(paths(home)))?.version).toBe('2.0.0');
    });

    it('skips the question quietly when the API cannot be reached', async () => {
      await registeredThenMoved();
      world.serverVersion = undefined;
      const stdin = answering('y');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.out.split('\n')[0]).toBe(ALREADY_INITIALISED);
    });
  });

  describe('Claude Code hooks', () => {
    const claudeDir = () => join(home, 'claude');
    const settingsFile = () => join(claudeDir(), 'settings.json');
    const EXISTING = `${JSON.stringify(
      {
        model: 'opus',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'other-tool stop' }] }],
        },
      },
      null,
      2,
    )}\n`;

    async function withClaudeCode(text = EXISTING): Promise<void> {
      await mkdir(claudeDir(), { recursive: true });
      await writeFile(settingsFile(), text);
    }

    function hooksIn(text: string): string[] {
      const hooks = (JSON.parse(text) as { hooks: Record<string, unknown[]> })
        .hooks;
      return Object.entries(hooks)
        .filter(([, list]) =>
          JSON.stringify(list).includes(JSON.stringify(HOOK_COMMAND)),
        )
        .map(([event]) => event);
    }

    it('says nothing about hooks when there is no Claude Code dir', async () => {
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect((world.stdin as Input & { reads: number }).reads).toBe(0);
      expect(result.out).not.toContain('hook');
      expect(result.err).not.toContain(HOOKS_QUESTION);
      expect(
        result.out.endsWith(`${NEXT_PROVE}\n${NEXT_WHAT_IS_SHARED}\n`),
      ).toBe(true);
    });

    it('honours CLAUDE_CONFIG_DIR when looking for Claude Code', async () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'elsewhere'));
      await mkdir(join(home, 'elsewhere'));
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.out).toContain(NEXT_HOOKS);
    });

    it('offers the hooks again on a repeat init when the old bare form is in place', async () => {
      await withClaudeCode(
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'sealkeeper hook claude-code' },
                ],
              },
            ],
          },
        }),
      );
      world.stdin = answering('n');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.out.split('\n')[0]).toBe(ALREADY_INITIALISED);
      expect(stdin.reads).toBe(1);
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(result.out).toContain('updated sealkeeper hooks for Stop');
      expect(result.out).toContain(NEXT_PROVE);
      const after = await readFile(settingsFile(), 'utf8');
      expect(after).not.toContain('"sealkeeper hook claude-code"');
      expect(after).toContain('hook claude-code');
    });

    it('asks nothing when the project settings already hold the hooks', async () => {
      await withClaudeCode();
      const project = join(home, 'project');
      world.cwd = project;
      await mkdir(join(project, '.claude'), { recursive: true });
      const projectFile = join(project, '.claude', 'settings.json');
      await writeFile(
        projectFile,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
          },
        }),
      );
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain(HOOKS_QUESTION);
      expect(result.out).not.toContain(NEXT_HOOKS);
      // No second set in the user settings.
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('rewrites old hooks in the project settings in place, not in the user settings', async () => {
      await withClaudeCode();
      const project = join(home, 'project');
      world.cwd = project;
      await mkdir(join(project, '.claude'), { recursive: true });
      const projectFile = join(project, '.claude', 'settings.json');
      await writeFile(
        projectFile,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'sealkeeper hook claude-code' },
                ],
              },
            ],
          },
        }),
      );
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.out).toContain('updated sealkeeper hooks for Stop');
      const after = await readFile(projectFile, 'utf8');
      expect(after).not.toContain('"sealkeeper hook claude-code"');
      expect(after).toContain(JSON.stringify(HOOK_COMMAND).slice(1, -1));
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('replaces the old vouched hooks in place in both scopes on a repeat init, without asking', async () => {
      const oldHook = hookCommand(
        '/usr/local/bin/node',
        '/usr/local/lib/node_modules/vouched/dist/index.js',
      );
      const oldSettings = (command: string) =>
        `${JSON.stringify(
          {
            hooks: {
              Stop: [
                { hooks: [{ type: 'command', command: 'other-tool stop' }] },
                { hooks: [{ type: 'command', command }] },
              ],
            },
          },
          null,
          2,
        )}\n`;
      const oldProve = '---\nmanaged-by: vouched\n---\nold body\n';
      await withClaudeCode();
      const project = join(home, 'project');
      world.cwd = project;
      world.stdin = answering('n');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      // Then the old package's hooks and slash commands, as 0.3 left them.
      await writeFile(settingsFile(), oldSettings(oldHook));
      const projectFile = join(project, '.claude', 'settings.json');
      await mkdir(join(project, '.claude', 'commands'), { recursive: true });
      await writeFile(projectFile, oldSettings('vouched hook claude-code'));
      await mkdir(join(claudeDir(), 'commands'), { recursive: true });
      const oldUserProve = join(claudeDir(), 'commands', 'vouched-prove.md');
      const oldProjectProve = join(
        project,
        '.claude',
        'commands',
        'vouched-prove.md',
      );
      await writeFile(oldUserProve, oldProve);
      await writeFile(oldProjectProve, oldProve);

      const stdin = answering('n');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain(HOOKS_QUESTION);
      for (const [file, prove] of [
        [settingsFile(), oldUserProve],
        [projectFile, oldProjectProve],
      ] as const) {
        expect(result.out).toContain(
          `replaced the old vouched hooks for Stop in ${file} with sealkeeper hooks`,
        );
        expect(result.out).toContain(
          `removed the old /vouched-prove command at ${prove}`,
        );
        const after = await readFile(file, 'utf8');
        expect(after).not.toContain('vouched');
        expect(after).toContain('other-tool stop');
        expect(hooksIn(after)).toEqual([
          'Stop',
          'SessionStart',
          'SessionEnd',
          'PreToolUse',
          'PostToolUse',
        ]);
        // The old Stop hook became the new one where it stood.
        expect(JSON.parse(after).hooks.Stop).toEqual(
          JSON.parse(oldSettings(HOOK_COMMAND)).hooks.Stop,
        );
        expect(await readIfExists(prove)).toBe('');
        expect(
          await readFile(join(prove, '..', 'sealkeeper-prove.md'), 'utf8'),
        ).toBe(PROVE_COMMAND_TEXT);
      }

      // Once replaced, a further init has nothing to do.
      const again = await run(world, 'init');
      expect(again.out).not.toContain('replaced');
    });

    it('asks nothing on a repeat init when the hooks are current', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain(HOOKS_QUESTION);
    });

    it('installs on Enter, since yes is the default', async () => {
      await withClaudeCode();
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(1);
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(result.out).toContain(
        `added sealkeeper hooks for SessionStart, SessionEnd, PreToolUse, PostToolUse, Stop to ${settingsFile()}`,
      );
      expect(result.out).not.toContain(NEXT_HOOKS);
      expect(
        result.out.endsWith(`\n\n${NEXT_PROVE}\n${NEXT_WHAT_IS_SHARED}\n`),
      ).toBe(true);
      const after = await readFile(settingsFile(), 'utf8');
      expect(hooksIn(after)).toEqual([
        'Stop',
        'SessionStart',
        'SessionEnd',
        'PreToolUse',
        'PostToolUse',
      ]);
      expect(after).toContain('other-tool stop');
      const command = join(claudeDir(), 'commands', 'sealkeeper-prove.md');
      expect(result.out).toContain(
        `added the /sealkeeper-prove command at ${command}`,
      );
      expect(await readFile(command, 'utf8')).toBe(PROVE_COMMAND_TEXT);
    });

    it('says the hooks point at the npx copy when run through npx', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      world.npx = true;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(NEXT_NPX).toBe(
        'Hooks point at this npx copy. For a stable path run npm i -g sealkeeper and then sealkeeper adapter claude-code install.',
      );
      expect(
        result.out.endsWith(
          `\n\n${NEXT_PROVE}\n${NEXT_WHAT_IS_SHARED}\n${NEXT_NPX}\n`,
        ),
      ).toBe(true);
    });

    it('says nothing about npx when the hooks were already there', async () => {
      await withClaudeCode(
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }, null, 2)}\n`,
      );
      world.stdin = answering('');
      world.npx = true;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.out).not.toContain(NEXT_NPX);
    });

    it('prints the command instead on n and leaves the settings alone', async () => {
      await withClaudeCode();
      world.stdin = answering('n');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(
        result.out.endsWith(
          `\n\n${NEXT_PROVE}\n${NEXT_WHAT_IS_SHARED}\n${NEXT_HOOKS}\n`,
        ),
      ).toBe(true);
      expect(NEXT_HOOKS).toBe(
        'Run npx sealkeeper adapter claude-code install to record your Claude Code sessions',
      );
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
      expect(
        await readIfExists(
          join(claudeDir(), 'commands', 'sealkeeper-prove.md'),
        ),
      ).toBe('');
    });

    it('does not ask without a terminal and prints the command', async () => {
      await withClaudeCode();
      const stdin = answering('y', false);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain(HOOKS_QUESTION);
      expect(result.out).toContain(NEXT_HOOKS);
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('with --json never asks and lists the command in nextSteps', async () => {
      await withClaudeCode();
      const stdin = answering('y');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain(HOOKS_QUESTION);
      const printed = JSON.parse(result.out) as { nextSteps: string[] };
      expect(printed.nextSteps).toEqual([
        NEXT_PROVE,
        NEXT_WHAT_IS_SHARED,
        NEXT_HOOKS,
      ]);
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('with --json and no Claude Code lists two next steps', async () => {
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      const printed = JSON.parse(result.out) as { nextSteps: string[] };
      expect(printed.nextSteps).toEqual([NEXT_PROVE, NEXT_WHAT_IS_SHARED]);
    });

    it('does not ask when the hooks are already there', async () => {
      await withClaudeCode(
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }, null, 2)}\n`,
      );
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.out).not.toContain(NEXT_HOOKS);
    });

    it('refuses a settings file that is not JSON, names it and still registers', async () => {
      await withClaudeCode('{ "hooks": ');
      world.stdin = answering('y');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        `${settingsFile()} is not valid JSON, left it unchanged`,
      );
      expect(result.out).toContain(NEXT_HOOKS);
      expect(await readFile(settingsFile(), 'utf8')).toBe('{ "hooks": ');
      expect(await readConfig(paths(home))).not.toBeNull();
    });

    it('reads Enter and y as yes, and n, anything else or a closed input as no', () => {
      for (const yes of ['', ' ', 'y', 'Y', 'yes', 'YES']) {
        expect(isYesByDefault(yes), yes).toBe(true);
      }
      for (const no of ['n', 'N', 'no', 'nope', 'x', null]) {
        expect(isYesByDefault(no), String(no)).toBe(false);
      }
    });
  });
});
