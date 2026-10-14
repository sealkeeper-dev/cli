// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64urlDecode, decodeHeader, verify } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, readConfig, writeConfig } from '../config.js';
import { tildePath } from '../files.js';
import { ACCESS_TOKEN_URL, DEVICE_CODE_URL } from '../github-device.js';
import { createKey, loadKey } from '../identity.js';
import { createProgram } from '../program.js';
import {
  listedHandleInvalid,
  listedHomeTaken,
  mergeRefusedLine,
  tookOverLine,
} from './init.js';

const TOKEN = 'gho_THIS_TOKEN_MUST_NEVER_LEAK_0123456789';
const API_URL = 'http://127.0.0.1:8080';
const REGISTER = `${API_URL}/v1/agents`;
const MERGE = `${API_URL}/v1/me/listed/acme.ai/planner/merge`;

type Reply = { status: number; body: unknown };
type Signed = { kid: string; payload: Record<string, unknown> };
type World = {
  merge: (signed: Signed) => Reply;
  registrations: Signed[];
  merges: Signed[];
  urls: string[];
};

// The kid and the payload of a signed body, its signature checked against
// the kid as the API checks it.
async function readSigned(body: unknown): Promise<Signed> {
  const { envelope } = JSON.parse(String(body)) as { envelope: string };
  const { kid } = decodeHeader(envelope);
  const { payload } = await verify(envelope, base64urlDecode(kid));
  return { kid, payload: payload as Record<string, unknown> };
}

