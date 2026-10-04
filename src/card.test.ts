// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCard,
  base64urlEncode,
  type VerifiedCredentialPayload as CredentialPayload,
  decodeHeader,
  generateKeypair,
  partHash,
  SEAL_EXTENSION_URIS,
  sign,
  verifyHandshake,
} from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCardRecord, writeCard } from './card.js';
import { type Config, paths, readConfig, writeConfig } from './config.js';
import { recordCapture } from './fingerprint.js';
import { createKey } from './identity.js';

const API_URL = 'https://api.test';
const KID = 'sealkeeper-test-1';
const HOUR = 3600;

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

// VOU-603. init writes the A2A card into the home, which the routine
// refreshes. card show and card write are gone.
describe('the card init writes', () => {
  let home: string;
  let agentId: string;
  let serverKey: Awaited<ReturnType<typeof generateKeypair>>;
  let server: Server;
  let fetchFn: typeof fetch;
  // The kid the fake API signs with and publishes. A rotation test moves it.
  let kid: string;

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
    return sign(payload, serverKey.privateKey, kid);
  }

  // init's card write. once keeps the record of an earlier write, as a
  // repeat init does, else it is taken away so each call writes, as a
  // first init does.
  async function written(fetcher: typeof fetch = fetchFn, once = false) {
    if (!once) await rm(paths().cardWrite, { force: true });
    const config = (await readConfig()) as Config;
    const path = await writeCard(config, { fetch: fetcher });
    const card = await readFile(paths().card, 'utf8').catch(() => '');
    return { path, card };
  }

  const cardOf = (text: string): AgentCard => AgentCard.parse(JSON.parse(text));

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
      operatorLogin: 'alice',
      name: 'summariser',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    serverKey = await generateKeypair();
    kid = KID;
    server = { requests: [], credential: () => credentialFor(24 * HOUR) };
    fetchFn = fakeFetch(
      server,
      () => ({
        keys: [
          {
            kid,
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

  it('writes an A2A card carrying the verified SEAL into the home, and records it', async () => {
    const { path, card: text } = await written();
    expect(path).toBe(paths().card);
    expect(paths().card).toBe(join(home, 'agent-card.json'));
    const card = cardOf(text);
    expect(card).toMatchObject({
      protocolVersion: '0.3.0',
      name: 'summariser',
      version: '1.0.0',
      skills: [],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    });
    expect(card.url).toBeUndefined();
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
    expect((await stat(paths().card)).mode & 0o777).toBe(0o644);

    const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
    expect(extensionCredential(card)).toBe(cache.credential);
    expect(cache.seal).toBe(cache.credential);
    expect(cache).toMatchObject({ v: 1, payload: { sub: agentId } });
    expect((await stat(paths().credential)).mode & 0o777).toBe(0o600);
    expect(await readCardRecord(agentId)).toMatchObject({
      agentId,
      path: paths().card,
    });
  });

  it('leaves a card it recorded already to the routine, so a repeat init writes nothing', async () => {
    await written();
    await writeFile(paths().card, 'the routine keeps this\n');
    server.requests = [];
    const again = await written(fetchFn, true);
    expect(again.path).toBeNull();
    expect(again.card).toBe('the routine keeps this\n');
    expect(server.requests).toEqual([]);
  });

  it('writes nothing and never throws when the home cannot hold the card', async () => {
    await rm(paths().card, { force: true });
    await writeFile(join(home, 'blocker'), '');
    const config = (await readConfig()) as Config;
    const p = { ...paths(), card: join(home, 'blocker', 'agent-card.json') };
    expect(await writeCard(config, { fetch: fetchFn }, p)).toBeNull();
  });

  it('reuses a fresh cached credential without a fetch', async () => {
    const first = await written();
    expect(server.requests).toHaveLength(2);
    server.requests = [];

    const second = await written();
    expect(server.requests).toEqual([]);
    expect(second.card).toBe(first.card);
  });

  it('reads a cache that has only seal, or only credential as older versions wrote', async () => {
    const first = await written();
    const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
    for (const drop of ['seal', 'credential']) {
      const { [drop]: _gone, ...rest } = cache;
      await writeFile(paths().credential, JSON.stringify(rest));
      server.requests = [];
      const again = await written();
      expect(server.requests).toEqual([]);
      expect(again.card).toBe(first.card);
    }
  });

  it('skips a cached SEAL whose key the keys no longer list', async () => {
    const first = await written();
    const firstSeal = extensionCredential(cardOf(first.card));
    expect(decodeHeader(firstSeal ?? '').kid).toBe(KID);

    // The issuer drops the key and signs with a new one. Once the cached
    // keys are a day old they are fetched again and no longer list it.
    serverKey = await generateKeypair();
    kid = 'sealkeeper-test-2';
    const keys = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
    keys.fetchedAt = new Date(Date.now() - 25 * HOUR * 1000).toISOString();
    await writeFile(paths().wellKnown, JSON.stringify(keys));
    server.requests = [];

    const second = await written();
    const secondSeal = extensionCredential(cardOf(second.card));
    expect(decodeHeader(secondSeal ?? '').kid).toBe('sealkeeper-test-2');
    expect(server.requests).toContain(`${API_URL}/v1/agents/${agentId}/seal`);
    const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
    expect(cache.seal).toBe(secondSeal);
  });

  it('keeps a cached SEAL whose key is still listed once the keys are fetched again', async () => {
    const first = await written();
    const keys = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
    keys.fetchedAt = new Date(Date.now() - 25 * HOUR * 1000).toISOString();
    await writeFile(paths().wellKnown, JSON.stringify(keys));
    server.requests = [];

    const second = await written();
    expect(server.requests).toEqual([`${API_URL}/.well-known/seal.json`]);
    expect(second.card).toBe(first.card);
  });

  it('refetches a credential within two hours of expiry', async () => {
    server.credential = () => credentialFor(HOUR);
    const first = await written();
    const stale = extensionCredential(cardOf(first.card));

    server.requests = [];
    server.credential = () => credentialFor(24 * HOUR);
    const second = await written();
    expect(server.requests).toContain(`${API_URL}/v1/agents/${agentId}/seal`);
    const fresh = extensionCredential(cardOf(second.card));
    expect(fresh).not.toBe(stale);
    const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
    expect(cache.credential).toBe(fresh);
  });

  it('leaves a tampered credential off the card and does not cache it', async () => {
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
    const { card } = await written();
    expect(cardOf(card).capabilities.extensions).toEqual([]);
    await expect(stat(paths().credential)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('leaves a credential signed by a key the API does not publish off the card', async () => {
    const other = await generateKeypair();
    server.credential = async () => {
      const genuine = await credentialFor(24 * HOUR);
      const body = genuine.split('.')[1] ?? '';
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      return sign(payload, other.privateKey, KID);
    };
    const { card } = await written();
    expect(cardOf(card).capabilities.extensions).toEqual([]);
    await expect(stat(paths().credential)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses an unexpired cached credential when the API is unreachable', async () => {
    server.credential = () => credentialFor(HOUR);
    const first = await written();
    const cached = extensionCredential(cardOf(first.card));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { card } = await written(unreachable);
    vi.mocked(process.stderr.write).mockRestore();
    expect(extensionCredential(cardOf(card))).toBe(cached);
  });

  it('writes a card without extensions when unreachable with no cache', async () => {
    const { card } = await written(unreachable);
    expect(cardOf(card).capabilities.extensions).toEqual([]);
  });

  it('ignores a cache file that does not parse', async () => {
    await writeFile(
      paths().credential,
      JSON.stringify({ v: 1, credential: 'a.b.c', payload: {} }),
    );
    const { card } = await written();
    expect(extensionCredential(cardOf(card))).toBeDefined();
    expect(server.requests).toHaveLength(2);
  });

  // The handshake beside the SEAL (VB-6), on ext/seal/v1 only.
  describe('the handshake', () => {
    const capture = async (tools: string) => {
      const fp = await recordCapture(
        paths(),
        {
          model_set: await partHash(agentId, 'claude-sonnet-4-5'),
          prompt: 'not_declared',
          tools: await partHash(agentId, tools),
          framework: 'not_declared',
        },
        Math.floor(Date.now() / 1000),
      );
      if (fp === null) throw new Error('nothing recorded');
      return fp;
    };

    const handshakeOf = (card: AgentCard) => {
      const [current, ...legacy] = card.capabilities.extensions;
      for (const e of legacy) expect(e.params).not.toHaveProperty('handshake');
      const params = current?.params as { handshake?: string } | undefined;
      return params?.handshake;
    };

    it('embeds a handshake over the current fingerprint', async () => {
      const fp = await capture('mcp:github');
      const { card } = await written();
      const handshake = handshakeOf(AgentCard.parse(JSON.parse(card)));
      if (handshake === undefined) throw new Error('no handshake');
      const v = await verifyHandshake(handshake, agentId, Date.now() / 1000);
      if (!v.ok) throw new Error(v.reason);
      expect(v.payload).toMatchObject({
        sub: agentId,
        fingerprint: fp.hash,
        at: fp.captured_at,
      });
    });

    it('makes a fresh one on every write', async () => {
      await capture('mcp:github');
      const first = handshakeOf(cardOf((await written()).card));
      const fp = await capture('mcp:github\nmcp:linear');
      const second = handshakeOf(cardOf((await written()).card));
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      const v = await verifyHandshake(second ?? '', agentId, Date.now() / 1000);
      expect(v.ok && v.payload.fingerprint).toBe(fp.hash);
    });

    it('carries none without a fingerprint', async () => {
      const bare = await written();
      expect(handshakeOf(cardOf(bare.card))).toBeUndefined();
    });

    it('carries none when there is no SEAL', async () => {
      await capture('mcp:github');
      const { card } = await written(unreachable);
      expect(cardOf(card).capabilities.extensions).toEqual([]);
    });
  });
});
