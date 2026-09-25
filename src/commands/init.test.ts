// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  EventType,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanAnswer, type Input, isYes, readYesNo } from '../ask.js';
import { proveCommandText } from '../claude-code-command.js';
import { hookCommand, invocationOf } from '../claude-code-settings.js';
import { paths, readConfig, writeConfig } from '../config.js';
import { tildePath } from '../files.js';
import {
  ACCESS_TOKEN_URL,
  CODE_EXPIRED,
  DEVICE_CODE_URL,
  MISSING_CLIENT_ID,
} from '../github-device.js';
import { loadKey } from '../identity.js';
import { createProgram } from '../program.js';
import { stripStyle } from '../style.js';
import { describeTaxonomy, NEVER_LEAVES } from '../taxonomy.js';
import { VERSION } from '../version.js';
import { INSTALL_COMMAND } from './adapter.js';
import {
  ADAPTERS_URL,
  BRONZE,
  bronzeLine,
  CONSENT,
  HOOKS_INTRO,
  HOOKS_MAX_ASKS,
  HOOKS_NOT_INSTALLED,
  HOOKS_QUESTION,
  isYesByDefault,
  NEXT_HOOKS,
  NEXT_NPX,
  NEXT_PROVE,
  NEXT_WHAT_IS_SHARED,
  NOTHING_SENT,
  SHARED_SUMMARY,
  TAGLINE,
  TERMS,
  versionQuestion,
} from './init.js';

const TOKEN = 'gho_THIS_TOKEN_MUST_NEVER_LEAK_0123456789';
const HOOK_COMMAND = hookCommand(
  '/usr/local/bin/node',
  '/usr/local/lib/node_modules/sealkeeper/dist/index.js',
);
// A hook of ours that an earlier install wrote from another path.
const STALE_SCRIPT = '/old/.npm/_npx/abc/node_modules/sealkeeper/dist/index.js';
const STALE_HOOK = hookCommand('/usr/local/bin/node', STALE_SCRIPT);
const PROVE_COMMAND_TEXT = proveCommandText(invocationOf(HOOK_COMMAND));
const API_URL = 'https://api.test';

// all is stdout and stderr in the order they were written, as a terminal
// shows them.
type RunResult = { code: number; out: string; err: string; all: string };

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
  // The user code GitHub sends. ABCD-1234 when not set.
  userCode?: string;
  // The verified count and level GET /v1/agents/:id answers with, for
  // Next. Needs serverVersion set, else the route fails.
  live?: { verifiedTasks: number; level: string };
  // When set, GET /v1/agents/:id answers a redirect to this address.
  agentMovedTo?: string;
};

