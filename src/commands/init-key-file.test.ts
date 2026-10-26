// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64urlDecode, decodeHeader, verify } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Input } from '../ask.js';
import { paths, readConfig } from '../config.js';
import { tildePath } from '../files.js';
import { ACCESS_TOKEN_URL, DEVICE_CODE_URL } from '../github-device.js';
import {
  createKey,
  KEY_FILE_INVALID,
  KEY_FILE_MISMATCH,
  KEY_FILE_UNREADABLE,
  loadKey,
} from '../identity.js';
import { createProgram } from '../program.js';
import {
  KEY_FILE_CONFLICT,
  KEY_FILE_TERMINAL,
  KEY_MAX_ASKS,
  KEY_QUESTION,
  keyFileDiffers,
} from './init.js';

const TOKEN = 'gho_THIS_TOKEN_MUST_NEVER_LEAK_0123456789';
const API_URL = 'http://127.0.0.1:8080';
const REGISTER = `${API_URL}/v1/agents`;

// RFC 8032 section 7.1 tests 1 and 2, as the identity tests use them.
const ONE = {
  seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  agentId: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
};
const TWO = {
  seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
  publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  agentId: 'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw',
};
const SEED = Buffer.from(ONE.seed, 'hex');
// Every form the seed of ONE could be printed in.
const SEED_FORMS = [
  ONE.seed,
  ONE.seed.toUpperCase(),
  SEED.toString('base64url'),
  SEED.toString('base64').replace(/=+$/, ''),
];

type Reply = { status: number; body: unknown };
type World = {
  register: (kid: string, payload: Record<string, unknown>) => Reply;
  registrations: { kid: string; payload: Record<string, unknown> }[];
  urls: string[];
  stdin?: Input;
  keyInput?: string;
};

const created = (kid: string, payload: Record<string, unknown>): Reply => ({
  status: 201,
  body: {
    id: kid,
    name: payload.name,
    version: payload.version,
    operator: { login: 'alice' },
    createdAt: '2026-10-24T10:00:00.000Z',
  },
});

