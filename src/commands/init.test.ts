// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  base64urlDecode,
  decodeHeader,
  EventType,
  readAudience,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wasAskedRuntime } from '../agent-runtime.js';
import {
  cleanAnswer,
  type Input,
  isYes,
  readYesNo,
  streamInput,
} from '../ask.js';
import {
  ROUTINE_INSTALL_COMMAND,
  runCommandText,
} from '../claude-code-command.js';
import { hookCommand, invocationOf } from '../claude-code-settings.js';
import {
  DEFAULT_API_URL,
  namedHome,
  paths,
  readConfig,
  readFolderMap,
  readNudge,
  readRoutineConfig,
  writeConfig,
} from '../config.js';
import { tildePath } from '../files.js';
import {
  ACCESS_TOKEN_URL,
  CODE_EXPIRED,
  DEVICE_CODE_URL,
  MISSING_CLIENT_ID,
} from '../github-device.js';
import { loadKey } from '../identity.js';
import { appendEvent, countPending } from '../log.js';
import { isManaged } from '../managed.js';
import { nudgeLines } from '../nudge.js';
import { readOperatorSlug } from '../operator-slug.js';
import { createProgram } from '../program.js';
import { readRoutine } from '../routine.js';
import { copyPaths, copyVersion } from '../routine-copy.js';
import type { Runner } from '../routine-scheduler.js';
import { stripStyle } from '../style.js';
import { describeTaxonomy, isSent, NEVER_LEAVES } from '../taxonomy.js';
import { VERSION } from '../version.js';
import { INSTALL_COMMAND } from './adapter.js';
import {
  ACCOUNT_URL,
  ADAPTERS_URL,
  BRONZE,
  bronzeLine,
  CONSENT,
  folderLine,
  GAME_QUESTION,
  HOOKS_BY_CLAUDE,
  HOOKS_INTRO,
  HOOKS_MAX_ASKS,
  HOOKS_NOT_INSTALLED,
  HOOKS_QUESTION,
  homeTaken,
  INPUT_CLOSED,
  isYesByDefault,
  leftBehindLine,
  MACHINE_AGENTS_SHOWN,
  machineAgentsLine,
  NEXT_HOOKS,
  NEXT_NPX,
  NEXT_POST,
  NEXT_ROUTINE,
  NEXT_RUN,
  NEXT_WHAT_IS_SHARED,
  NO_NAME,
  NOTHING_SENT,
  NUDGE_INTRO,
  NUDGE_NOT_ON,
  nameQuestion,
  otherApiLine,
  ROUTINE_EARLIER_LINE,
  ROUTINE_NOT_INSTALLED,
  ROUTINE_TIME_LINE,
  routinePresentLine,
  runtimeNameLine,
  runtimeNameNudge,
  SHARED_SUMMARY,
  TAGLINE,
  versionQuestion,
} from './init.js';
import {
  FIRST_RUN_QUESTION,
  INSTALL_QUESTION,
  startInProcess,
} from './routine.js';

const TOKEN = 'gho_THIS_TOKEN_MUST_NEVER_LEAK_0123456789';
const HOOK_COMMAND = hookCommand(
  '/usr/local/bin/node',
  '/usr/local/lib/node_modules/sealkeeper/dist/index.js',
);
// A hook of ours that an earlier install wrote from another path.
const STALE_SCRIPT = '/old/.npm/_npx/abc/node_modules/sealkeeper/dist/index.js';
const STALE_HOOK = hookCommand('/usr/local/bin/node', STALE_SCRIPT);
const RUN_COMMAND_TEXT = runCommandText(invocationOf(HOOK_COMMAND));
const API_URL = 'https://api.test';
// Where the routine offer finds claude, when a test puts it on PATH.
const CLAUDE = '/usr/local/bin/claude';
const PROGRAM = ['/usr/local/bin/node', '/opt/sealkeeper/dist/index.js'];
const NPX_PROGRAM = ['/usr/local/bin/node', STALE_SCRIPT];
// What a bundle the routine tests copy holds (RS-2).
const BUNDLE = '#!/usr/bin/env node\n// the sealkeeper bundle\n';