// Stands in for GitHub and the SealKeeper API. Only the device flow, the
// registration and the merge answer, every other route fails as an
// unreachable API, so what init reads after them is the part that
// already copes.
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
      const signed = await readSigned(init.body);
      world.registrations.push(signed);
      // A repeat of a known key answers the agent as it is, 200.
      const repeat = world.registrations.some(
        (r, i) => i < world.registrations.length - 1 && r.kid === signed.kid,
      );
      return Response.json(
        {
          id: signed.kid,
          name: signed.payload.name,
          version: signed.payload.version,
          operator: { login: 'alice' },
          createdAt: '2026-10-13T10:00:00.000Z',
        },
        { status: repeat ? 200 : 201 },
      );
    }
    if (url === MERGE && init.method === 'POST') {
      const signed = await readSigned(init.body);
      world.merges.push(signed);
      const reply = world.merge(signed);
      return Response.json(reply.body, { status: reply.status });
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const merged = (signed: Signed): Reply => ({
  status: 200,
  body: {
    agentId: signed.kid,
    handle: 'alice/planner',
    redirectFrom: 'acme.ai/planner',
    extensions: [],
    // A field the CLI does not know is read past.
    later: true,
  },
});

const notFound: Reply = {
  status: 404,
  body: { error: { code: 'not_found', message: 'Agent not found' } },
};

async function run(world: World, ...args: string[]) {
  const fetchFn = fakeFetch(world);
  const program = createProgram({
    init: {
      fetch: fetchFn,
      sleep: async () => undefined,
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

// init --listed registers a fresh key as plain init does
// and merges the new agent into a listed agent the operator claimed. The
// listed agent's key never leaves the API.
describe('sealkeeper init --listed', () => {
  let home: string;
  let world: World;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-listed-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_GITHUB_CLIENT_ID', 'client-abc');
    vi.stubEnv('SEALKEEPER_API_URL', API_URL);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('NO_COLOR', '');
    world = { merge: merged, registrations: [], merges: [], urls: [] };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('registers a fresh key, merges it into the listed agent with its own signature, and writes the config', async () => {
    const result = await run(
      world,
      '--json',
      'init',
      '--listed',
      'acme.ai/planner',
    );
    expect(result.code).toBe(0);
    const key = await loadKey(paths(home));
    expect(key).not.toBeNull();
    // Registered under the listed agent's name, the token sent there only.
    expect(world.registrations).toHaveLength(1);
    expect(world.registrations[0]?.kid).toBe(key?.agentId);
    expect(world.registrations[0]?.payload).toMatchObject({
      publicKey: key?.agentId,
      githubToken: TOKEN,
      name: 'planner',
      purpose: 'agent.register',
    });
    // The merge is signed by the new key for the listed agent of the path,
    // and carries no token.
    expect(world.merges).toHaveLength(1);
    expect(world.merges[0]?.kid).toBe(key?.agentId);
    expect(world.merges[0]?.payload).toMatchObject({
      domain: 'acme.ai',
      name: 'planner',
      purpose: 'listed.merge',
      aud: API_URL,
    });
    expect(typeof world.merges[0]?.payload.issuedAt).toBe('string');
    expect(JSON.stringify(world.merges)).not.toContain(TOKEN);
    expect(await readConfig(paths(home))).toMatchObject({
      agentId: key?.agentId,
      operatorLogin: 'alice',
      name: 'planner',
    });
    expect(JSON.parse(result.out)).toMatchObject({
      agentId: key?.agentId,
      handle: 'alice/planner',
      redirectFrom: 'acme.ai/planner',
      name: 'planner',
    });
    for (const text of [result.out, result.err]) {
      expect(text).not.toContain(TOKEN);
    }
  });

  it('says it registered the agent and took the listed one over in the plain form', async () => {
    const result = await run(world, 'init', '--listed', 'acme.ai/planner');
    expect(result.code).toBe(0);
    expect(result.out).toContain('✓ Registered alice/planner');
    expect(result.out).toContain(
      `✓ ${tookOverLine('acme.ai/planner', 'alice/planner')}`,
    );
  });

  it('leaves the key and no config when the merge fails, and a rerun registers the same key again and merges', async () => {
    world.merge = () => notFound;
    const failed = await run(
      world,
      '--json',
      'init',
      '--listed',
      'acme.ai/planner',
    );
    expect(failed.code).toBe(1);
    expect(failed.err).toContain(
      'no listed agent of yours has this handle, claim it on its SealKeeper page first',
    );
    // The run says the agent is registered and how to finish, never --force.
    expect(failed.err).toContain(mergeRefusedLine('alice/planner'));
    const key = await loadKey(paths(home));
    expect(key).not.toBeNull();
    expect(await readConfig(paths(home))).toBeNull();

    // Claimed since, the rerun picks up from the key.
    world.merge = merged;
    const rerun = await run(
      world,
      '--json',
      'init',
      '--listed',
      'acme.ai/planner',
    );
    expect(rerun.code).toBe(0);
    expect(world.registrations.map((r) => r.kid)).toEqual([
      key?.agentId,
      key?.agentId,
    ]);
    expect(world.merges.map((m) => m.kid)).toEqual([
      key?.agentId,
      key?.agentId,
    ]);
    expect((await readConfig(paths(home)))?.agentId).toBe(key?.agentId);
    const backups = (await readdir(home)).filter((n) => n.endsWith('.bak'));
    expect(backups).toEqual([]);
  });

  it('refuses a home that holds an agent, and replaces it with --force keeping the old key', async () => {
    const old = await createKey({}, paths(home));
    await writeConfig(
      {
        agentId: old.agentId,
        operatorLogin: 'alice',
        name: 'scout',
        version: '0.1.0',
        registeredAt: '2026-09-23T10:00:00.000Z',
      },
      paths(home),
    );
    const refused = await run(
      world,
      '--json',
      'init',
      '--listed',
      'acme.ai/planner',
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(listedHomeTaken(tildePath(home)));
    expect(world.urls).toEqual([]);

    const replaced = await run(
      world,
      '--json',
      'init',
      '--listed',
      'acme.ai/planner',
      '--force',
    );
    expect(replaced.code).toBe(0);
    const key = await loadKey(paths(home));
    expect(key?.agentId).not.toBe(old.agentId);
    expect((await readConfig(paths(home)))?.agentId).toBe(key?.agentId);
    const backups = (await readdir(home)).filter((n) => n.endsWith('.bak'));
    expect(backups).toHaveLength(1);
  });

  it('writes no config when the API merged another agent', async () => {
    world.merge = (signed) => {
      const reply = merged(signed);
      return {
        ...reply,
        body: { ...(reply.body as object), agentId: 'A'.repeat(43) },
      };
    };
    const result = await run(
      world,
      '--json',
      'init',
      '--listed',
      'acme.ai/planner',
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain('merged a different agent');
    expect(await readConfig(paths(home))).toBeNull();
  });

  it('refuses a handle that is not a listed one, and registers under --name when given', async () => {
    const bad = await run(world, 'init', '--listed', 'planner');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(listedHandleInvalid('planner'));
    expect(world.urls).toEqual([]);

    const named = await run(
      world,
      '--json',
      'init',
      '--listed',
      'acme.ai/planner',
      '--name',
      'scout',
    );
    expect(named.code).toBe(0);
    expect(world.registrations[0]?.payload.name).toBe('scout');
    expect(world.merges[0]?.payload).toMatchObject({
      domain: 'acme.ai',
      name: 'planner',
    });
  });
});