// Stands in for GitHub and the SealKeeper API. Only the device flow and the
// registration answer, and the registration's signature is checked against
// its kid as the API checks it. Every other route fails as an unreachable API.
function fakeFetch(world: World): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    world.urls.push(url);
    if (url === DEVICE_CODE_URL) {
      return Response.json({
        device_code: 'dev-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (url === ACCESS_TOKEN_URL) return Response.json({ access_token: TOKEN });
    if (url === REGISTER && init.method === 'POST') {
      const { envelope } = JSON.parse(String(init.body)) as {
        envelope: string;
      };
      const { kid } = decodeHeader(envelope);
      const { payload } = await verify(envelope, base64urlDecode(kid));
      const signed = payload as Record<string, unknown>;
      world.registrations.push({ kid, payload: signed });
      const reply = world.register(kid, signed);
      return Response.json(reply.body, { status: reply.status });
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
}

// A terminal, or a pipe when isTTY is false, that answers with each line in
// turn and then with Enter, and counts its reads.
function typing(lines: string[], isTTY = true): Input & { reads: number } {
  const input = {
    isTTY,
    reads: 0,
    readLine: async () => lines[input.reads++] ?? '',
  };
  return input;
}

// How often the key question was asked.
const keyQuestions = (err: string): number =>
  err.split(KEY_QUESTION[0]).length - 1;

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

async function run(world: World, ...args: string[]) {
  const fetchFn = fakeFetch(world);
  const program = createProgram({
    init: {
      fetch: fetchFn,
      sleep: async () => undefined,
      stdin: world.stdin ? () => world.stdin as Input : undefined,
      keyInput: async () => world.keyInput ?? '',
      repoName: async () => null,
      env: () => ({}),
    },
    routine: {
      fetch: fetchFn,
      sleep: async () => undefined,
      platform: () => 'darwin',
      homedir: () => process.env.SEALKEEPER_HOME ?? '',
      uid: () => 501,
      findAgent: async () => null,
      stdoutTTY: () => false,
      interrupt: () => () => undefined,
      now: () => new Date(2026, 9, 4, 9, 5),
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
    if (error instanceof CommanderError) {
      return { code: error.exitCode, out, err };
    }
    throw error;
  } finally {
    vi.mocked(process.stdout.write).mockRestore();
    vi.mocked(process.stderr.write).mockRestore();
  }
}

describe('sealkeeper init --key-file', () => {
  let home: string;
  let dir: string;
  let world: World;

  const newWorld = (): World => ({
    register: created,
    registrations: [],
    urls: [],
  });

  // Writes text to a file outside the home and returns its path.
  async function keyFile(text: string): Promise<string> {
    const file = join(dir, `key-${Math.random().toString(36).slice(2)}`);
    await writeFile(file, text);
    return file;
  }

  // Neither stream nor any file but the home key holds the seed.
  async function expectSeedNowhere(result: { out: string; err: string }) {
    for (const form of SEED_FORMS) {
      expect(result.out).not.toContain(form);
      expect(result.err).not.toContain(form);
      expect(
        await readFile(paths(home).config, 'utf8').catch(() => ''),
      ).not.toContain(form);
    }
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-keyfile-'));
    dir = await mkdtemp(join(tmpdir(), 'sealkeeper-keyfile-src-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_GITHUB_CLIENT_ID', 'client-abc');
    vi.stubEnv('SEALKEEPER_API_URL', API_URL);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('NO_COLOR', '');
    world = newWorld();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['hex', ONE.seed],
    ['base64url', SEED.toString('base64url')],
    ['base64', `${SEED.toString('base64')}\n`],
    [
      'a 64 byte key',
      Buffer.concat([SEED, Buffer.from(ONE.publicKey, 'hex')]).toString(
        'base64',
      ),
    ],
  ])(
    'registers with a brought key in %s, its public key as the agent id',
    async (_, text) => {
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--key-file',
        await keyFile(text),
      );
      expect(result.code).toBe(0);
      expect(world.registrations).toHaveLength(1);
      expect(world.registrations[0]?.kid).toBe(ONE.agentId);
      expect(world.registrations[0]?.payload).toMatchObject({
        publicKey: ONE.agentId,
        purpose: 'agent.register',
      });
      expect((await readConfig(paths(home)))?.agentId).toBe(ONE.agentId);
      // The one copy, written as a new key is.
      expect(await readFile(paths(home).key, 'utf8')).toBe(
        `${SEED.toString('base64url')}\n`,
      );
      expect((await stat(paths(home).key)).mode & 0o777).toBe(0o600);
      expect((await readdir(home)).filter((n) => n.startsWith('key'))).toEqual([
        'key',
      ]);
      await expectSeedNowhere(result);
    },
  );

  it('reads the key from stdin with -', async () => {
    world.keyInput = `${SEED.toString('base64')}\n`;
    const result = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      '-',
    );
    expect(result.code).toBe(0);
    expect(world.registrations[0]?.kid).toBe(ONE.agentId);
    expect((await loadKey(paths(home)))?.agentId).toBe(ONE.agentId);
    await expectSeedNowhere(result);
  });

  it('refuses - when stdin is a terminal, before reading anything', async () => {
    world.stdin = { isTTY: true, readLine: async () => null };
    world.keyInput = ONE.seed;
    const result = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      '-',
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain(KEY_FILE_TERMINAL);
    expect(world.urls).toEqual([]);
    expect(await loadKey(paths(home))).toBeNull();
  });

  it('refuses a key it cannot read without echoing it, and writes nothing', async () => {
    const garbage = 'this is not a key at all, 0123456789abcdef';
    const result = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      await keyFile(garbage),
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain(KEY_FILE_INVALID);
    expect(result.err).not.toContain(garbage);
    expect(world.urls).toEqual([]);
    expect(await loadKey(paths(home))).toBeNull();
  });

  it('refuses a 64 byte key whose second half is not its public key', async () => {
    const crossed = Buffer.concat([
      SEED,
      Buffer.from(TWO.publicKey, 'hex'),
    ]).toString('hex');
    const result = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      await keyFile(crossed),
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain(KEY_FILE_MISMATCH);
    expect(result.err).not.toContain(crossed);
    expect(world.urls).toEqual([]);
    expect(await loadKey(paths(home))).toBeNull();
  });

  it('says a key registered by another operator cannot register here', async () => {
    world.register = () => ({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'This key is registered to another operator',
        },
      },
    });
    const result = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      await keyFile(ONE.seed),
    );
    expect(result.code).toBe(1);
    expect(result.err.endsWith(`\n${KEY_FILE_CONFLICT}\n`)).toBe(true);
    expect(await readConfig(paths(home))).toBeNull();
    await expectSeedNowhere(result);
  });

  it('goes on as a repeat init when the home holds the same key', async () => {
    const file = await keyFile(ONE.seed);
    expect(
      (await run(world, 'init', '--name', 'scout', '--key-file', file)).code,
    ).toBe(0);
    const before = await stat(paths(home).key);

    world = newWorld();
    const result = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      file,
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('Already set up as alice/scout');
    expect(world.registrations).toEqual([]);
    expect((await stat(paths(home).key)).mtimeMs).toBe(before.mtimeMs);
  });

  it('refuses a different key than the home holds without --force, and replaces it with --force', async () => {
    await createKey({ seed: Buffer.from(TWO.seed, 'hex') }, paths(home));
    const file = await keyFile(ONE.seed);

    const refused = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      file,
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(keyFileDiffers(tildePath(home)));
    expect(world.urls).toEqual([]);
    expect((await loadKey(paths(home)))?.agentId).toBe(TWO.agentId);

    const forced = await run(
      world,
      'init',
      '--name',
      'scout',
      '--key-file',
      file,
      '--force',
    );
    expect(forced.code).toBe(0);
    expect(world.registrations[0]?.kid).toBe(ONE.agentId);
    expect((await loadKey(paths(home)))?.agentId).toBe(ONE.agentId);
    const backups = (await readdir(home)).filter((n) => n.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(
      (await loadKey({ ...paths(home), key: join(home, backups[0] ?? '') }))
        ?.agentId,
    ).toBe(TWO.agentId);
    await expectSeedNowhere(forced);
  });

  describe('the key question on a first init in a terminal', () => {
    it('makes a new key on Enter', async () => {
      world.stdin = typing([]);
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(keyQuestions(result.err)).toBe(1);
      for (const line of KEY_QUESTION) expect(result.err).toContain(line);
      const key = await loadKey(paths(home));
      expect(key?.agentId).not.toBe(ONE.agentId);
      expect(world.registrations[0]?.kid).toBe(key?.agentId);
    });

    it('registers with the key in the file at a typed path, and never prints the path', async () => {
      const file = await keyFile(ONE.seed);
      world.stdin = typing([file]);
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(world.registrations[0]?.kid).toBe(ONE.agentId);
      expect((await loadKey(paths(home)))?.agentId).toBe(ONE.agentId);
      expect(result.err).not.toContain(file);
      expect(result.out).not.toContain(file);
      await expectSeedNowhere(result);
    });

    it('reads a path that starts with ~/ from the home directory', async () => {
      vi.stubEnv('HOME', dir);
      await writeFile(join(dir, 'agent.key'), ONE.seed);
      world.stdin = typing(['~/agent.key']);
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(world.registrations[0]?.kid).toBe(ONE.agentId);
    });

    it('says why a key cannot be used and asks again, and Enter then makes a new key', async () => {
      const missing = join(dir, 'missing');
      const garbage = await keyFile('this is not a key at all');
      world.stdin = typing([missing, garbage, '']);
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(keyQuestions(result.err)).toBe(3);
      expect(result.err).toContain(KEY_FILE_UNREADABLE);
      expect(result.err).toContain(KEY_FILE_INVALID);
      expect(result.err).not.toContain(missing);
      expect(result.err).not.toContain(garbage);
      const key = await loadKey(paths(home));
      expect(key?.agentId).not.toBe(ONE.agentId);
      expect(world.registrations[0]?.kid).toBe(key?.agentId);
    });

    it('ends init after keys that cannot be used, with nothing written', async () => {
      const missing = join(dir, 'missing');
      world.stdin = typing(Array(KEY_MAX_ASKS).fill(missing));
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(1);
      expect(keyQuestions(result.err)).toBe(KEY_MAX_ASKS);
      expect(result.err.endsWith(`${KEY_FILE_UNREADABLE}\n`)).toBe(true);
      expect(world.urls).toEqual([]);
      expect(await loadKey(paths(home))).toBeNull();
    });

    it('says a key registered by another operator cannot register here', async () => {
      world.register = () => ({
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'This key is registered to another operator',
          },
        },
      });
      world.stdin = typing([await keyFile(ONE.seed)]);
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(1);
      expect(result.err.endsWith(`\n${KEY_FILE_CONFLICT}\n`)).toBe(true);
      expect(await readConfig(paths(home))).toBeNull();
    });

    it('is not asked with --key-file', async () => {
      world.stdin = typing([]);
      const result = await run(
        world,
        'init',
        '--name',
        'scout',
        '--key-file',
        await keyFile(ONE.seed),
      );
      expect(result.code).toBe(0);
      expect(keyQuestions(result.err)).toBe(0);
      expect(world.registrations[0]?.kid).toBe(ONE.agentId);
    });

    it('is not asked with --force, or when the home holds a key already', async () => {
      await createKey({ seed: Buffer.from(TWO.seed, 'hex') }, paths(home));
      world.stdin = typing([]);
      const kept = await run(world, 'init', '--name', 'scout');
      expect(kept.code).toBe(0);
      expect(keyQuestions(kept.err)).toBe(0);
      expect(world.registrations[0]?.kid).toBe(TWO.agentId);

      world = newWorld();
      world.stdin = typing([]);
      const forced = await run(world, 'init', '--name', 'scout', '--force');
      expect(forced.code).toBe(0);
      expect(keyQuestions(forced.err)).toBe(0);
    });

    it('is not asked on a second init', async () => {
      world.stdin = typing([]);
      expect((await run(world, 'init', '--name', 'scout')).code).toBe(0);
      world = newWorld();
      world.stdin = typing([]);
      const again = await run(world, 'init', '--name', 'scout');
      expect(again.code).toBe(0);
      expect(again.out).toContain('Already set up as alice/scout');
      expect(keyQuestions(again.err)).toBe(0);
    });

    it('is not asked without a terminal, and reads nothing', async () => {
      const stdin = typing([], false);
      world.stdin = stdin;
      const result = await run(world, 'init', '--name', 'scout');
      expect(result.code).toBe(0);
      expect(keyQuestions(result.err)).toBe(0);
      expect(stdin.reads).toBe(0);
    });
  });
});