// Every signed payload names the API it is for (VOU-111). The fake takes
// aud off before it parses, and a payload without the right aud fails the
// test that sent it.
const audErrors: unknown[] = [];
// The aud of every signed payload the fake took, in order.
const auds: unknown[] = [];
const unsigned = (payload: unknown) => {
  auds.push((payload as { aud?: unknown }).aud);
  const check = readAudience(payload, [API_URL]);
  if (check.result !== 'match') audErrors.push(payload);
  return check.payload;
};
afterEach(() => {
  auds.length = 0;
  expect(audErrors.splice(0)).toEqual([]);
});

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
  // The repository name of the git remote. None when not set.
  repo?: string;
  // The environment runtime detection reads. Empty when not set, so the
  // variables of whatever runs the tests never leak in.
  env?: NodeJS.ProcessEnv;
  // The operator slug GET /v1/agents/:id answers with, and the handle
  // built from it. Needs serverVersion set, else the route fails.
  slug?: string;
  // How many agents GET /v1/agents?operator= lists. Unset means that
  // route fails.
  operatorAgents?: number;
  // The runtime GET /v1/agents/:id answers with. A signed PATCH sets it.
  runtime?: string;
  // Every signed PATCH that set a runtime.
  runtimeChanges?: Record<string, unknown>[];
  // Whether claude is on PATH, for the routine offer. Off when not set,
  // so the machine running the tests never counts.
  claude?: boolean;
  // Every scheduler command the routine offer ran, as file and args
  // joined. The fake scheduler is launchd and answers every call with 0.
  scheduler: string[];
  // A real script the CLI runs from, which routine install copies. Unset
  // means PROGRAM or NPX_PROGRAM, whose scripts do not exist.
  bundle?: string;
  // The goal GET /v1/agents/:id/goal answers with, for the agent and
  // version registered last. Unset means that route fails.
  goal?: Record<string, unknown>;
  // The game switch POST /v1/game/status answers with. Unset means that
  // route fails like an unreachable API.
  game?: boolean;
  // The signed payload of every game status read.
  gameReads?: Record<string, unknown>[];
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
      const payload = unsigned(
        (await verify(envelope, base64urlDecode(kid))).payload,
      );
      const registration = payload as Record<string, unknown>;
      world.registrations.push(registration);
      const reply = world.api(registration);
      return Response.json(reply.body, { status: reply.status });
    }
    if (url === `${API_URL}/v1/game/status` && world.game !== undefined) {
      const { envelope } = JSON.parse(String(init.body)) as {
        envelope: string;
      };
      const { kid } = decodeHeader(envelope);
      const payload = unsigned(
        (await verify(envelope, base64urlDecode(kid))).payload,
      ) as Record<string, unknown>;
      world.gameReads = [...(world.gameReads ?? []), payload];
      return Response.json({
        enabled: world.game,
        cap: 5,
        usedToday: 0,
        resetAt: '2026-09-24T00:00:00.000Z',
      });
    }
    if (url.startsWith(`${API_URL}/v1/agents?`)) {
      if (world.operatorAgents === undefined)
        throw new TypeError('fetch failed');
      return Response.json({
        agents: Array.from({ length: world.operatorAgents }, () => ({})),
        nextCursor: null,
      });
    }
    const goalRoute =
      /^https:\/\/api\.test\/v1\/agents\/([A-Za-z0-9_-]{43})\/goal$/.exec(url);
    if (goalRoute && world.goal !== undefined) {
      return Response.json({
        ...world.goal,
        agentId: goalRoute[1],
        version: world.registrations.at(-1)?.version,
      });
    }
    const agentRoute =
      /^https:\/\/api\.test\/v1\/agents\/([A-Za-z0-9_-]{43})$/.exec(url);
    if (
      agentRoute &&
      world.agentMovedTo !== undefined &&
      (init.method ?? 'GET') === 'GET'
    ) {
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
        const payload = unsigned(
          (await verify(envelope, base64urlDecode(kid))).payload,
        );
        const change = payload as { version?: string; runtime?: string };
        if (change.runtime !== undefined) {
          world.runtimeChanges = [...(world.runtimeChanges ?? []), change];
          world.runtime = change.runtime;
        } else {
          world.versionChanges.push(change);
          world.serverVersion = change.version;
        }
      }
      return Response.json({
        id: agentRoute[1],
        name: 'scout',
        version: world.serverVersion,
        operator:
          world.slug === undefined
            ? { login: 'alice' }
            : { login: 'alice', slug: world.slug, displayName: world.slug },
        ...(world.slug === undefined ? {} : { handle: `${world.slug}/scout` }),
        ...(world.runtime === undefined ? {} : { runtime: world.runtime }),
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
      repoName: async () => world.repo ?? null,
      env: () => world.env ?? {},
    },
    // The routine offer, on a fake launchd in the temp home. Never the
    // real scheduler, and never the real PATH.
    routine: {
      fetch: fakeFetch(world),
      run: fakeScheduler(world),
      platform: () => 'darwin',
      homedir: () => process.env.SEALKEEPER_HOME ?? '',
      uid: () => 501,
      stdin: world.stdin ? () => world.stdin as Input : undefined,
      findAgent: async () => (world.claude ? CLAUDE : null),
      cli: () => {
        const program =
          world.bundle === undefined
            ? world.npx
              ? NPX_PROGRAM
              : PROGRAM
            : [process.execPath, world.bundle];
        return { program, invocation: program.join(' ') };
      },
      // No test ever starts a real agent.
      spawner: () => {
        throw new Error('init tests start no agent');
      },
      // The first run in this process, never a real one (RS-9).
      startRun: startInProcess,
      pollMs: 5,
      // Plain output whatever runs the tests, and never the real SIGINT.
      stdoutTTY: () => false,
      interrupt: () => () => undefined,
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

function fakeScheduler(world: World): Runner {
  return async (file, args) => {
    world.scheduler.push([file, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
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
      scheduler: [],
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
        '    Game  on, turn it off with npx sealkeeper game off',
        '',
        '  Next',
        '  1  Earn your first verified tasks with npx sealkeeper run',
        '  2  Review and send what was recorded   npx sealkeeper sync',
        '  3  Bronze needs 25 verified tasks with a Trust Score of 50 over 3 days and 5 posted tasks another agent completed. Your badge updates on its own.',
        '  4  After the first verified tasks, post one for other agents with npx sealkeeper tasks post',
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
        // Nobody to ask, so the default.
        gameEnabled: true,
      },
    ]);
    // The API URL came from SEALKEEPER_API_URL alone, so it is not saved.
    expect(await readConfig(paths(home))).toEqual({
      agentId,
      operatorLogin: 'alice',
      name: 'scout',
      version: '0.1.0',
      apiUrl: DEFAULT_API_URL,
      registeredAt: '2026-09-23T10:00:00.000Z',
    });
    expect((await stat(paths(home).key)).mode & 0o777).toBe(0o600);
    await expectNoTokenAnywhere(result);
  });

  it('says registering accepts the terms and the privacy policy, right before the device code', async () => {
    const result = await run(world, 'init', '--name', 'scout');
    expect(result.code).toBe(0);
    expect(CONSENT).toBe(
      'Registering this agent means you accept the terms (https://sealkeeper.run/terms) and the privacy policy (https://sealkeeper.run/privacy).',
    );
    const lines = result.err.split('\n');
    const consent = lines.indexOf(`  ${CONSENT}`);
    const device = lines.findIndex((l) =>
      l.includes('Open https://github.com/login/device'),
    );
    expect(consent).toBeGreaterThanOrEqual(0);
    // Only the blank line and the sign in heading sit between them.
    expect(lines.slice(consent + 1, device)).toEqual([
      '',
      '  Sign in with GitHub',
    ]);
    expect(result.err.split(CONSENT)).toHaveLength(2);
    expect(result.out).not.toContain(CONSENT);
  });

  it('with --json says it on stderr before the device code and keeps it off stdout', async () => {
    const result = await run(world, 'init', '--name', 'scout', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ name: 'scout' });
    expect(result.out).not.toContain(CONSENT);
    const lines = result.err.split('\n');
    const consent = lines.indexOf(CONSENT);
    const device = lines.findIndex((l) =>
      l.includes('https://github.com/login/device'),
    );
    expect(consent).toBeGreaterThanOrEqual(0);
    expect(device).toBeGreaterThan(consent);
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
    for (const type of EventType.options.filter(isSent)) {
      expect(result.err).toMatch(
        new RegExp(`^${type.replace('.', '\\.')}$`, 'm'),
      );
    }
    // No hook or adapter sends it since 0.4.14 (VOU-451).
    expect(result.err).not.toMatch(/^tool\.call$/m);
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

  it('uses SEALKEEPER_API_URL for the run but never saves it (cli-core-3)', async () => {
    const result = await run(world, 'init', '--json');
    expect(result.code).toBe(0);
    expect(world.fetchUrls).toContain(`${API_URL}/v1/agents`);
    expect(JSON.parse(result.out)).toMatchObject({ apiUrl: API_URL });
    expect((await readConfig(paths(home)))?.apiUrl).toBe(DEFAULT_API_URL);
  });

  it('keeps the old URL under --force when SEALKEEPER_API_URL is set', async () => {
    vi.stubEnv('SEALKEEPER_API_URL', '');
    expect((await run(world, 'init', '--api-url', API_URL)).code).toBe(0);
    vi.stubEnv('SEALKEEPER_API_URL', API_URL);
    world = newWorld();
    expect((await run(world, 'init', '--force')).code).toBe(0);
    expect((await readConfig(paths(home)))?.apiUrl).toBe(API_URL);
  });

  it('names the API origin on stderr before the device code when it is not SealKeeper', async () => {
    const result = await run(world, 'init', '--api-url', API_URL);
    expect(result.code).toBe(0);
    const line = otherApiLine(API_URL);
    expect(line).toBe(
      'This sign in sends your GitHub token to the API at https://api.test, not https://api.sealkeeper.run.',
    );
    const lines = result.err.split('\n');
    const warned = lines.indexOf(`  ${line}`);
    const device = lines.findIndex((l) =>
      l.includes('Open https://github.com/login/device'),
    );
    expect(warned).toBeGreaterThanOrEqual(0);
    expect(warned).toBeLessThan(device);
    expect(result.out).not.toContain(line);

    world = newWorld();
    await rm(paths(home).config, { force: true });
    const json = await run(world, 'init', '--json');
    const jsonLines = json.err.split('\n');
    expect(jsonLines.indexOf(line)).toBeGreaterThanOrEqual(0);
    expect(jsonLines.indexOf(line)).toBeLessThan(jsonLines.indexOf(CONSENT));
  });

  it('says nothing about the API when it is SealKeeper', async () => {
    vi.stubEnv('SEALKEEPER_API_URL', '');
    // The fake world answers only api.test, so the registration fails after
    // the device flow. The sign in is what this test looks at.
    const result = await run(world, 'init', '--json');
    expect(result.err).toContain(CONSENT);
    expect(result.err).not.toContain('This sign in sends your GitHub token');
  });

  it('signs the registration for the origin of --api-url', async () => {
    vi.stubEnv('SEALKEEPER_API_URL', 'https://unreachable.test');
    const result = await run(world, 'init', '--api-url', `${API_URL}/`);
    expect(result.code).toBe(0);
    expect(world.registrations).toHaveLength(1);
    expect(auds).toEqual([API_URL]);
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
    expect(result.err).not.toContain(CONSENT);
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

  it('--force starts the cursor at the end of the log (cli-core-6)', async () => {
    expect((await run(world, 'init')).code).toBe(0);
    const logged = (n: number) => ({
      event_id: randomUUID(),
      type: 'session.end' as const,
      occurred_at: new Date().toISOString(),
      version: '0.1.0',
      payload: { session_id: 's1', duration_ms: n },
    });
    await appendEvent(logged(1), paths(home));
    await appendEvent(logged(2), paths(home));
    expect(await countPending(paths(home))).toBe(2);

    world = newWorld();
    const result = await run(world, 'init', '--force');
    expect(result.code).toBe(0);
    expect(result.err).toContain(`  ${leftBehindLine(2)}\n`);
    expect(leftBehindLine(2)).toBe(
      '2 unsent events of the old key stay in the log and are never sent under the new key.',
    );
    expect(await countPending(paths(home))).toBe(0);
    // What the new key logs is sent as usual.
    await appendEvent(logged(3), paths(home));
    expect(await countPending(paths(home))).toBe(1);

    world = newWorld();
    const again = await run(world, 'init', '--force', '--json');
    expect(again.code).toBe(0);
    expect(again.err).toContain(`${leftBehindLine(1)}\n`);
    expect(await countPending(paths(home))).toBe(0);
  });

  it('a plain init that makes a key starts the cursor at the end of the log', async () => {
    // A home an older logout --delete-key left behind, with the log and no
    // cursor and no key.
    const logged = (n: number) => ({
      event_id: randomUUID(),
      type: 'session.end' as const,
      occurred_at: new Date().toISOString(),
      version: '0.1.0',
      payload: { session_id: 's1', duration_ms: n },
    });
    await appendEvent(logged(1), paths(home));
    await appendEvent(logged(2), paths(home));
    await rm(paths(home).cursor, { force: true });
    expect(await loadKey(paths(home))).toBeNull();
    expect(await countPending(paths(home))).toBe(2);

    const result = await run(world, 'init');
    expect(result.code).toBe(0);
    expect(result.err).toContain(`  ${leftBehindLine(2)}\n`);
    expect(await countPending(paths(home))).toBe(0);
    // What the new key logs is sent as usual.
    await appendEvent(logged(3), paths(home));
    expect(await countPending(paths(home))).toBe(1);

    // A key already there owns its log, so a plain init that loads it
    // leaves the cursor alone.
    await rm(paths(home).config, { force: true });
    world = newWorld();
    const again = await run(world, 'init', '--json');
    expect(again.code).toBe(0);
    expect(again.err).not.toContain('unsent event');
    expect(await countPending(paths(home))).toBe(1);
  });

  it('a plain init with --json names the events left behind on stderr', async () => {
    await appendEvent(
      {
        event_id: randomUUID(),
        type: 'session.end' as const,
        occurred_at: new Date().toISOString(),
        version: '0.1.0',
        payload: { session_id: 's1', duration_ms: 1 },
      },
      paths(home),
    );
    const result = await run(world, 'init', '--json');
    expect(result.code).toBe(0);
    expect(result.err).toContain(`${leftBehindLine(1)}\n`);
    expect(result.out).not.toContain('unsent event');
    expect(await countPending(paths(home))).toBe(0);
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
    expect((await run(world, 'init', '--api-url', API_URL)).code).toBe(0);
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
    expect(world.registrations).toHaveLength(1);
    // SEALKEEPER_API_URL was used and not saved, and there was no old URL.
    expect((await readConfig(paths(home)))?.apiUrl).toBe(DEFAULT_API_URL);
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

  it.each([
    [['--name', 'bad name!'], 'invalid agent name bad name!'],
    [['--name', 'scout', '--runtime', 'gpt'], 'invalid runtime gpt'],
    [
      ['--name', 'scout', '--api-url', 'http://api.example.com'],
      'invalid API URL http://api.example.com',
    ],
  ])(
    'names a bad flag %j before a missing client id (VOU-311)',
    async (flags, message) => {
      vi.stubEnv('SEALKEEPER_GITHUB_CLIENT_ID', '');
      const result = await run(world, 'init', ...flags);
      expect(result.code).toBe(1);
      expect(result.err).toContain(message);
      expect(result.err).not.toContain(MISSING_CLIENT_ID);
      expect(world.fetchUrls).toEqual([]);
    },
  );
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
      // One more read for the session nudge question, once hooks are in.
      expect(stdin.reads).toBe(3);
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
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
      );
      expect(result.code).toBe(0);
      // Only the game question.
      expect((world.stdin as Input & { reads: number }).reads).toBe(1);
      expect(result.all).not.toContain('hook');
      expect(result.all).not.toContain('Claude Code');
      expect(result.err).not.toContain(HOOKS_QUESTION);
      expect(result.out).toContain(
        '  1  Earn your first verified tasks with npx sealkeeper run\n',
      );
    });

    it('honours CLAUDE_CONFIG_DIR when looking for Claude Code', async () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'elsewhere'));
      await mkdir(join(home, 'elsewhere'));
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      expect(result.err).toContain(`  Claude Code\n  ${HOOKS_INTRO}\n`);
      expect(result.out).toContain(
        `  5  Record your Claude Code sessions with ${INSTALL_COMMAND}\n`,
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
      expect(
        (
          await run(
            world,
            'init',
            '--name',
            'scout',
            '--runtime',
            'claude-code',
          )
        ).code,
      ).toBe(0);
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.out).toContain('Already set up as alice/scout');
      // One more read for the session nudge question, once hooks are in.
      expect(stdin.reads).toBe(2);
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
      expect(result.out).toContain(
        '  1  In Claude Code, run /sealkeeper-run to earn your first verified tasks\n',
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
      const projectFile = join(project, '.claude', 'settings.local.json');
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
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      // One read for the game question, and one more for the session nudge
      // question, once hooks are in.
      expect(stdin.reads).toBe(2);
      expect(result.err).not.toContain(HOOKS_QUESTION);
      expect(result.out).toContain(`  ✓ Hooks in ${projectFile}\n`);
      expect(result.out).not.toContain(INSTALL_COMMAND);
      // No second set in the user settings.
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    // VOU-451. The hooks record sessions only, so a repeat init that finds
    // ours takes out the tool call hooks an older install wrote.
    it.each([
      ['user', false],
      ['project', true],
    ])(
      'a repeat init removes the tool call hooks from the %s settings and leaves the rest',
      async (_scope, project) => {
        await withClaudeCode();
        const cwd = join(home, 'project');
        world.cwd = cwd;
        const file = project
          ? join(cwd, '.claude', 'settings.local.json')
          : settingsFile();
        const ours = [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }];
        const foreign = {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'other-tool check' }],
        };
        await mkdir(dirname(file), { recursive: true });
        await writeFile(
          file,
          JSON.stringify({
            model: 'opus',
            hooks: {
              Stop: [
                { hooks: [{ type: 'command', command: 'other-tool stop' }] },
                ...ours,
              ],
              SessionStart: ours,
              SessionEnd: ours,
              PreToolUse: [foreign, ...ours],
              PostToolUse: ours,
              PostToolUseFailure: ours,
            },
          }),
        );
        const stdin = answering('');
        world.stdin = stdin;
        const result = await run(
          world,
          'init',
          '--name',
          'scout',
          '--runtime',
          'claude-code',
        );
        expect(result.code).toBe(0);
        expect(result.err).not.toContain(HOOKS_QUESTION);
        expect(result.out).toContain(
          `  Removed the tool call hooks from ${tildePath(file)}, the hooks record sessions only\n`,
        );
        const after = JSON.parse(await readFile(file, 'utf8'));
        expect(after.model).toBe('opus');
        expect(hooksIn(JSON.stringify(after))).toEqual([
          'Stop',
          'SessionStart',
          'SessionEnd',
        ]);
        expect(after.hooks.PreToolUse).toEqual([foreign]);
        expect(after.hooks.Stop[0]).toEqual({
          hooks: [{ type: 'command', command: 'other-tool stop' }],
        });

        // Run again, there is nothing left to take out.
        world = newWorld();
        world.cwd = cwd;
        world.stdin = answering('');
        const again = await run(world, 'init');
        expect(again.code).toBe(0);
        expect(again.out).not.toContain('Removed the tool call hooks');
      },
    );

    it('moves current hooks in the shared project settings to the local file without asking', async () => {
      await withClaudeCode();
      const project = join(home, 'project');
      world.cwd = project;
      await mkdir(join(project, '.claude'), { recursive: true });
      const sharedFile = join(project, '.claude', 'settings.json');
      const projectFile = join(project, '.claude', 'settings.local.json');
      await writeFile(
        sharedFile,
        JSON.stringify({
          model: 'opus',
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
          },
        }),
      );
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      // Only the game and session nudge questions are read, the hooks are
      // not asked.
      expect(stdin.reads).toBe(2);
      expect(result.err).not.toContain(HOOKS_QUESTION);
      expect(result.out).toContain(`  ✓ Hooks in ${projectFile}\n`);
      expect(result.out).toContain(`Moved the hooks out of ${sharedFile}`);
      expect(hooksIn(await readFile(projectFile, 'utf8'))).toContain('Stop');
      // The shared file a repo commits keeps its own settings and none of
      // this machine's paths.
      expect(JSON.parse(await readFile(sharedFile, 'utf8'))).toEqual({
        model: 'opus',
      });
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('moves old hooks in the shared project settings to the local file, not to the user settings', async () => {
      await withClaudeCode();
      const project = join(home, 'project');
      world.cwd = project;
      await mkdir(join(project, '.claude'), { recursive: true });
      const sharedFile = join(project, '.claude', 'settings.json');
      const projectFile = join(project, '.claude', 'settings.local.json');
      await writeFile(
        sharedFile,
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
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      expect(result.out).toContain(`  ✓ Hooks in ${projectFile}\n`);
      const after = await readFile(projectFile, 'utf8');
      expect(after).not.toContain(STALE_SCRIPT);
      expect(after).toContain(JSON.stringify(HOOK_COMMAND).slice(1, -1));
      // The shared file a repo commits keeps no machine paths of ours.
      expect(await readFile(sharedFile, 'utf8')).toBe('{}');
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('asks nothing on a repeat init when the hooks are current', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect(
        (
          await run(
            world,
            'init',
            '--name',
            'scout',
            '--runtime',
            'claude-code',
          )
        ).code,
      ).toBe(0);
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
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      // One read for the game question, and one more for the session nudge
      // question, once hooks are in.
      expect(stdin.reads).toBe(3);
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
      expect(result.out).not.toContain(INSTALL_COMMAND);
      expect(result.out).toContain(
        '  1  In Claude Code, run /sealkeeper-run to earn your first verified tasks\n',
      );
      const after = await readFile(settingsFile(), 'utf8');
      expect(hooksIn(after)).toEqual(['Stop', 'SessionStart', 'SessionEnd']);
      expect(after).toContain('other-tool stop');
      const command = join(claudeDir(), 'commands', 'sealkeeper-run.md');
      expect(result.out).toContain(
        `  ✓ /sealkeeper-run in ${dirname(command)}\n`,
      );
      expect(await readFile(command, 'utf8')).toBe(RUN_COMMAND_TEXT);
    });

    it('no longer recommends a global install when run through npx', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      world.npx = true;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
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
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.out).not.toContain(NEXT_NPX);
    });

    it('prints the command instead on n and leaves the settings alone', async () => {
      await withClaudeCode();
      world.stdin = answering('n');
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      expect(result.err).toContain(HOOKS_QUESTION);
      expect(result.out).toContain(
        [
          '  1  Earn your first verified tasks with npx sealkeeper run',
          '  2  Review and send what was recorded   npx sealkeeper sync',
          `  3  Bronze needs ${BRONZE.verifiedTasks} verified tasks with a Trust Score of ${BRONZE.trustScore} over ${BRONZE.historyDays} days and ${BRONZE.postedTasks} posted tasks another agent completed. Your badge updates on its own.`,
          `  4  ${NEXT_POST}`,
          '  5  Record your Claude Code sessions with npx sealkeeper adapter claude-code install',
        ].join('\n'),
      );
      expect(result.out).not.toContain('✓ Hooks');
      expect(NEXT_HOOKS).toBe(
        'Run npx sealkeeper adapter claude-code install to record your Claude Code sessions',
      );
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
      expect(
        await readIfExists(join(claudeDir(), 'commands', 'sealkeeper-run.md')),
      ).toBe('');
    });

    it('does not ask without a terminal and prints the command', async () => {
      await withClaudeCode();
      const stdin = answering('y', false);
      world.stdin = stdin;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
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
        NEXT_RUN,
        NEXT_WHAT_IS_SHARED,
        NEXT_POST,
        NEXT_HOOKS,
      ]);
      expect(await readFile(settingsFile(), 'utf8')).toBe(EXISTING);
    });

    it('with --json and no Claude Code lists three next steps', async () => {
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      const printed = JSON.parse(result.out) as { nextSteps: string[] };
      expect(printed.nextSteps).toEqual([
        NEXT_RUN,
        NEXT_WHAT_IS_SHARED,
        NEXT_POST,
      ]);
      expect(NEXT_POST).toBe(
        'After the first verified tasks, post one for other agents with npx sealkeeper tasks post',
      );
    });

    it('does not ask when the hooks are already there', async () => {
      await withClaudeCode(
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }, null, 2)}\n`,
      );
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      // One read for the game question, and one more for the session nudge
      // question, once hooks are in.
      expect(stdin.reads).toBe(2);
      expect(result.out).not.toContain(INSTALL_COMMAND);
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
    });

    it('refuses a settings file that is not JSON, names it and still registers', async () => {
      await withClaudeCode('{ "hooks": ');
      world.stdin = answering('y');
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
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
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      // One read for the game question, and one more for the session nudge
      // question, once hooks are in.
      expect(stdin.reads).toBe(3);
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
      // Enter at the game question before, and at the nudge that follows.
      const stdin = answeringEach(['', 'maybe', 'y', '']);
      world.stdin = stdin;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      // One read for the game question, and one more for the session nudge
      // question, once hooks are in.
      expect(stdin.reads).toBe(4);
      expect(result.err).toContain(
        '  Please answer y or n. Install them now? [Y/n] ',
      );
      expect(result.out).toContain(`  ✓ Hooks in ${settingsFile()}\n`);
    });

    it('counts as no after three unclear answers and says so with the command', async () => {
      await withClaudeCode();
      // Enter at the game question first.
      const stdin = answeringEach(['', 'what', '\u001b[Bx', 'nope', 'y']);
      world.stdin = stdin;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(1 + HOOKS_MAX_ASKS);
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
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'claude-code',
      );
      expect(result.code).toBe(0);
      expect(
        result.out.split('\n').filter((l) => l.includes('Hooks not installed')),
      ).toEqual([`  ${HOOKS_NOT_INSTALLED}`]);
    });

    it('brings an outdated /sealkeeper-run up to date on a repeat run', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect(
        (
          await run(
            world,
            'init',
            '--name',
            'scout',
            '--runtime',
            'claude-code',
          )
        ).code,
      ).toBe(0);
      const command = join(claudeDir(), 'commands', 'sealkeeper-run.md');
      await writeFile(
        command,
        '---\ndescription: old\nmanaged-by: sealkeeper\n---\nRun `sealkeeper run`.\n',
      );
      world = newWorld();
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(await readFile(command, 'utf8')).toBe(RUN_COMMAND_TEXT);
      expect(result.out).toContain(
        `  ✓ /sealkeeper-run updated in ${dirname(command)}\n`,
      );
      // Current already, so a third run says nothing about it.
      world = newWorld();
      world.stdin = answering('');
      expect((await run(world, 'init')).out).not.toContain('updated');
    });

    // VOU-595. An older init wrote /sealkeeper-prove. A repeat run writes
    // /sealkeeper-run in its place and removes the old one, ours only.
    it('replaces the retired /sealkeeper-prove of ours on a repeat run', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect(
        (
          await run(
            world,
            'init',
            '--name',
            'scout',
            '--runtime',
            'claude-code',
          )
        ).code,
      ).toBe(0);
      const command = join(claudeDir(), 'commands', 'sealkeeper-run.md');
      const retired = join(claudeDir(), 'commands', 'sealkeeper-prove.md');
      await rm(command);
      await writeFile(
        retired,
        '---\ndescription: old\nmanaged-by: sealkeeper\n---\nRun `sealkeeper prove`.\n',
      );
      world = newWorld();
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(await readFile(command, 'utf8')).toBe(RUN_COMMAND_TEXT);
      await expect(readFile(retired, 'utf8')).rejects.toThrow('ENOENT');
      expect(result.out).toContain(
        `  ✓ /sealkeeper-run updated in ${dirname(command)}\n`,
      );
    });

    it('leaves a /sealkeeper-run it did not write alone on a repeat run', async () => {
      await withClaudeCode();
      world.stdin = answering('');
      expect(
        (
          await run(
            world,
            'init',
            '--name',
            'scout',
            '--runtime',
            'claude-code',
          )
        ).code,
      ).toBe(0);
      const command = join(claudeDir(), 'commands', 'sealkeeper-run.md');
      await writeFile(command, 'my own command\n');
      world = newWorld();
      world.stdin = answering('');
      expect((await run(world, 'init')).code).toBe(0);
      expect(await readFile(command, 'utf8')).toBe('my own command\n');
    });

    describe('init run by Claude Code, with no terminal (RS-8)', () => {
      it('installs the hooks without asking, leaves the nudge off and puts the routine first in Next', async () => {
        await withClaudeCode();
        world.env = { CLAUDECODE: '1' };
        world.claude = true;
        const stdin = answering('y', false);
        world.stdin = stdin;
        const result = await run(world, 'init', '--name', 'scout');
        expect(result.code).toBe(0);
        expect(stdin.reads).toBe(0);
        expect(result.err).not.toContain(HOOKS_QUESTION);
        expect(hooksIn(await readFile(settingsFile(), 'utf8'))).toHaveLength(3);
        expect(result.out).toContain(
          `  ✓ Hooks in ${tildePath(settingsFile())}\n`,
        );
        expect(result.err).toContain(`  ${HOOKS_BY_CLAUDE}\n`);
        // The nudge is neither asked nor stored, the routine not offered.
        expect(result.err).not.toContain(NUDGE_INTRO);
        expect(await readNudge(paths(home))).toBeUndefined();
        expect(result.all).not.toContain(INSTALL_QUESTION);
        expect(world.scheduler).toEqual([]);
        expect((await readRoutineConfig()).schedule).toBeUndefined();
        const next = result.out.slice(result.out.indexOf('  Next\n'));
        expect(next.split('\n')[1]).toBe(
          '  1  Set up the daily routine   npx sealkeeper routine install --yes',
        );
        expect(next).toContain('  2  In Claude Code, run /sealkeeper-run');
      });

      it('does the same with --json, the routine first in nextSteps', async () => {
        await withClaudeCode();
        world.env = { CLAUDECODE: '1' };
        world.stdin = answering('y', false);
        const result = await run(world, 'init', '--name', 'scout', '--json');
        expect(result.code).toBe(0);
        expect(hooksIn(await readFile(settingsFile(), 'utf8'))).toHaveLength(3);
        expect(result.err).toContain(`${HOOKS_BY_CLAUDE}\n`);
        const json = JSON.parse(result.out);
        expect(json.nextSteps[0]).toBe(NEXT_ROUTINE);
        expect(NEXT_ROUTINE).toBe(
          "Set up the daily routine with npx sealkeeper routine install --yes, only after the user's clear yes",
        );
        // The same command the run command and the skill allow.
        expect(NEXT_ROUTINE).toContain(
          ROUTINE_INSTALL_COMMAND.replace(/^sealkeeper /, ''),
        );
      });

      it('leaves the routine out of Next once a job is installed', async () => {
        await withClaudeCode();
        world.env = { CLAUDECODE: '1' };
        world.stdin = answering('y', false);
        expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
        const routine = await readRoutineConfig();
        await writeFile(
          paths(home).routine,
          `${JSON.stringify({
            ...routine,
            schedule: {
              time: '10:00',
              scheduler: 'launchd',
              agent: 'claude-code',
              agentCommand: CLAUDE,
              job: 'run.sealkeeper.routine',
              files: [],
              installedAt: new Date().toISOString(),
            },
          })}\n`,
        );
        world = newWorld();
        world.env = { CLAUDECODE: '1' };
        world.stdin = answering('y', false);
        const again = await run(world, 'init');
        expect(again.code).toBe(0);
        expect(again.out).not.toContain('Set up the daily routine');
      });

      it('still counts a missing terminal as no without CLAUDECODE', async () => {
        await withClaudeCode();
        world.claude = true;
        const stdin = answering('y', false);
        world.stdin = stdin;
        const result = await run(world, 'init', '--name', 'scout');
        expect(result.code).toBe(0);
        expect(stdin.reads).toBe(0);
        expect(hooksIn(await readFile(settingsFile(), 'utf8'))).toEqual([]);
        expect(result.all).not.toContain(HOOKS_BY_CLAUDE);
        expect(result.out).not.toContain('Set up the daily routine');
      });

      it('registers a plain non-terminal init with the suggested name, asking nothing and never ending as D6', async () => {
        await withClaudeCode();
        world.repo = 'research-bot';
        // A pipe that is already closed, as a script or an agent gives.
        const stdin = answering(null, false);
        world.stdin = stdin;
        const result = await run(world, 'init');
        expect(result.code).toBe(0);
        expect(stdin.reads).toBe(0);
        expect(result.all).not.toContain(INPUT_CLOSED);
        expect((await readConfig(paths(home)))?.name).toBe('research-bot');
        expect(world.registrations).toHaveLength(1);
        expect(hooksIn(await readFile(settingsFile(), 'utf8'))).toEqual([]);
      });

      it('still counts a missing terminal as no with --json and no CLAUDECODE', async () => {
        await withClaudeCode();
        world.stdin = answering('y', false);
        const json = await run(world, 'init', '--name', 'scout', '--json');
        expect(json.code).toBe(0);
        expect(hooksIn(await readFile(settingsFile(), 'utf8'))).toEqual([]);
        expect(JSON.parse(json.out).nextSteps).not.toContain(NEXT_ROUTINE);
      });

      it('asks as usual in a terminal, CLAUDECODE or not', async () => {
        await withClaudeCode();
        world.env = { CLAUDECODE: '1' };
        const stdin = answeringEach(['', 'n', 'n']);
        world.stdin = stdin;
        const result = await run(world, 'init', '--name', 'scout');
        expect(result.code).toBe(0);
        expect(result.err).toContain(HOOKS_QUESTION.trimEnd());
        expect(result.all).not.toContain(HOOKS_BY_CLAUDE);
      });
    });

    describe('a stdin that closes at a question (D6)', () => {
      it('ends with the no terminal line and exit 1 at the hooks question', async () => {
        await withClaudeCode();
        const stdin = answeringEach([]);
        world.stdin = stdin;
        const result = await run(
          world,
          'init',
          '--name',
          'scout',
          '--runtime',
          'claude-code',
        );
        expect(result.code).toBe(1);
        expect(stdin.reads).toBe(1);
        expect(result.err).toContain(INPUT_CLOSED);
        expect(INPUT_CLOSED).toBe(
          'init stopped, stdin closed before an answer. There is no terminal to ask, so run npx sealkeeper init again in a terminal.',
        );
        expect(hooksIn(await readFile(settingsFile(), 'utf8'))).toEqual([]);
      });

      it('ends the same way at the name question and at the nudge', async () => {
        const name = answeringEach([]);
        world.stdin = name;
        const atName = await run(world, 'init');
        expect(atName.code).toBe(1);
        expect(atName.err).toContain(INPUT_CLOSED);
        expect(await readConfig(paths(home))).toBeNull();

        world = newWorld();
        await withClaudeCode();
        const nudge = answeringEach(['y']);
        world.stdin = nudge;
        const atNudge = await run(
          world,
          'init',
          '--name',
          'scout',
          '--runtime',
          'claude-code',
        );
        expect(atNudge.code).toBe(1);
        expect(nudge.reads).toBe(2);
        expect(atNudge.err).toContain(INPUT_CLOSED);
      });

      it('streamInput answers null at once after the stream ended, never waiting', async () => {
        const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
        stream.isTTY = true;
        const input = streamInput(stream);
        stream.end('y\n');
        expect(await input.readLine()).toBe('y');
        // The first readline took the end with it. Each later question
        // settles with null rather than hanging.
        const settle = <T>(p: Promise<T>) =>
          Promise.race([
            p,
            new Promise<'hung'>((r) => setTimeout(() => r('hung'), 500)),
          ]);
        expect(await settle(input.readLine())).toBeNull();
        expect(await settle(input.readLine())).toBeNull();
        // A fresh input on the ended stream settles too.
        expect(await settle(streamInput(stream).readLine())).toBeNull();
      });
    });

    describe('the session nudge', () => {
      const skillFile = () =>
        join(claudeDir(), 'skills', 'sealkeeper', 'SKILL.md');

      it('installs the skill with the hooks and turns the nudge on after a yes', async () => {
        await withClaudeCode();
        // The game, the hooks and the nudge.
        const stdin = answeringEach(['', 'y', 'y']);
        world.stdin = stdin;
        const result = await run(
          world,
          'init',
          '--name',
          'scout',
          '--runtime',
          'claude-code',
        );
        expect(result.code).toBe(0);
        expect(stdin.reads).toBe(3);
        expect(result.err).toContain(NUDGE_INTRO);
        expect(result.err).toContain('three line SealKeeper summary');
        expect(result.out).toContain('  ✓ Session nudge on\n');
        expect(await readNudge(paths(home))).toBe(true);
        expect(isManaged(await readFile(skillFile(), 'utf8'))).toBe(true);
      });

      it('fills the goal cache after a yes, so the first session start has a summary', async () => {
        await withClaudeCode();
        world.goal = {
          level: 'bronze',
          nextLevel: 'silver',
          thresholds: [
            { name: 'verified_tasks', current: 60, required: 250, met: false },
          ],
          actions: [],
          pending: { addressed: 2, outcomes: 0 },
          asOf: '2026-09-25T10:15:00.000Z',
        };
        world.stdin = answeringEach(['', 'y', 'y']);
        const result = await run(
          world,
          'init',
          '--name',
          'scout',
          '--runtime',
          'claude-code',
        );
        expect(result.code).toBe(0);
        expect(world.fetchUrls.filter((u) => u.endsWith('/goal'))).toHaveLength(
          1,
        );
        expect(
          await nudgeLines('/sealkeeper-run', { paths: paths(home) }),
        ).toEqual([
          'SealKeeper. Level bronze, 60 of 250 verified tasks to silver.',
          '2 tasks addressed to you.',
          '/sealkeeper-run works on this. Run it only when the user asks for it or agrees.',
        ]);
      });

      it('says nothing more and still exits 0 when the goal cannot be read', async () => {
        await withClaudeCode();
        world.stdin = answeringEach(['', 'y', 'y']);
        const result = await run(
          world,
          'init',
          '--name',
          'scout',
          '--runtime',
          'claude-code',
        );
        expect(result.code).toBe(0);
        expect(result.out).toContain('  ✓ Session nudge on\n');
        expect(result.err).not.toContain('goal');
        expect(world.fetchUrls.filter((u) => u.endsWith('/goal'))).toHaveLength(
          1,
        );
        await expect(stat(paths(home).goal)).rejects.toThrow('ENOENT');
        expect(
          await nudgeLines('/sealkeeper-run', { paths: paths(home) }),
        ).toEqual([]);
      });

      it('Enter is no, which is kept and not asked again', async () => {
        await withClaudeCode();
        world.stdin = answeringEach(['', 'y', '']);
        const result = await run(
          world,
          'init',
          '--name',
          'scout',
          '--runtime',
          'claude-code',
        );
        expect(result.out).toContain(`  ${NUDGE_NOT_ON}\n`);
        expect(await readNudge(paths(home))).toBe(false);
        world = newWorld();
        const stdin = answering('y');
        world.stdin = stdin;
        expect((await run(world, 'init')).code).toBe(0);
        expect(stdin.reads).toBe(0);
        expect(await readNudge(paths(home))).toBe(false);
      });

      it('is not asked when the hooks were declined, or with --json', async () => {
        await withClaudeCode();
        const declined = answering('n');
        world.stdin = declined;
        await run(world, 'init', '--name', 'scout', '--runtime', 'claude-code');
        // The game question, then the hooks.
        expect(declined.reads).toBe(2);
        expect(await readNudge(paths(home))).toBeUndefined();
        await expect(stat(skillFile())).rejects.toThrow('ENOENT');

        await rm(paths(home).config);
        world = newWorld();
        const json = answering('y');
        world.stdin = json;
        const result = await run(world, 'init', '--name', 'scout', '--json');
        expect(result.code).toBe(0);
        expect(json.reads).toBe(0);
        expect(await readNudge(paths(home))).toBeUndefined();
        await expect(stat(skillFile())).rejects.toThrow('ENOENT');
      });

      it('a repeat run adds a missing skill next to hooks already in', async () => {
        await withClaudeCode();
        world.stdin = answeringEach(['', 'y', 'n']);
        await run(world, 'init', '--name', 'scout', '--runtime', 'claude-code');
        await rm(skillFile());
        world = newWorld();
        world.stdin = answering('');
        const result = await run(world, 'init');
        expect(result.out).toContain('✓ sealkeeper skill in');
        expect(isManaged(await readFile(skillFile(), 'utf8'))).toBe(true);
      });
    });
  });

  describe('the agent name', () => {
    it('suggests the repository name of the git remote over the directory name', async () => {
      world.repo = 'Research_Bot.v2';
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/work/my-agent');
      const result = await run(world, 'init').finally(() => cwd.mockRestore());
      expect(result.code).toBe(0);
      expect(world.registrations[0]?.name).toBe('research-bot-v2');
    });

    it('falls back to the directory name when the remote makes no name', async () => {
      world.repo = '--';
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/work/my-agent');
      const result = await run(world, 'init').finally(() => cwd.mockRestore());
      expect(result.code).toBe(0);
      expect(world.registrations[0]?.name).toBe('my-agent');
    });

    it('without a terminal and no usable name, ends before anything is created', async () => {
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/');
      const result = await run(world, 'init').finally(() => cwd.mockRestore());
      expect(result.code).toBe(1);
      expect(result.err).toContain(NO_NAME);
      expect(world.fetchUrls).toEqual([]);
      expect(await readIfExists(paths(home).key)).toBe('');
    });

    it('asks on a terminal, and Enter takes the suggestion', async () => {
      world.repo = 'scout-repo';
      const stdin = answeringEach(['', '', '']);
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.err).toContain(`  ${nameQuestion('scout-repo')} `);
      expect(world.registrations[0]?.name).toBe('scout-repo');
      // The name, then the runtime, skipped, then the game.
      expect(stdin.reads).toBe(3);
    });

    it('takes a typed name, and asks again after one that is not valid', async () => {
      world.repo = 'scout-repo';
      world.stdin = answeringEach(['Bad Name', 'my-helper', '', '']);
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.err).toContain('Bad Name is not a valid name');
      expect(world.registrations[0]?.name).toBe('my-helper');
    });

    it('asks without a suggestion when there is none, and ends after three tries', async () => {
      world.stdin = answeringEach(['', 'X', '']);
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/');
      const result = await run(world, 'init').finally(() => cwd.mockRestore());
      expect(result.code).toBe(1);
      expect(result.err).toContain(`  ${nameQuestion(null)} `);
      expect(result.err).toContain('Please type a name.');
      expect(result.err).toContain('no agent name, pass --name');
      expect(world.registrations).toEqual([]);
    });

    it('nudges once for a runtime name, and Enter keeps it', async () => {
      world.repo = 'claude-code';
      const stdin = answeringEach(['', '', '', '']);
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.err.split(runtimeNameNudge('claude-code'))).toHaveLength(2);
      expect(world.registrations[0]?.name).toBe('claude-code');
      // The name, the name again after the nudge, the runtime, then the
      // game.
      expect(stdin.reads).toBe(4);
    });

    it('takes another name typed after the nudge', async () => {
      world.repo = 'codex';
      world.stdin = answeringEach(['', 'reviewer', '', '']);
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.err).toContain(runtimeNameNudge('codex'));
      expect(world.registrations[0]?.name).toBe('reviewer');
    });

    it('with --name says one line for a runtime name and does not ask', async () => {
      const stdin = answeringEach(['', '']);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'codex');
      expect(result.code).toBe(0);
      expect(result.err).toContain(`  ${runtimeNameLine('codex')}\n`);
      expect(result.err).not.toContain(runtimeNameNudge('codex'));
      expect(result.err).not.toContain(nameQuestion(null));
      // Only the runtime and game questions.
      expect(stdin.reads).toBe(2);
      expect(world.registrations[0]?.name).toBe('codex');
    });

    it('with --json says the line on stderr', async () => {
      const result = await run(world, 'init', '--name', 'gemini-cli', '--json');
      expect(result.code).toBe(0);
      expect(result.err).toContain(`${runtimeNameLine('gemini-cli')}\n`);
      expect(JSON.parse(result.out)).toMatchObject({ name: 'gemini-cli' });
    });
  });

  describe('the runtime', () => {
    it('sends --runtime with the registration and asks only the game', async () => {
      const stdin = answeringEach(['']);
      world.stdin = stdin;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
      );
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(1);
      expect(world.registrations[0]).toMatchObject({ runtime: 'codex' });
      expect(result.out).toContain('    Runtime  Codex\n');
      const agentId = (await loadKey(paths(home)))?.agentId ?? '';
      expect(await wasAskedRuntime(agentId, paths(home))).toBe(true);
    });

    it('reports the runtime the API has over the one sent', async () => {
      world.serverVersion = '0.1.0';
      world.runtime = 'mastra';
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
        '--json',
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({ runtime: 'mastra' });
    });

    it('refuses a --runtime that is not one before any request', async () => {
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'gpt',
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain('invalid runtime gpt, use one of');
      expect(world.fetchUrls).toEqual([]);
    });

    it('confirms a detected runtime on Enter, sends it and counts as asked', async () => {
      world.env = { CLAUDECODE: '1' };
      world.stdin = answeringEach(['', '']);
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        'This agent runs in Claude Code, from CLAUDECODE. Right? [Y/n] ',
      );
      expect(world.registrations[0]).toMatchObject({ runtime: 'claude-code' });
      const agentId = (await loadKey(paths(home)))?.agentId ?? '';
      expect(await wasAskedRuntime(agentId, paths(home))).toBe(true);
    });

    it('registers without a runtime on a skip, and counts as asked', async () => {
      world.stdin = answeringEach(['', '']);
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(world.registrations[0]).not.toHaveProperty('runtime');
      expect(result.out).not.toContain('Runtime');
      const agentId = (await loadKey(paths(home)))?.agentId ?? '';
      expect(await wasAskedRuntime(agentId, paths(home))).toBe(true);
    });

    it('sends no runtime without a terminal, even with one detected', async () => {
      world.env = { CLAUDECODE: '1' };
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      expect(world.registrations[0]).not.toHaveProperty('runtime');
      expect(JSON.parse(result.out)).toMatchObject({ runtime: 'unknown' });
      const agentId = (await loadKey(paths(home)))?.agentId ?? '';
      expect(await wasAskedRuntime(agentId, paths(home))).toBe(false);
    });

    it('asks an unknown agent once on a repeat init and sends the PATCH', async () => {
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      world = newWorld();
      world.serverVersion = '0.1.0';
      world.runtime = 'unknown';
      world.stdin = answeringEach(['3']);
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(world.runtimeChanges).toEqual([
        { runtime: 'cursor', issuedAt: expect.any(String) },
      ]);
      expect(result.out).toContain('  ✓ Runtime set to Cursor\n');

      world.runtime = 'unknown';
      const again = answeringEach(['3']);
      world.stdin = again;
      expect((await run(world, 'init')).code).toBe(0);
      expect(again.reads).toBe(0);
      expect(world.runtimeChanges).toHaveLength(1);
    });
  });

  describe('the game question', () => {
    const ON = '    Game  on, turn it off with npx sealkeeper game off\n';
    const OFF = '    Game  off, turn it on with npx sealkeeper game on\n';

    it('asks in a terminal after the runtime, and y turns the game on', async () => {
      world.game = true;
      const stdin = answeringEach(['y']);
      world.stdin = stdin;
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
      );
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(1);
      expect(GAME_QUESTION).toBe('Play duels and weekly challenges? [Y/n] ');
      expect(result.err).toContain(`  ${GAME_QUESTION}`);
      // Before the sign in.
      expect(result.err.indexOf(GAME_QUESTION)).toBeLessThan(
        result.err.indexOf(CONSENT),
      );
      expect(world.registrations[0]).toMatchObject({ gameEnabled: true });
      expect(result.out).toContain(ON);
      // The line reads what SealKeeper has, with a signed status read.
      expect(world.gameReads).toHaveLength(1);
      expect(Object.keys(world.gameReads?.[0] ?? {})).toEqual(['issuedAt']);
    });

    it('turns the game off on n', async () => {
      world.game = false;
      world.stdin = answeringEach(['n']);
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
      );
      expect(result.code).toBe(0);
      expect(world.registrations[0]).toMatchObject({ gameEnabled: false });
      expect(result.out).toContain(OFF);
    });

    it('turns the game on with Enter, since yes is the default', async () => {
      world.stdin = answeringEach(['']);
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
      );
      expect(result.code).toBe(0);
      expect(world.registrations[0]).toMatchObject({ gameEnabled: true });
      // The status read fails, so the line says what was sent.
      expect(result.out).toContain(ON);
    });

    it('says what SealKeeper has when it differs from the answer, as for a key registered before', async () => {
      world.game = false;
      world.stdin = answeringEach(['']);
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
      );
      expect(result.code).toBe(0);
      expect(world.registrations[0]).toMatchObject({ gameEnabled: true });
      expect(result.out).toContain(OFF);
    });

    it('asks nothing without a terminal and sends the default yes', async () => {
      const stdin = answering('n', false);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain(GAME_QUESTION);
      expect(world.registrations[0]).toMatchObject({ gameEnabled: true });
      expect(result.out).toContain(ON);
    });

    it('asks nothing when Claude Code runs init and sends the default yes', async () => {
      world.env = { CLAUDECODE: '1' };
      const stdin = answering('n', false);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.err).not.toContain(GAME_QUESTION);
      expect(world.registrations[0]).toMatchObject({ gameEnabled: true });
      expect(result.out).toContain(ON);
    });

    it('asks nothing with --json and sends the default yes', async () => {
      const stdin = answering('n');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(world.registrations[0]).toMatchObject({ gameEnabled: true });
    });

    it('ends init with one line when stdin closes at the question', async () => {
      world.stdin = answeringEach([]);
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--runtime',
        'codex',
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain(INPUT_CLOSED);
      expect(world.registrations).toEqual([]);
    });
  });

  describe('the operator slug', () => {
    beforeEach(() => {
      world.serverVersion = '0.1.0';
      world.slug = 'alice-2';
    });

    it('prints the slug and where to change it on the first agent', async () => {
      world.operatorAgents = 1;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.out).toContain(
        [
          '  ✓ Registered alice-2/scout',
          '    Profile  https://sealkeeper.run/agents/alice-2/scout',
          '    Game  on, turn it off with npx sealkeeper game off',
          `    Operator  alice-2, change it at ${ACCOUNT_URL}`,
        ].join('\n'),
      );
      expect(ACCOUNT_URL).toBe('https://sealkeeper.run/me/account');
    });

    it('says nothing about the slug on a later agent or without an answer', async () => {
      world.operatorAgents = 2;
      const later = await run(world, 'init', '--name', 'scout');
      expect(later.code).toBe(0);
      expect(later.out).toContain('Registered alice-2/scout');
      expect(later.out).not.toContain('Operator');

      await rm(paths(home).config, { force: true });
      world = newWorld();
      world.serverVersion = '0.1.0';
      world.slug = 'alice-2';
      const unanswered = await run(world, 'init', '--name', 'scout');
      expect(unanswered.out).not.toContain('Operator');
    });

    it('falls back to the login for a handle or slug not in the API shape', async () => {
      world.slug = '../../evil';
      world.operatorAgents = 1;
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({
        handle: 'alice/scout',
        profileUrl: 'https://sealkeeper.run/agents/alice/scout',
      });
      expect(world.fetchUrls.some((u) => u.includes('operator='))).toBe(false);
    });

    it('stores the slug, and a repeat init shows it online and offline (VOU-187)', async () => {
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const agentId = (await readConfig(paths(home)))?.agentId ?? '';
      expect(await readOperatorSlug(agentId, paths(home))).toBe('alice-2');

      // Changed on the web since.
      world = newWorld();
      world.serverVersion = '0.1.0';
      world.slug = 'wonderland';
      const online = await run(world, 'init');
      expect(online.out).toContain('  ✓ Already set up as wonderland/scout\n');
      expect(online.out).toContain(
        '    Profile  https://sealkeeper.run/agents/wonderland/scout\n',
      );

      // Offline, the last slug stored.
      world = newWorld();
      const offline = await run(world, 'init', '--json');
      expect(JSON.parse(offline.out)).toMatchObject({
        handle: 'wonderland/scout',
        profileUrl: 'https://sealkeeper.run/agents/wonderland/scout',
      });
    });

    it('prints the handle from the API with --json', async () => {
      const result = await run(world, 'init', '--name', 'scout', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({
        handle: 'alice-2/scout',
        profileUrl: 'https://sealkeeper.run/agents/alice-2/scout',
      });
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
        '2  Then in Claude Code, run /sealkeeper-run to earn your first verified tasks',
        '3  Review and send what was recorded   npx sealkeeper sync',
        '4  0 of 25 verified tasks toward bronze',
        '5  After the first verified tasks, post one for other agents with npx sealkeeper tasks post',
      ]);
    });

    it('with the hooks and nothing verified, says your first', async () => {
      await withClaudeCode();
      world.live = { verifiedTasks: 0, level: 'none' };
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-run to earn your first verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  0 of 25 verified tasks toward bronze',
        '4  After the first verified tasks, post one for other agents with npx sealkeeper tasks post',
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
        '1  In Claude Code, run /sealkeeper-run to earn verified tasks',
        '2  8 of 25 verified tasks toward bronze',
        '3  Post a task for other agents with npx sealkeeper tasks post, every level needs posted tasks other agents completed',
      ]);
    });

    it('at bronze, says the level', async () => {
      await withClaudeCode();
      world.live = { verifiedTasks: 30, level: 'bronze' };
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-run to earn verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  Level bronze, with 30 verified tasks',
        '4  Post a task for other agents with npx sealkeeper tasks post, every level needs posted tasks other agents completed',
      ]);
      expect(bronzeLine(55, 'silver')).toBe(
        'Level silver, with 55 verified tasks',
      );
    });

    it('without Claude Code, has the agent run run --json', async () => {
      world.live = { verifiedTasks: 2, level: 'none' };
      const result = await run(world, 'init', '--name', 'scout');
      expect(next(result.out)).toEqual([
        '1  Have your agent run npx sealkeeper run --json to earn verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  2 of 25 verified tasks toward bronze',
        '4  Post a task for other agents with npx sealkeeper tasks post, every level needs posted tasks other agents completed',
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
        '1  In Claude Code, run /sealkeeper-run to earn your first verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  Bronze needs 25 verified tasks with a Trust Score of 50 over 3 days and 5 posted tasks another agent completed. Your badge updates on its own.',
        '4  After the first verified tasks, post one for other agents with npx sealkeeper tasks post',
      ]);
    });

    it('falls back to the generic steps when the API does not answer', async () => {
      await withClaudeCode();
      world.serverVersion = undefined;
      world.stdin = answering('');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(next(result.out)).toEqual([
        '1  In Claude Code, run /sealkeeper-run to earn your first verified tasks',
        '2  Review and send what was recorded   npx sealkeeper sync',
        '3  Bronze needs 25 verified tasks with a Trust Score of 50 over 3 days and 5 posted tasks another agent completed. Your badge updates on its own.',
        '4  After the first verified tasks, post one for other agents with npx sealkeeper tasks post',
      ]);
    });
  });

  describe('the daily routine', () => {
    const claudeDir = () => join(home, 'claude');

    async function withClaudeCode(): Promise<void> {
      await mkdir(claudeDir(), { recursive: true });
      await writeFile(join(claudeDir(), 'settings.json'), '{}\n');
    }

    // The bundle the CLI runs from, a real file install copies (RS-2).
    async function withBundle(
      script = join(home, 'dist', 'index.js'),
    ): Promise<string> {
      await mkdir(dirname(script), { recursive: true });
      await writeFile(script, BUNDLE);
      world.bundle = script;
      return script;
    }

    // The runtime, the game, the hooks and the nudge, each by Enter, then
    // the install question and the first run question.
    const answersThen = (...routine: string[]) =>
      answeringEach(['', '', '', '', ...routine]);

    it('offers the routine as one block after the hooks and installs on Enter (RS-1)', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      const stdin = answersThen('', 'n');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(6);
      const schedule = (await readRoutineConfig()).schedule;
      const job = schedule?.job ?? '';
      const block = [
        '  Daily routine   10:00, only when there is work',
        '',
        '    Claims   Seed tasks and tasks from operators you allow',
        '    Posts    1 task a day when posting is behind',
        '    Limits   10 claims, 3 posts, 15 min, 300k tokens a day',
        '    Why      Verified tasks get your agent to bronze',
        '',
        '  Check it later with npx sealkeeper status',
        `  ${INSTALL_QUESTION}`,
      ].join('\n');
      expect(INSTALL_QUESTION).toBe('Install? [Y/n] ');
      // The scheduler and the file are in status only.
      expect(result.err).not.toContain('LaunchAgents');
      expect(result.err).toContain(block);
      expect(result.err.indexOf(block)).toBeGreaterThan(
        result.err.indexOf(NUDGE_INTRO),
      );
      // One question before the install, never the full job file.
      expect(result.all).not.toContain('<?xml');
      expect(schedule?.time).toBe('10:00');
      expect(schedule?.scheduler).toBe('launchd');
      expect(schedule?.agentCommand).toBe(CLAUDE);
      const [plist = ''] = schedule?.files ?? [];
      expect(plist.startsWith(join(home, 'Library', 'LaunchAgents'))).toBe(
        true,
      );
      const copy = copyPaths(paths(home)).script;
      expect(await readFile(plist, 'utf8')).toContain(
        `<string>${copy}</string>`,
      );
      expect(await readFile(copy, 'utf8')).toBe(BUNDLE);
      expect(world.scheduler).toEqual([
        `launchctl bootout gui/501/${job}`,
        `launchctl bootstrap gui/501 ${plist}`,
      ]);
      expect(result.out).toContain(
        '  ✓ Routine installed. It runs every day at 10:00.',
      );
      expect(result.out).toContain(`  ${ROUTINE_TIME_LINE}\n`);
      expect(result.out).not.toContain(ROUTINE_NOT_INSTALLED);
      // The no to the first run.
      expect(result.err).toContain(`  ${FIRST_RUN_QUESTION}`);
      expect(result.out).toMatch(
        /\n {2}It runs (today|tomorrow) at 10:00\. Run one any time with npx sealkeeper routine run\.\n/,
      );
      expect(await readRoutine(paths(home))).toEqual([]);
    });

    it('runs the first one on Enter and says where to look (RS-3)', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      const stdin = answersThen('', '');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      // A first run that fails does not fail init.
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(6);
      expect(result.out).toContain(
        '  First run started. It stops within 15 minutes.\n',
      );
      expect(result.out).toMatch(/\n {2}Routine run \w+/);
      expect(result.out).toContain(
        '  See every run with npx sealkeeper status.\n',
      );
      const runs = (await readRoutine(paths(home))).filter(
        (e) => e.kind === 'run',
      );
      expect(runs).toHaveLength(1);
      // Next still follows.
      expect(result.out.indexOf('See every run')).toBeLessThan(
        result.out.indexOf('Next'),
      );
    });

    it('installs nothing on a no, and asks no more', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      const stdin = answersThen('n');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(5);
      expect(result.out).toContain(`  ${ROUTINE_NOT_INSTALLED}\n`);
      expect(result.err).not.toContain(FIRST_RUN_QUESTION);
      expect(world.scheduler).toEqual([]);
      expect((await readRoutineConfig()).schedule).toBeUndefined();
      expect(await copyVersion(paths(home))).toBeNull();
    });

    it('asks again on an unclear answer, then counts it as no', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      const stdin = answersThen('maybe', 'what', 'hm');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(7);
      expect(result.err).toContain(
        `  Please answer y or n. ${INSTALL_QUESTION}`,
      );
      expect(result.out).toContain(`  ${ROUTINE_NOT_INSTALLED}\n`);
      expect(world.scheduler).toEqual([]);
    });

    it('names the installed routine on a repeat init, asks nothing and refreshes the copy', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      world.stdin = answersThen('y', 'n');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const c = copyPaths(paths(home));
      await writeFile(c.meta, '{"type":"module","version":"0.0.1"}\n');
      await writeFile(c.script, 'old bundle\n');
      world = newWorld();
      await withBundle();
      world.claude = true;
      const stdin = answering('');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(result.out).toContain(`  ✓ ${routinePresentLine('10:00')}\n`);
      expect(result.err).not.toContain(INSTALL_QUESTION);
      expect(world.scheduler).toEqual([]);
      expect(await copyVersion(paths(home))).toBe(VERSION);
      expect(await readFile(c.script, 'utf8')).toBe(BUNDLE);
    });

    it('says how to move a job an earlier CLI installed onto a copy', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      world.stdin = answersThen('y', 'n');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      const routine = await readRoutineConfig();
      const { program: _, ...earlier } = routine.schedule ?? {};
      await writeFile(
        paths(home).routine,
        `${JSON.stringify({ ...routine, schedule: earlier })}\n`,
      );
      world = newWorld();
      world.claude = true;
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(result.out).toContain(`  ${ROUTINE_EARLIER_LINE}\n`);
    });

    it('offers the routine on a repeat init when it is not installed', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      world.stdin = answersThen('n');
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      world = newWorld();
      await withBundle();
      world.claude = true;
      const stdin = answering('n');
      world.stdin = stdin;
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(1);
      expect(result.err).toContain(INSTALL_QUESTION);
      expect(result.out).toContain(`  ${ROUTINE_NOT_INSTALLED}\n`);
    });

    it('points the job at the copy when the CLI runs from npx, with no npx note', async () => {
      await withClaudeCode();
      const npx = await withBundle(
        join(
          home,
          '.npm',
          '_npx',
          'abc',
          'node_modules',
          'sealkeeper',
          'dist',
          'index.js',
        ),
      );
      world.claude = true;
      world.stdin = answersThen('y', 'n');
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      const [plist = ''] = (await readRoutineConfig()).schedule?.files ?? [];
      const text = await readFile(plist, 'utf8');
      expect(text).toContain(
        `<string>${copyPaths(paths(home)).script}</string>`,
      );
      expect(text).not.toContain(npx);
      expect(result.all).not.toContain('npx cache');
    });

    it('says nothing about the routine when claude is not on PATH', async () => {
      await withClaudeCode();
      await withBundle();
      const stdin = answersThen('y', 'y');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(stdin.reads).toBe(4);
      expect(result.all).not.toContain('Daily routine');
      expect(result.err).not.toContain(INSTALL_QUESTION);
      expect(world.scheduler).toEqual([]);
    });

    it('says nothing about the routine without a Claude Code dir', async () => {
      await withBundle();
      world.claude = true;
      const stdin = answering('y');
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(result.all).not.toContain('Daily routine');
      expect(world.scheduler).toEqual([]);
    });

    it('asks nothing and installs nothing with --json or without a terminal', async () => {
      await withClaudeCode();
      await withBundle();
      world.claude = true;
      world.stdin = answering('y');
      const json = await run(world, 'init', '--name', 'scout', '--json');
      expect(json.code).toBe(0);
      expect(json.all).not.toContain(INSTALL_QUESTION);
      world = newWorld();
      await withBundle();
      world.claude = true;
      world.stdin = answering('y', false);
      const piped = await run(world, 'init');
      expect(piped.code).toBe(0);
      expect(piped.all).not.toContain(INSTALL_QUESTION);
      expect(world.scheduler).toEqual([]);
      expect((await readRoutineConfig()).schedule).toBeUndefined();
      expect(await copyVersion(paths(home))).toBeNull();
    });
  });

  describe('an agent per folder', () => {
    // The root and the project folders, after realpath, since the temp
    // directory may sit behind a symlink and the map stores real paths.
    let root: string;
    let app: string;
    let worktree: string;
    let billing: string;

    beforeEach(async () => {
      // No SEALKEEPER_HOME, so init reads the folder map, in a root of its
      // own.
      vi.stubEnv('SEALKEEPER_HOME', '');
      const dir = await realpath(home);
      root = join(dir, 'root');
      vi.stubEnv('SEALKEEPER_ROOT', root);
      app = join(dir, 'app');
      worktree = join(dir, 'app-worktree');
      billing = join(dir, 'billing');
      for (const folder of [join(app, 'src'), worktree, billing]) {
        await mkdir(folder, { recursive: true });
      }
    });

    // The first agent, app, registered from the app folder. The world
    // starts over after it, so a test counts only its own requests.
    async function registerApp(): Promise<void> {
      world.cwd = app;
      expect((await run(world, 'init', '--name', 'app')).code).toBe(0);
      world = newWorld();
    }

    const signedIn = () => world.fetchUrls.includes(DEVICE_CODE_URL);
    const folders = async () => (await readFolderMap(root)).folders;

    async function identity(p = paths(root)) {
      const config = await readConfig(p);
      return {
        agentId: config?.agentId,
        handle: `alice/${config?.name}`,
        operatorLogin: 'alice',
        name: config?.name,
        version: '0.1.0',
        // SEALKEEPER_API_URL is used for the run and never saved (VOU-237).
        apiUrl: DEFAULT_API_URL,
        profileUrl: `https://sealkeeper.run/agents/alice/${config?.name}`,
      };
    }

    it('names the agents on this machine by handle, counting past a few', () => {
      expect(machineAgentsLine(['alice/app'])).toBe(
        'This machine has one agent, alice/app. Type its name to use it in this folder, or a new name to register another.',
      );
      expect(machineAgentsLine(['alice/app', 'alice/billing'])).toBe(
        'This machine has 2 agents, alice/app and alice/billing. Type a name to use one in this folder, or a new name to register another.',
      );
      const many = Array.from(
        { length: MACHINE_AGENTS_SHOWN + 2 },
        (_, i) => `alice/a${i}`,
      );
      expect(machineAgentsLine(many)).toBe(
        'This machine has 7 agents, alice/a0, alice/a1, alice/a2, alice/a3, alice/a4 and 2 more. Type a name to use one in this folder, or a new name to register another.',
      );
    });

    it('registers the first agent in the root and binds its folder to it', async () => {
      world.cwd = app;
      const result = await run(world, 'init', '--name', 'app', '--json');
      expect(result.code).toBe(0);
      const json = JSON.parse(result.out);
      expect(json).toMatchObject({
        name: 'app',
        handle: 'alice/app',
        folder: app,
        home: root,
      });
      expect(Object.keys(json)).toEqual([
        'agentId',
        'handle',
        'operatorLogin',
        'name',
        'version',
        'runtime',
        'apiUrl',
        'profileUrl',
        'folder',
        'home',
        'nextSteps',
      ]);
      expect(await readConfig(paths(root))).toMatchObject({ name: 'app' });
      expect(await folders()).toEqual({ [app]: '.' });

      // agent list reads the same map.
      world = newWorld();
      const list = await run(world, 'agent', 'list', '--json');
      expect(JSON.parse(list.out)).toEqual({
        agents: [
          {
            home: root,
            name: 'app',
            agentId: json.agentId,
            handle: 'alice/app',
            isDefault: true,
            folders: [app],
          },
        ],
      });
    });

    it('says which folder now uses the agent it registered', async () => {
      world.cwd = app;
      const result = await run(world, 'init', '--name', 'app');
      expect(result.code).toBe(0);
      expect(result.out).toContain(
        [
          '  ✓ Registered alice/app',
          '    Profile  https://sealkeeper.run/agents/alice/app',
          '    Game  on, turn it off with npx sealkeeper game off',
          `  ✓ ${folderLine(tildePath(app), 'alice/app')}`,
          '',
        ].join('\n'),
      );
      expect(folderLine('~/code/app', 'alice/app')).toBe(
        '~/code/app now uses alice/app',
      );
    });

    it('in a subfolder of a bound folder is a repeat run for its agent', async () => {
      await registerApp();
      world.cwd = join(app, 'src');
      const human = await run(world, 'init');
      expect(human.code).toBe(0);
      expect(human.out).toContain('  ✓ Already set up as alice/app\n');
      expect(human.out).not.toContain('now uses');
      expect(human.err).not.toContain('This machine has');

      const json = await run(world, 'init', '--json');
      expect(JSON.parse(json.out)).toEqual(await identity());
      expect(signedIn()).toBe(false);
      expect(await folders()).toEqual({ [app]: '.' });
    });

    it('in a worktree binds to the agent on Enter and registers nothing', async () => {
      await registerApp();
      world.cwd = worktree;
      world.repo = 'app';
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(signedIn()).toBe(false);
      expect(world.registrations).toEqual([]);
      const lines = result.err.split('\n');
      const choice = lines.indexOf(`  ${machineAgentsLine(['alice/app'])}`);
      expect(choice).toBeGreaterThan(0);
      expect(result.err).toContain(`  ${nameQuestion('app')} `);
      // The welcome box once, before the choice.
      expect(result.err.split(TAGLINE[0] as string)).toHaveLength(2);
      expect(result.out).toContain(
        [
          `  ✓ ${folderLine(tildePath(worktree), 'alice/app')}`,
          '  ✓ Already set up as alice/app',
          '    Profile  https://sealkeeper.run/agents/alice/app',
        ].join('\n'),
      );
      expect(await folders()).toEqual({ [app]: '.', [worktree]: '.' });
    });

    it('binds to the agent whose name or handle is typed', async () => {
      await registerApp();
      world.cwd = billing;
      world.stdin = answering('app');
      const byName = await run(world, 'init');
      expect(byName.code).toBe(0);
      expect(byName.out).toContain(
        `  ✓ ${folderLine(tildePath(billing), 'alice/app')}\n`,
      );

      world.cwd = worktree;
      world.stdin = answering('alice/app');
      const byHandle = await run(world, 'init');
      expect(byHandle.code).toBe(0);
      expect(byHandle.err).not.toContain('is not a valid name');
      expect(signedIn()).toBe(false);
      expect(await folders()).toEqual({
        [app]: '.',
        [billing]: '.',
        [worktree]: '.',
      });
    });

    it('registers a new name in a home of its own and binds the folder', async () => {
      await registerApp();
      world.cwd = billing;
      world.stdin = answering('');
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(
        world.fetchUrls.filter((url) => url === DEVICE_CODE_URL),
      ).toHaveLength(1);
      expect(world.registrations).toMatchObject([{ name: 'billing' }]);
      const home = namedHome('billing', root);
      expect(await readConfig(paths(home))).toMatchObject({ name: 'billing' });
      expect((await loadKey(paths(home)))?.agentId).toBe(
        world.registrations[0]?.publicKey,
      );
      // The first agent keeps its own key.
      expect((await loadKey(paths(root)))?.agentId).not.toBe(
        world.registrations[0]?.publicKey,
      );
      expect(await folders()).toEqual({
        [app]: '.',
        [billing]: 'agents/billing',
      });
      expect(result.out).toContain(
        `  ✓ ${folderLine(tildePath(billing), 'alice/billing')}\n`,
      );
      // The name is asked once, in the choice, before the sign in.
      expect(result.err.split(nameQuestion('billing'))).toHaveLength(2);
      expect(result.err.indexOf(nameQuestion('billing'))).toBeLessThan(
        result.err.indexOf('Sign in with GitHub'),
      );
    });

    it('with --name of an agent binds without a question', async () => {
      await registerApp();
      world.cwd = billing;
      const stdin = answering('nope');
      world.stdin = stdin;
      const human = await run(world, 'init', '--name', 'app');
      expect(human.code).toBe(0);
      expect(stdin.reads).toBe(0);
      expect(human.err).not.toContain('This machine has');
      expect(human.out).toContain(
        `  ✓ ${folderLine(tildePath(billing), 'alice/app')}\n`,
      );

      world.cwd = worktree;
      const json = await run(world, 'init', '--name', 'app', '--json');
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out)).toEqual({
        ...(await identity()),
        folder: worktree,
        home: root,
      });
      expect(signedIn()).toBe(false);
      expect(await folders()).toEqual({
        [app]: '.',
        [billing]: '.',
        [worktree]: '.',
      });
    });

    it('with --name of a new agent registers it', async () => {
      await registerApp();
      world.cwd = billing;
      const result = await run(world, 'init', '--name', 'billing', '--json');
      expect(result.code).toBe(0);
      const home = namedHome('billing', root);
      expect(JSON.parse(result.out)).toMatchObject({
        name: 'billing',
        folder: billing,
        home,
      });
      expect(world.registrations).toMatchObject([{ name: 'billing' }]);
      expect(await folders()).toEqual({
        [app]: '.',
        [billing]: 'agents/billing',
      });
    });

    it('without a terminal binds when the suggestion names an agent', async () => {
      await registerApp();
      world.cwd = worktree;
      world.repo = 'app';
      const result = await run(world, 'init');
      expect(result.code).toBe(0);
      expect(signedIn()).toBe(false);
      expect(result.out).toContain(
        `  ✓ ${folderLine(tildePath(worktree), 'alice/app')}\n`,
      );
      expect(await folders()).toEqual({ [app]: '.', [worktree]: '.' });
    });

    it('refuses a new name whose home holds an agent already', async () => {
      await registerApp();
      // An agent renamed since keeps the home of its old name.
      const old = namedHome('old', root);
      await writeConfig(
        {
          agentId: 'A'.repeat(43),
          operatorLogin: 'alice',
          name: 'renamed',
          version: '0.1.0',
          registeredAt: '2026-09-23T10:00:00.000Z',
        },
        paths(old),
      );
      world.cwd = billing;
      const result = await run(world, 'init', '--name', 'old');
      expect(result.code).toBe(1);
      expect(result.err).toContain(homeTaken(tildePath(old)));
      expect(homeTaken('~/.sealkeeper/agents/old')).toBe(
        '~/.sealkeeper/agents/old already holds an agent, which may have been renamed since, see npx sealkeeper agent list or choose another name',
      );
      expect(signedIn()).toBe(false);
      expect(await folders()).toEqual({ [app]: '.' });
    });

    it('binds nothing when the registration fails', async () => {
      world.api = () => apiError(403, 'account_too_new', 'created today');
      world.cwd = app;
      expect((await run(world, 'init', '--name', 'app')).code).toBe(1);
      expect(await folders()).toEqual({});

      world = newWorld();
      await registerApp();
      world.api = () => apiError(403, 'account_too_new', 'created today');
      world.cwd = billing;
      const result = await run(world, 'init', '--name', 'billing');
      expect(result.code).toBe(1);
      expect(result.err).toContain('your GitHub account is too new');
      // The key stays in the named home for the next try, as in the root.
      expect(await loadKey(paths(namedHome('billing', root)))).not.toBeNull();
      expect(await readConfig(paths(namedHome('billing', root)))).toBeNull();
      expect(await folders()).toEqual({ [app]: '.' });
    });

    it('--force follows the choice and binds once registered again', async () => {
      await registerApp();
      const before = (await loadKey(paths(root)))?.agentId;
      world.cwd = billing;
      const result = await run(
        world,
        'init',
        '--name',
        'app',
        '--force',
        '--json',
      );
      expect(result.code).toBe(0);
      const after = (await loadKey(paths(root)))?.agentId;
      expect(after).not.toBe(before);
      expect(JSON.parse(result.out)).toMatchObject({
        agentId: after,
        folder: billing,
        home: root,
      });
      expect(await folders()).toEqual({ [app]: '.', [billing]: '.' });
    });

    it('with SEALKEEPER_HOME set reads and writes no map', async () => {
      await registerApp();
      const elsewhere = join(home, 'elsewhere');
      vi.stubEnv('SEALKEEPER_HOME', elsewhere);
      world.cwd = app;
      const result = await run(world, 'init', '--name', 'solo', '--json');
      expect(result.code).toBe(0);
      const json = JSON.parse(result.out);
      expect(json).toMatchObject({ name: 'solo' });
      expect(json).not.toHaveProperty('folder');
      expect(json).not.toHaveProperty('home');
      expect(signedIn()).toBe(true);
      expect(await readConfig(paths(elsewhere))).toMatchObject({
        name: 'solo',
      });
      expect(await folders()).toEqual({ [app]: '.' });
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

          What does this agent run in?
          1 Claude Code  2 Codex  3 Cursor  4 Gemini CLI  5 OpenClaw  6 Mastra  7 Other
          Number or name, Enter to skip 
          Play duels and weekly challenges? [Y/n] 
          This sign in sends your GitHub token to the API at https://api.test, not https://api.sealkeeper.run.

          Registering this agent means you accept the terms (https://sealkeeper.run/terms) and the privacy policy (https://sealkeeper.run/privacy).

          Sign in with GitHub
          Open https://github.com/login/device and enter ABCD-1234
          ✓ Signed in as alice

          ✓ Registered alice/scout
            Profile  https://sealkeeper.run/agents/alice/scout
            Game  on, turn it off with npx sealkeeper game off

          What leaves this machine
          Session boundaries, task outcomes, durations and token counts,
          each signed with your key. Never prompts, tool inputs or outputs,
          file contents or model output.
          Full list  npx sealkeeper what-is-shared

          Claude Code
          The hooks record each session, its start and end, into a local log.
          Install them now? [Y/n]   ✓ Hooks in <home>/claude/settings.json
          ✓ /sealkeeper-run in <home>/claude/commands
          ✓ sealkeeper skill in <home>/claude/skills/sealkeeper
          The hooks can also tell your agent where it stands when a session starts, from a local cache, without waiting on the network.
          Start each agent session with a three line SealKeeper summary, your level, the biggest gap and what waits for you? [y/N]   Session nudge off. Run npx sealkeeper config nudge on to turn it on later.

          Next
          1  In Claude Code, run /sealkeeper-run to earn your first verified tasks
          2  Review and send what was recorded   npx sealkeeper sync
          3  Bronze needs 25 verified tasks with a Trust Score of 50 over 3 days and 5 posted tasks another agent completed. Your badge updates on its own.
          4  After the first verified tasks, post one for other agents with npx sealkeeper tasks post

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
          The hooks record each session, its start and end, into a local log.
          ✓ Hooks in <home>/claude/settings.json

          Next
          1  In Claude Code, run /sealkeeper-run to earn your first verified tasks
          2  Review and send what was recorded   npx sealkeeper sync
          3  Bronze needs 25 verified tasks with a Trust Score of 50 over 3 days and 5 posted tasks another agent completed. Your badge updates on its own.
          4  After the first verified tasks, post one for other agents with npx sealkeeper tasks post

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
        [
          `  ${CONSENT}`,
          '',
          '  Sign in with GitHub',
          '  Open https://github.com/login/device and enter ABCD-1234',
        ].join('\n'),
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
        '  1  Earn your first verified tasks with npx sealkeeper run',
      );
      world = newWorld();
      world.stdin = answering('y');
      const installed = await run(world, 'init');
      expect(first(installed.out)).toBe(
        '  1  In Claude Code, run /sealkeeper-run to earn your first verified tasks',
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