// A terminal that answers with each line in turn, then closes.
function answeringEach(lines: string[]): Input & { reads: number } {
  const input = {
    isTTY: true,
    reads: 0,
    readLine: async () => lines[input.reads++] ?? null,
  };
  return input;
}

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
      operator: { login: 'alice' },
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
        user_code: world.userCode ?? 'ABCD-1234',
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
      /^https:\/\/api\.test\/v1\/agents\/([A-Za-z0-9_-]{43})$/.exec(url);
    if (agentRoute && world.agentMovedTo !== undefined && !init.method) {
      return new Response(null, {
        status: 301,
        headers: {
          Location: `${world.agentMovedTo}/v1/agents/${agentRoute[1]}`,
        },
      });
    }
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
        operator: { login: 'alice' },
        createdAt: '2026-09-23T10:00:00.000Z',
        ...(world.live === undefined
          ? {}
          : {
              counts: { verifiedTasks: world.live.verifiedTasks },
              level: world.live.level,
            }),
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
  let all = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    all += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    all += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(args, { from: 'user' });
    return { code: 0, out, err, all };
  } catch (error) {
    if (error instanceof CommanderError)
      return { code: error.exitCode, out, err, all };
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
    // The plain form unless a test asks for styling.
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('NO_COLOR', '');
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
        '  ✓ Signed in as alice',
        '',
        '  ✓ Registered alice/scout',
        '    Profile  https://sealkeeper.run/agents/alice/scout',
        '',
        '  Next',
        '  1  Earn your first verified tasks with npx sealkeeper prove',
        '  2  Review and send what was recorded   npx sealkeeper sync',
        '  3  Bronze needs 25 verified tasks over 3 days. Your badge updates on its own.',
        '',
        '  Mastra or OpenClaw  https://sealkeeper.run/docs/init#adapters',
        '',
        '',
      ].join('\n'),
    );
    expect(result.out).not.toContain(agentId);
    expect(result.err).toContain(
      '  Open https://github.com/login/device and enter ABCD-1234\n',
    );
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
      operatorLogin: 'alice',
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
    expect(TERMS).toBe(
      'By continuing you accept sealkeeper.run/terms and sealkeeper.run/privacy.',
    );
    const lines = result.err.split('\n');
    const consent = lines.indexOf(`  ${TERMS}`);
    const device = lines.findIndex((l) =>
      l.includes('Open https://github.com/login/device'),
    );
    expect(consent).toBeGreaterThanOrEqual(0);
    expect(device).toBeGreaterThan(consent);
    expect(result.out).not.toContain(TERMS);
    expect(result.err).not.toContain(CONSENT);
  });

  it('with --json keeps the consent line off stdout', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ name: 'scout' });
    expect(CONSENT).toBe(
      'By continuing you accept https://sealkeeper.run/terms and https://sealkeeper.run/privacy.',
    );
    expect(result.err).toContain(CONSENT);
  });

  it('says in short what leaves this machine on stderr and sends no events', async () => {
    const result = await run(world, 'init', '--name', 'scout');
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      [
        '  What leaves this machine',
        ...SHARED_SUMMARY.map((l) => `  ${l}`),
        '  Full list  npx sealkeeper what-is-shared',
      ].join('\n'),
    );
    // The full block is for what-is-shared now.
    expect(result.err).not.toContain(describeTaxonomy());
    expect(result.err).not.toContain(NOTHING_SENT);
    expect(result.out).not.toContain('What leaves');
    expect(world.fetchUrls.filter((u) => u.endsWith('/v1/events'))).toEqual([]);
  });

  it('with --json still prints the full block on stderr, as before', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    for (const type of EventType.options) {
      expect(result.err).toMatch(
        new RegExp(`^${type.replace('.', '\\.')}$`, 'm'),
      );
    }
    expect(
      result.err.endsWith(`${describeTaxonomy()}\n\n${NOTHING_SENT}\n`),
    ).toBe(true);
    expect(result.err).toContain('Open https://github.com/login/device\n');
    expect(result.err).toContain('Enter code ABCD-1234\n');
    expect(result.err).not.toContain('SealKeeper v');
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
    vi.stubEnv('SEALKEEPER_API_URL', 'https://unreachable.test');
    const result = await run(world, 'init', '--api-url', API_URL);
    expect(result.code).toBe(0);
    expect((await readConfig(paths(home)))?.apiUrl).toBe(API_URL);
  });

  it('prints JSON with --json after the command', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    const printed = JSON.parse(result.out) as Record<string, string>;
    expect(printed.handle).toBe('alice/scout');
    expect(printed.profileUrl).toBe(
      'https://sealkeeper.run/agents/alice/scout',
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
      apiError(409, 'name_taken', 'alice/cli is taken, try cli-2'),
      'alice/cli is taken, try cli-2',
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
    expect(result.out).toContain('Registered alice/my-project-v2');
  });

  it('reports a network error on one line', async () => {
    const result = await run(world, 'init', '--api-url', 'https://down.test');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /\ncould not reach the SealKeeper API at https:\/\/down\.test: fetch failed\n$/,
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

  it('a second init without --force says already set up and leaves the key', async () => {
    expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
    const keyBefore = await readFile(paths(home).key, 'utf8');
    const keyStat = await stat(paths(home).key);

    world = newWorld();
    const result = await run(world, 'init');
    expect(result.code).toBe(0);
    expect(result.out).toContain('  ✓ Already set up as alice/scout\n');
    expect(result.out).toContain(
      '    Profile  https://sealkeeper.run/agents/alice/scout\n',
    );
    expect(result.err).not.toContain(TERMS);
    expect(result.out).not.toContain('operatorLogin');
    // Only the read of the verified count for Next. No sign in.
    expect(world.fetchUrls).toEqual([
      `${API_URL}/v1/agents/${(await loadKey(paths(home)))?.agentId}`,
    ]);
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
    expect(result.out).toContain('Registered alice/');
    expect(result.err).toMatch(
      /\n {2}✓ The old key is kept at .*key\.[^\n]*\.bak\n/,
    );
  });

  it('--force with --json names the kept key on stderr as before', async () => {
    expect((await run(world, 'init')).code).toBe(0);
    world = newWorld();
    const result = await run(world, 'init', '--force', '--json');
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/^the old key is kept at .*\.bak$/m);
    expect(JSON.parse(result.out)).toMatchObject({ name: expect.any(String) });
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
      // One read, for Next. The version is not looked up.
      expect(world.fetchUrls).toHaveLength(1);
      expect(world.versionChanges).toEqual([]);
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
      expect(result.out).toContain('Already set up as alice/scout');
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
      expect(result.all).not.toContain('hook');
      expect(result.all).not.toContain('Claude Code');
      expect(result.err).not.toContain(HOOKS_QUESTION);
      expect(result.out).toContain(
        '  1  Earn your first verified tasks with npx sealkeeper prove\n',
      );
    });

    it('honours CLAUDE_CONFIG_DIR when looking for Claude Code', async () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'elsewhere'));
      await mkdir(join(home, 'elsewhere'));
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.err).toContain(`  Claude Code\n  ${HOOKS_INTRO}\n`);
      expect(result.out).toContain(
        `  4  Record your Claude Code sessions with ${INSTALL_COMMAND}\n`,
      );
    });

    it('offers the hooks again on a repeat init when a hook has a stale path', async () => {
      await withClaudeCode(
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [{ type: 'command', command: STALE_HOOK }],
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
      expect(result.out).toContain('Already set up as alice/scout');
      expect(stdin.reads).toBe(1);
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
      expect(result.out).toContain(
        '  1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks\n',
      );
      const after = await readFile(settingsFile(), 'utf8');
      expect(after).not.toContain(STALE_SCRIPT);
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
      expect(result.out).toContain(`  ✓ Hooks in ${projectFile}\n`);
      expect(result.out).not.toContain(INSTALL_COMMAND);
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
                hooks: [{ type: 'command', command: STALE_HOOK }],
              },
            ],
          },
        }),
      );
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.out).toContain(`  ✓ Hooks in ${projectFile}\n`);
      const after = await readFile(projectFile, 'utf8');
      expect(after).not.toContain(STALE_SCRIPT);
      expect(after).toContain(JSON.stringify(HOOK_COMMAND).slice(1, -1));
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
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
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
      expect(result.out).not.toContain(INSTALL_COMMAND);
      expect(result.out).toContain(
        '  1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks\n',
      );
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
        `  ✓ /sealkeeper-prove in ${dirname(command)}\n`,
      );
      expect(await readFile(command, 'utf8')).toBe(PROVE_COMMAND_TEXT);
    });

    it('no longer recommends a global install when run through npx', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      world.npx = true;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(NEXT_NPX).toBe(
        'Hooks point at this npx copy. For a stable path run npm i -g sealkeeper and then sealkeeper adapter claude-code install.',
      );
      expect(result.all).not.toContain(NEXT_NPX);
      expect(result.all).not.toContain('npm i -g');
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
      expect(result.out).toContain(
        [
          '  1  Earn your first verified tasks with npx sealkeeper prove',
          '  2  Review and send what was recorded   npx sealkeeper sync',
          `  3  Bronze needs ${BRONZE.verifiedTasks} verified tasks over ${BRONZE.historyDays} days. Your badge updates on its own.`,
          '  4  Record your Claude Code sessions with npx sealkeeper adapter claude-code install',
        ].join('\n'),
      );
      expect(result.out).not.toContain('✓ Hooks');
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
      expect(result.out).toContain(INSTALL_COMMAND);
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
      expect(result.out).not.toContain(INSTALL_COMMAND);
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
    });

    it('refuses a settings file that is not JSON, names it and still registers', async () => {
      await withClaudeCode('{ "hooks": ');
      world.stdin = answering('y');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        `${settingsFile()} is not valid JSON, left it unchanged`,
      );
      expect(result.out).toContain(INSTALL_COMMAND);
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

    // What a terminal sent for down, down, up, up, then y. The screen
    // showed ^[[B^[[B^[[A^[[Ay.
    const ARROWS_THEN_Y = '\u001b[B\u001b[B\u001b[A\u001b[Ay';
    const AS_SHOWN = '^[[B^[[B^[[A^[[Ay';

    it('takes arrow keys out of the answer, so arrows then y is yes', async () => {
      await withClaudeCode();
      const stdin = answering(ARROWS_THEN_Y);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(1);
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
      expect(hooksIn(await readFile(settingsFile(), 'utf8'))).toContain('Stop');
      expect(result.all).not.toContain(HOOKS_NOT_INSTALLED);
    });

    it('reads the answer as the screen showed it as yes too', () => {
      expect(cleanAnswer(ARROWS_THEN_Y)).toBe('y');
      expect(cleanAnswer(AS_SHOWN)).toBe('y');
      expect(readYesNo(ARROWS_THEN_Y, 'yes')).toBe('yes');
      expect(readYesNo(AS_SHOWN, 'yes')).toBe('yes');
      expect(isYesByDefault(AS_SHOWN)).toBe(true);
      // SS3 arrows, as some terminals send them, a one byte CSI and other
      // control characters.
      expect(cleanAnswer('\u001bOA\u001bOBn')).toBe('n');
      expect(cleanAnswer('\u009b1;5Cyes\u0007\r')).toBe('yes');
      expect(readYesNo('\u001b[A', 'yes')).toBe('yes');
      expect(readYesNo('\u001b[Bnope', 'yes')).toBe('unclear');
      expect(readYesNo(null, 'yes')).toBe('no');
      expect(isYes(ARROWS_THEN_Y)).toBe(true);
    });

    it('asks again on an unclear answer and installs on a later y', async () => {
      await withClaudeCode();
      const stdin = answeringEach(['maybe', 'y']);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(2);
      expect(result.err).toContain(
        '  Please answer y or n. Install them now? [Y/n] ',
      );
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
    });

    it('counts as no after three unclear answers and says so with the command', async () => {
      await withClaudeCode();
      const stdin = answeringEach(['what', '\u001b[Bx', 'nope', 'y']);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(HOOKS_MAX_ASKS);
      expect(HOOKS_MAX_ASKS).toBe(3);
      expect(result.out).toContain(`  ${HOOKS_NOT_INSTALLED}\n`);
      expect(HOOKS_NOT_INSTALLED).toBe(
        'Hooks not installed. Run npx sealkeeper adapter claude-code install to install them later.',
      );
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('says in one line that a declined answer left the hooks out', async () => {
      await withClaudeCode();
      world.stdin = answering('n');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(
        result.out.split('\n').filter((l) => l.includes('Hooks not installed')),
      ).toEqual([`  ${HOOKS_NOT_INSTALLED}`]);
    });

    it('brings an outdated /sealkeeper-prove up to date on a repeat run', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const command = join(claudeDir(), 'commands', 'sealkeeper-prove.md');
      await writeFile(
        command,
        '---\ndescription: old\nmanaged-by: sealkeeper\n---\nRun `sealkeeper prove`.\n',
      );
      world = newWorld();
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(await readFile(command, 'utf8')).toBe(PROVE_COMMAND_TEXT);
      expect(result.out).toContain(
        `  ✓ /sealkeeper-prove updated in ${dirname(command)}\n`,
      );
      // Current already, so a third run says nothing about it.
      world = newWorld();
      world.stdin = answering('');
      expect((await run(world, 'init')).out).not.toContain('updated');
    });

    it('leaves a /sealkeeper-prove it did not write alone on a repeat run', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const command = join(claudeDir(), 'commands', 'sealkeeper-prove.md');
      await writeFile(command, 'my own command\n');
      world = newWorld();
      world.stdin = answering('');
      expect((await run(world, 'init')).code).toBe(0);
      expect(await readFile(command, 'utf8')).toBe('my own command\n');
    });
  });

  describe('Next from the state', () => {
    const claudeDir = () => join(home, 'claude');
    const next = (out: string) =>
      out
        .split('\n')
        .filter((l) => /^ {2}\d {2}/.test(l))
        .map((l) => l.slice(2));

    async function withClaudeCode(): Promise<void> {
      await mkdir(claudeDir(), { recursive: true });
      await writeFile(join(claudeDir(), 'settings.json'), '{}\n');
    }

    beforeEach(() => {
      world.serverVersion = '0.1.0';
    });

    it('starts with the hooks when they are not installed', async () => {
      await withClaudeCode();
      world.live = { verifiedTasks: 0, level: 'none' };
      world.stdin = answering('n');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(next(result.out)).toEqual([
        `1  Install the Claude Code hooks with ${INSTALL_COMMAND}`,
        '2  Then in Claude Code, run /sealkeeper-prove to earn your first verified tasks',
        '3  Review and send what was recorded   npx sealkeeper sync',
        '4  0 of 25 verified tasks toward bronze',
      ]);
    });

    it('with the hooks and nothing verified, says your first', async () => {
      await withClaudeCode();
      world.live = { verifiedTasks: 0, level: 'none' };
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  0 of 25 verified tasks toward bronze',
      ]);
    });

    it('with the hooks, 8 verified and auto sync on, as on a repeat run', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const config = await readConfig(paths(home));
      if (config === null) throw new Error('no config');
      await writeConfig({ ...config, autoSync: true }, paths(home));
      world = newWorld();
      world.serverVersion = '0.1.0';
      world.live = { verifiedTasks: 8, level: 'none' };
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-prove to earn verified tasks',
        '2  8 of 25 verified tasks toward bronze',
      ]);
    });

    it('at bronze, says the level', async () => {
      await withClaudeCode();
      world.live = { verifiedTasks: 30, level: 'bronze' };
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-prove to earn verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  Level bronze, with 30 verified tasks',
      ]);
      expect(bronzeLine(55, 'silver')).toBe(
        'Level silver, with 55 verified tasks',
      );
    });

    it('without Claude Code, has the agent run prove --json', async () => {
      world.live = { verifiedTasks: 2, level: 'none' };
      const result = await run(world, 'init', '--name', 'scout');
      expect(next(result.out)).toEqual([
        '1  Have your agent run npx sealkeeper prove --json to earn verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  2 of 25 verified tasks toward bronze',
      ]);
    });

    it('names the new API address once and falls back when the API moved', async () => {
      await withClaudeCode();
      world.serverVersion = undefined;
      world.agentMovedTo = 'https://api.sealkeeper.run';
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      const moved = `the API at ${API_URL} moved to https://api.sealkeeper.run, set apiUrl in ${join(home, 'config.json')} to it`;
      expect(result.err.split(moved)).toHaveLength(2);
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  Bronze needs 25 verified tasks over 3 days. Your badge updates on its own.',
      ]);
    });

    it('falls back to the generic steps when the API does not answer', async () => {
      await withClaudeCode();
      world.serverVersion = undefined;
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  Bronze needs 25 verified tasks over 3 days. Your badge updates on its own.',
      ]);
    });
  });

  describe('layout', () => {
    const claudeDir = () => join(home, 'claude');

    // The transcript with the temp home and the CLI version made stable.
    function normalised(text: string): string {
      return text.replaceAll(home, '<home>').replaceAll(VERSION, '<version>');
    }

    async function withClaudeCode(): Promise<void> {
      await mkdir(claudeDir(), { recursive: true });
      await writeFile(join(claudeDir(), 'settings.json'), '{}\n');
    }

    it('prints a first run with the hooks installed in plain form', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      // The answer to the question is typed by the person, so in a terminal
      // the line ends there. The fake input echoes nothing.
      expect(normalised(result.all)).toMatchInlineSnapshot(`
        "
          ◉ SealKeeper v<version>

          Prove your agent. A signed, portable track record
          anyone can check offline.

          By continuing you accept sealkeeper.run/terms and sealkeeper.run/privacy.

          Sign in with GitHub
          Open https://github.com/login/device and enter ABCD-1234
          ✓ Signed in as alice

          ✓ Registered alice/scout
            Profile  https://sealkeeper.run/agents/alice/scout

          What leaves this machine
          Tool names, durations, outcomes, session boundaries and token counts,
          each signed with your key. Never prompts, tool inputs or outputs,
          file contents or model output.
          Full list  npx sealkeeper what-is-shared

          Claude Code
          The hooks record each session and tool call, names and timings only, into a local log.
          Install them now? [Y/n]   ✓ Hooks in <home>/claude/settings.json
          ✓ /sealkeeper-prove in <home>/claude/commands

          Next
          1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks
          2  Review and send what was recorded   npx sealkeeper sync
          3  Bronze needs 25 verified tasks over 3 days. Your badge updates on its own.

          Mastra or OpenClaw  https://sealkeeper.run/docs/init#adapters

        "
      `);
      expect(result.all).not.toContain(String.fromCharCode(27));
      expect(result.all).not.toContain('╭');
    });

    it('prints a repeat run in plain form', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      world = newWorld();
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(normalised(result.all)).toMatchInlineSnapshot(`
        "
          ◉ SealKeeper v<version>

          Prove your agent. A signed, portable track record
          anyone can check offline.

          ✓ Already set up as alice/scout
            Profile  https://sealkeeper.run/agents/alice/scout

          Claude Code
          The hooks record each session and tool call, names and timings only, into a local log.
          ✓ Hooks in <home>/claude/settings.json

          Next
          1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks
          2  Review and send what was recorded   npx sealkeeper sync
          3  Bronze needs 25 verified tasks over 3 days. Your badge updates on its own.

          Mastra or OpenClaw  https://sealkeeper.run/docs/init#adapters

        "
      `);
    });

    it('prints the welcome box and colours with FORCE_COLOR', async () => {
      vi.stubEnv('FORCE_COLOR', '1');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.err).toContain(String.fromCharCode(27));
      expect(result.err).toContain('╭');
      expect(result.err).toContain('╯');
      expect(result.err).toContain(`v${VERSION}`);
      const plain = stripStyle(result.all);
      expect(plain).toContain(`│ ◉ SealKeeper v${VERSION}`);
      for (const text of TAGLINE) expect(plain).toContain(`│ ${text}`);
      expect(plain).toContain(
        '  Open https://github.com/login/device and enter ABCD-1234',
      );
      expect(plain).toContain(`  Mastra or OpenClaw  ${ADAPTERS_URL}`);
    });

    it('with FORCE_COLOR and --json prints no escape codes and no box', async () => {
      vi.stubEnv('FORCE_COLOR', '1');
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      expect(result.all).not.toContain(String.fromCharCode(27));
      expect(result.all).not.toContain('SealKeeper v');
      expect(JSON.parse(result.out)).toMatchObject({ name: 'scout' });
    });

    it('prints a Claude Code section only when the config folder exists', async () => {
      const without = await run(world, 'init', '--name', 'scout');
      expect(without.err).not.toContain('Claude Code');
      await rm(paths(home).config, { force: true });
      await withClaudeCode();
      world = newWorld();
      world.stdin = answering('n');
      const withDir = await run(world, 'init', '--name', 'scout');
      expect(withDir.err).toContain(
        `\n  Claude Code\n  ${HOOKS_INTRO}\n  ${HOOKS_QUESTION}`,
      );
    });

    it('starts Next with the slash command only when the hooks are in', async () => {
      const first = (text: string) =>
        text.split('\n').find((l) => l.startsWith('  1  '));
      await withClaudeCode();
      world.stdin = answering('n');
      const declined = await run(world, 'init', '--name', 'scout');
      expect(first(declined.out)).toBe(
        '  1  Earn your first verified tasks with npx sealkeeper prove',
      );
      world = newWorld();
      world.stdin = answering('y');
      const installed = await run(world, 'init');
      expect(first(installed.out)).toBe(
        '  1  In Claude Code, run /sealkeeper-prove to earn your first verified tasks',
      );
      expect(installed.out).not.toContain(INSTALL_COMMAND);
    });

    describe('untrusted text', () => {
      const ESC = String.fromCharCode(27);
      // A login with a colour code, an OSC 52 clipboard write and a bidi
      // override, as a hostile API could send it, and a device code with
      // a cursor move, as a hostile GitHub stand in could.
      const LOGIN = `evil${ESC}[31m${ESC}]52;c;aGk=\u0007\u202eyx`;
      const LOGIN_SHOWN = 'evil\\u001b[31m\\u001b]52;c;aGk=\\u0007\\u202eyx';
      const CODE = `AB${ESC}[2J12`;
      const CODE_SHOWN = 'AB\\u001b[2J12';

      function hostile(): void {
        world.userCode = CODE;
        world.api = (payload) => {
          const reply = created(payload);
          return {
            ...reply,
            body: {
              ...(reply.body as Record<string, unknown>),
              operator: { login: LOGIN },
            },
          };
        };
      }

      // Every ESC written is the start of one of our colour codes.
      function onlyOurCodes(text: string): void {
        const escs = text.split(ESC).length - 1;
        const codes = text.match(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')) ?? [];
        expect(escs).toBe(codes.length);
        expect(text).not.toContain('\u202e');
        expect(text).not.toContain('\u0007');
      }

      it('escapes a hostile login and device code in plain form', async () => {
        hostile();
        const result = await run(world, 'init', '--name', 'scout');
        expect(result.code).toBe(0);
        expect(result.all).not.toContain(ESC);
        expect(result.out).toContain(`  ✓ Signed in as ${LOGIN_SHOWN}\n`);
        expect(result.out).toContain(`  ✓ Registered ${LOGIN_SHOWN}/scout\n`);
        expect(result.err).toContain(`and enter ${CODE_SHOWN}\n`);
        onlyOurCodes(result.all);
      });

      it('escapes a hostile login and device code inside styled lines', async () => {
        vi.stubEnv('FORCE_COLOR', '1');
        hostile();
        const result = await run(world, 'init', '--name', 'scout');
        expect(result.code).toBe(0);
        expect(result.all).toContain(`${ESC}[1m${LOGIN_SHOWN}${ESC}[22m`);
        expect(stripStyle(result.out)).toContain(
          `  ✓ Signed in as ${LOGIN_SHOWN}\n`,
        );
        expect(stripStyle(result.err)).toContain(`and enter ${CODE_SHOWN}\n`);
        onlyOurCodes(result.all);
      });

      it('escapes a hostile login from the config file on a repeat run', async () => {
        vi.stubEnv('FORCE_COLOR', '1');
        expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
        const config = await readConfig(paths(home));
        if (config === null) throw new Error('no config');
        await writeConfig({ ...config, operatorLogin: LOGIN }, paths(home));
        world = newWorld();
        const result = await run(world, 'init');
        expect(result.code).toBe(0);
        expect(stripStyle(result.out)).toContain(
          `  ✓ Already set up as ${LOGIN_SHOWN}/scout\n`,
        );
        expect(stripStyle(result.out)).toContain(
          `https://sealkeeper.run/agents/${LOGIN_SHOWN}`,
        );
        onlyOurCodes(result.all);
      });
    });

    it('prints paths under the home directory with a tilde', () => {
      expect(tildePath('/Users/c/.claude/settings.json', '/Users/c')).toBe(
        '~/.claude/settings.json',
      );
      expect(tildePath('/Users/c', '/Users/c')).toBe('~');
      expect(tildePath('/Users/cx/a', '/Users/c')).toBe('/Users/cx/a');
      expect(tildePath('/tmp/a', '')).toBe('/tmp/a');
    });
  });
});
