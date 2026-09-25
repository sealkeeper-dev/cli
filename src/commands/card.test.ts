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
  AgentCard,
  base64urlEncode,
  type VerifiedCredentialPayload as CredentialPayload,
  generateKeypair,
  SEAL_EXTENSION_URIS,
  sign,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CREDENTIAL } from '../card.js';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';

const API_URL = 'http://api.test';
const KID = 'sealkeeper-test-1';
const HOUR = 3600;

type RunResult = { code: number; out: string; err: string };

// Stands in for GET /v1/agents/:id/seal and GET
// /.well-known/seal.json. credential decides what the API hands out.
type Server = {
  requests: string[];
  credential: () => Promise<string>;
};

function fakeFetch(
  server: Server,
  wellKnown: () => unknown,
  agentId: string,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    server.requests.push(url);
    if (url === `${API_URL}/.well-known/seal.json`) {
      return Response.json(wellKnown());
    }
    if (url === `${API_URL}/v1/agents/${agentId}/seal`) {
      const credential = await server.credential();
      const body = credential.split('.')[1] ?? '';
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      return Response.json({ credential, payload });
    }
    return Response.json(
      { error: { code: 'not_found', message: 'not found' } },
      { status: 404 },
    );
  }) as typeof fetch;
}

const unreachable = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('card show and card write', () => {
  let home: string;
  let agentId: string;
  let serverKey: Awaited<ReturnType<typeof generateKeypair>>;
  let server: Server;
  let fetchFn: typeof fetch;

  async function credentialFor(expSec: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: CredentialPayload = {
      iss: 'sealkeeper.run',
      sub: agentId,
      ver: 1,
      iat: now + expSec - 24 * HOUR,
      exp: now + expSec,
      agent_version: '1.0.0',
      version: '1.0.0',
      level: 'none',
      scores: { reliability: 0.9, safety: null },
      counts: {
        events: 12,
        history_days: 1,
        verified_tasks: 1,
        seed_tasks: 1,
        server_checked_tasks: 0,
        confirmed_tasks: 0,
        distinct_operators: 0,
        safety_incidents_90d: 0,
      },
      operator: { verified: false },
      identity: [],
      last_active: now - HOUR,
      dormant_days: 0,
    };
    return sign(payload, serverKey.privateKey, KID);
  }

  async function run(
    fetcher: typeof fetch,
    ...args: string[]
  ): Promise<RunResult> {
    const program = createProgram({ card: { fetch: fetcher } });
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

  function extensionCredential(card: AgentCard): string | undefined {
    return card.capabilities.extensions[0]?.params.credential;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-card-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'carelmeyer',
      name: 'summariser',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    serverKey = await generateKeypair();
    server = { requests: [], credential: () => credentialFor(24 * HOUR) };
    fetchFn = fakeFetch(
      server,
      () => ({
        keys: [
          {
            kid: KID,
            kty: 'OKP',
            crv: 'Ed25519',
            alg: 'EdDSA',
            x: base64urlEncode(serverKey.publicKey),
          },
        ],
      }),
      agentId,
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('card show prints an A2A card carrying the verified credential', async () => {
    const { code, out, err } = await run(
      fetchFn,
      'card',
      'show',
      '--url',
      'https://agent.example.com/a2a',
    );
    expect(code).toBe(0);
    expect(err).toBe('');
    const card = AgentCard.parse(JSON.parse(out));
    expect(card).toMatchObject({
      protocolVersion: '0.3.0',
      name: 'summariser',
      version: '1.0.0',
      url: 'https://agent.example.com/a2a',
      skills: [],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    });
    expect(card.description).toContain(agentId);
    expect(card.description).toContain(
      `https://sealkeeper.run/agents/${agentId}`,
    );
    expect(card.capabilities.extensions.map((e) => e.uri)).toEqual([
      ...SEAL_EXTENSION_URIS,
    ]);
    for (const extension of card.capabilities.extensions.slice(1)) {
      expect(extension.params).toEqual(card.capabilities.extensions[0]?.params);
    }

    const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
    expect(extensionCredential(card)).toBe(cache.credential);
    expect(cache.seal).toBe(cache.credential);
    expect(cache).toMatchObject({ v: 1, payload: { sub: agentId } });
    expect((await stat(paths().credential)).mode & 0o777).toBe(0o600);
  });

  it('card show rejects a url that is not https', async () => {
    const { code, out, err } = await run(
      fetchFn,
      'card',
      'show',
      '--url',
      'http://agent.example.com',
    );
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('--url must be an https URL');
  });

  it('reuses a fresh cached credential without a fetch', async () => {
    const first = await run(fetchFn, 'card', 'show');
    expect(server.requests).toHaveLength(2);
    server.requests = [];

    const second = await run(fetchFn, 'card', 'show');
    expect(second.code).toBe(0);
    expect(server.requests).toEqual([]);
    expect(second.out).toBe(first.out);
  });

  it('reads a cache that has only seal, or only credential as older versions wrote', async () => {
    const first = await run(fetchFn, 'card', 'show');
    const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
    for (const drop of ['seal', 'credential']) {
      const { [drop]: _gone, ...rest } = cache;
      await writeFile(paths().credential, JSON.stringify(rest));
      server.requests = [];
      const again = await run(fetchFn, 'card', 'show');
      expect(again.code).toBe(0);
      expect(server.requests).toEqual([]);
      expect(again.out).toBe(first.out);
    }
  });

  it('refetches a credential within two hours of expiry', async () => {
    server.credential = () => credentialFor(HOUR);
    const first = await run(fetchFn, 'card', 'show');
    const stale = extensionCredential(AgentCard.parse(JSON.parse(first.out)));

    server.requests = [];
    server.credential = () => credentialFor(24 * HOUR);
    const second = await run(fetchFn, 'card', 'show');
    expect(server.requests).toContain(`${API_URL}/v1/agents/${agentId}/seal`);
    const fresh = extensionCredential(AgentCard.parse(JSON.parse(second.out)));
    expect(fresh).not.toBe(stale);
    const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
    expect(cache.credential).toBe(fresh);
  });

  it('rejects a tampered credential and does not cache it', async () => {
    server.credential = async () => {
      const [header, , signature] = (await credentialFor(24 * HOUR)).split('.');
      const forged = base64urlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            iss: 'sealkeeper.run',
            sub: agentId,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 24 * HOUR,
            version: '1.0.0',
            scores: { reliability: 1 },
            counts: { events: 1_000_000, verified_tasks: 1_000 },
          }),
        ),
      );
      return `${header}.${forged}.${signature}`;
    };
    const { code, out, err } = await run(fetchFn, 'card', 'show');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('failed signature verification');
    await expect(stat(paths().credential)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a credential signed by a key the API does not publish', async () => {
    const other = await generateKeypair();
    server.credential = async () => {
      const genuine = await credentialFor(24 * HOUR);
      const body = genuine.split('.')[1] ?? '';
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      return sign(payload, other.privateKey, KID);
    };
    const { code, err } = await run(fetchFn, 'card', 'show');
    expect(code).toBe(1);
    expect(err).toContain('failed signature verification');
    await expect(stat(paths().credential)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses an unexpired cached credential when the API is unreachable', async () => {
    server.credential = () => credentialFor(HOUR);
    const first = await run(fetchFn, 'card', 'show');
    const cached = extensionCredential(AgentCard.parse(JSON.parse(first.out)));

    const { code, out, err } = await run(unreachable, 'card', 'show');
    expect(code).toBe(0);
    expect(extensionCredential(AgentCard.parse(JSON.parse(out)))).toBe(cached);
    expect(err.trim().split('\n')).toHaveLength(1);
    expect(err).toMatch(
      /^warning: could not reach the SealKeeper API, using the cached SEAL/,
    );
  });

  it('prints a card without extensions and warns when unreachable with no cache', async () => {
    const { code, out, err } = await run(unreachable, 'card', 'show');
    expect(code).toBe(0);
    const card = AgentCard.parse(JSON.parse(out));
    expect(card.capabilities.extensions).toEqual([]);
    expect(err).toBe(`${NO_CREDENTIAL}\n`);
  });

  it('card write writes the card atomically and a second write is identical', async () => {
    const out = join(home, 'site', 'agent-card.json');
    await mkdir(join(home, 'site'));

    const first = await run(fetchFn, 'card', 'write', '--out', out);
    expect(first.code).toBe(0);
    expect(first.out).toBe(`${out}\n`);
    const written = await readFile(out, 'utf8');
    const card = AgentCard.parse(JSON.parse(written));
    expect(extensionCredential(card)).toBeDefined();
    expect((await stat(out)).mode & 0o777).toBe(0o644);

    const second = await run(fetchFn, 'card', 'write', '--out', out);
    expect(second.code).toBe(0);
    expect(await readFile(out, 'utf8')).toBe(written);

    const show = await run(fetchFn, 'card', 'show');
    expect(show.out).toBe(written);
  });

  it('card write into a missing directory fails with the path', async () => {
    const out = join(home, 'missing', 'agent-card.json');
    const { code, err } = await run(fetchFn, 'card', 'write', '--out', out);
    expect(code).toBe(1);
    expect(err).toContain(`could not write ${out}`);
  });

  it('card write --json prints the path as JSON', async () => {
    const out = join(home, 'card.json');
    const { code, out: printed } = await run(
      fetchFn,
      'card',
      'write',
      '--out',
      out,
      '--json',
    );
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toEqual({ path: out });
  });

  it.each([
    ['card', 'show'],
    ['card', 'write'],
  ])('%s %s without config prints the init hint', async (...args) => {
    await rm(paths().config);
    const { code, out, err } = await run(fetchFn, ...args);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('not initialised, run npx sealkeeper init\n');
    expect(server.requests).toEqual([]);
  });

  it('ignores a cache file that does not parse', async () => {
    await writeFile(
      paths().credential,
      JSON.stringify({ v: 1, credential: 'a.b.c', payload: {} }),
    );
    const { code, out } = await run(fetchFn, 'card', 'show');
    expect(code).toBe(0);
    expect(extensionCredential(AgentCard.parse(JSON.parse(out)))).toBeDefined();
    expect(server.requests).toHaveLength(2);
  });
});
