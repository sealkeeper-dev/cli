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
  base64urlEncode,
  type CredentialPayload,
  generateKeypair,
  LEGACY_UNTIL,
  sign,
} from '@vouched-dev/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import { KEYS_MAX_AGE_MS } from '../seal.js';
import type { SealDeps } from './seal.js';
import { NO_SEAL } from './seal-show.js';

const API_URL = 'http://api.test';
const WELL_KNOWN = `${API_URL}/.well-known/vouched.json`;
const KID = 'vouched-test-1';
const HOUR = 3600;
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NOW_SEC = NOW / 1000;

type RunResult = { code: number; out: string; err: string };
type Keypair = Awaited<ReturnType<typeof generateKeypair>>;

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const jwk = (kid: string, key: Keypair) => ({
  kid,
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  x: base64urlEncode(key.publicKey),
});

// One character in the middle of the signature, changed.
function tamper(seal: string): string {
  const [header, payload, signature = ''] = seal.split('.');
  const i = Math.floor(signature.length / 2);
  const swapped = signature[i] === 'A' ? 'B' : 'A';
  return `${header}.${payload}.${signature.slice(0, i)}${swapped}${signature.slice(i + 1)}`;
}

describe('vouched seal', () => {
  let home: string;
  let agentId: string;
  let serverKey: Keypair;
  let requests: string[];
  let published: () => unknown;
  let currentSeal: () => Promise<string>;
  let fetchFn: typeof fetch;
  let now: number;
  let stdin: string;

  // A version 1 payload.
  function claims(over: Partial<CredentialPayload> = {}): CredentialPayload {
    return {
      iss: 'vouched.run',
      sub: agentId,
      ver: 1,
      iat: NOW_SEC - HOUR,
      exp: NOW_SEC + 24 * HOUR,
      agent_version: '1.0.0',
      version: '1.0.0',
      level: 'bronze',
      scores: { reliability: 0.9, safety: null },
      counts: {
        events: 12,
        history_days: 3,
        verified_tasks: 26,
        seed_tasks: 25,
        server_checked_tasks: 1,
        confirmed_tasks: 0,
        distinct_operators: 1,
        safety_incidents_90d: 0,
      },
      operator: { verified: false },
      identity: [],
      last_active: NOW_SEC - 2 * 86_400,
      dormant_days: 2,
      ...over,
    };
  }

  // The shape issued before version 1, with no ver.
  const legacyClaims = (iat: number) => ({
    iss: 'vouched.run',
    sub: agentId,
    iat,
    exp: iat + 24 * HOUR,
    version: '1.0.0',
    scores: { reliability: 0.9 },
    counts: { events: 12, verified_tasks: 1 },
  });

  // What seal show and seal verify print for claims(), one line each.
  const SUMMARY = [
    'level bronze',
    'events 12',
    'history days 3',
    'verified tasks 26',
    'seed tasks 25',
    'server checked tasks 1',
    'confirmed tasks 0',
    'distinct operators 1',
    'safety incidents in 90 days 0',
    'operator verified no',
    'last active 2026-09-22',
    'dormant days 2',
  ];

  // The pretty printed payload, from its opening brace to the line before
  // the expiry.
  const jsonBlock = (lines: string[]) =>
    JSON.parse(lines.slice(lines.indexOf('{'), -1).join('\n'));

  async function run(fetcher: typeof fetch, ...args: string[]) {
    const deps: Partial<SealDeps> = {
      fetch: fetcher,
      now: () => now,
      readStdin: async () => stdin,
    };
    const program = createProgram({ seal: deps, card: { fetch: fetcher } });
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
      return { code: Number(process.exitCode ?? 0), out, err } as RunResult;
    } catch (error) {
      if (error instanceof CommanderError) {
        return { code: error.exitCode, out, err } as RunResult;
      }
      throw error;
    } finally {
      process.exitCode = undefined;
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  const offline = (async (input: string | URL | Request) => {
    requests.push(String(input));
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vouched-seal-'));
    vi.stubEnv('VOUCHED_HOME', home);
    vi.stubEnv('VOUCHED_API_URL', API_URL);
    ({ agentId } = await createKey());
    serverKey = await generateKeypair();
    requests = [];
    now = NOW;
    stdin = '';
    published = () => ({ keys: [jwk(KID, serverKey)] });
    currentSeal = () => sign(claims(), serverKey.privateKey, KID);
    fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === WELL_KNOWN) return Response.json(published());
      if (url === `${API_URL}/v1/agents/${agentId}/seal`) {
        const seal = await currentSeal();
        const body = seal.split('.')[1] ?? '';
        return Response.json({
          credential: seal,
          payload: JSON.parse(Buffer.from(body, 'base64url').toString()),
        });
      }
      return Response.json(
        { error: { code: 'not_found', message: 'not found' } },
        { status: 404 },
      );
    }) as typeof fetch;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  describe('show and write', () => {
    // getCredential reads the real clock, so these SEALs expire relative
    // to it.
    beforeEach(async () => {
      now = Date.now();
      const nowSec = Math.floor(now / 1000);
      currentSeal = () =>
        sign(
          claims({ iat: nowSec - HOUR, exp: nowSec + 24 * HOUR + 30 }),
          serverKey.privateKey,
          KID,
        );
      await writeConfig({
        agentId,
        operatorLogin: 'carelmeyer',
        name: 'summariser',
        version: '1.0.0',
        apiUrl: API_URL,
        registeredAt: new Date().toISOString(),
      });
    });

    it('seal show prints the SEAL, its payload and time to expiry', async () => {
      const { code, out, err } = await run(fetchFn, 'seal', 'show');
      expect(code).toBe(0);
      expect(err).toBe('');
      const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
      const [first, ...rest] = out.trimEnd().split('\n');
      expect(first).toBe(cache.credential);
      expect(rest.at(-1)).toBe('Expires in 24 hours 0 minutes');
      const brace = rest.indexOf('{');
      expect(rest.slice(0, brace)).toEqual([
        ...SUMMARY.slice(0, -2),
        expect.stringMatching(/^last active \d{4}-\d{2}-\d{2}$/),
        'dormant days 2',
      ]);
      const payload = jsonBlock(rest);
      expect(payload).toMatchObject({ iss: 'vouched.run', sub: agentId });
      expect(rest.slice(brace, -1).join('\n')).toBe(
        JSON.stringify(payload, null, 2),
      );
    });

    it('seal show --json prints seal, payload and expiresAt', async () => {
      const { code, out } = await run(fetchFn, 'seal', 'show', '--json');
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(Object.keys(json)).toEqual(['seal', 'payload', 'expiresAt']);
      expect(json.seal.split('.')).toHaveLength(3);
      expect(json.payload.sub).toBe(agentId);
      expect(json.expiresAt).toBe(
        new Date(json.payload.exp * 1000).toISOString(),
      );
    });

    it('seal show reuses the cached SEAL card show uses', async () => {
      await run(fetchFn, 'card', 'show');
      requests = [];
      const { code } = await run(fetchFn, 'seal', 'show');
      expect(code).toBe(0);
      expect(requests).toEqual([]);
    });

    it('seal show with no API and no cache exits 1', async () => {
      const { code, out, err } = await run(offline, 'seal', 'show');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe(`${NO_SEAL}\n`);
    });

    it('seal show without config prints the init hint', async () => {
      await rm(paths().config);
      const { code, err } = await run(fetchFn, 'seal', 'show');
      expect(code).toBe(1);
      expect(err).toBe('not initialised, run vouched init\n');
    });

    it('seal write writes seal.txt with the SEAL and a newline', async () => {
      const dir = join(home, 'site');
      await mkdir(dir);
      const { code, out } = await run(fetchFn, 'seal', 'write', '--dir', dir);
      expect(code).toBe(0);
      const target = join(dir, 'seal.txt');
      expect(out).toBe(`${target}\n`);
      const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
      expect(await readFile(target, 'utf8')).toBe(`${cache.credential}\n`);
      expect((await stat(target)).mode & 0o777).toBe(0o644);

      const json = await run(fetchFn, 'seal', 'write', '--dir', dir, '--json');
      expect(JSON.parse(json.out)).toEqual({ path: target });
    });

    it('seal write defaults to the current directory, like card write', async () => {
      const spy = vi.spyOn(process, 'cwd').mockReturnValue(home);
      try {
        const { code, out } = await run(fetchFn, 'seal', 'write');
        expect(code).toBe(0);
        expect(out).toBe(`${join(home, 'seal.txt')}\n`);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('verify', () => {
    it('a valid SEAL exits 0 with the payload and time to expiry', async () => {
      const seal = await currentSeal();
      const { code, out, err } = await run(fetchFn, 'seal', 'verify', seal);
      expect(err).toBe('');
      expect(code).toBe(0);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('valid SEAL');
      expect(lines.slice(1, lines.indexOf('{'))).toEqual(SUMMARY);
      expect(lines.at(-1)).toBe('Expires in 24 hours 0 minutes');
      expect(jsonBlock(lines)).toEqual(claims());
      expect(requests).toEqual([WELL_KNOWN]);
    });

    it('prints identity references and a null last active', async () => {
      const seal = await sign(
        claims({
          last_active: null,
          dormant_days: null,
          level: 'none',
          identity: [
            {
              provider: 'https://login.example.com',
              kind: 'oidc',
              ref: 'https://login.example.com/a/1',
              subject_hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg',
              attested_at: NOW_SEC - 86_400,
              scope: 'operator',
            },
          ],
          operator: { verified: true },
        }),
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(0);
      const lines = out.trimEnd().split('\n');
      expect(lines).toContain('level none');
      expect(lines).toContain('operator verified yes');
      expect(lines).toContain('last active never');
      expect(lines).toContain('dormant days none');
      expect(lines).toContain(
        'identity oidc operator from https://login.example.com, attested 2026-09-23',
      );
    });

    it.each([2, 0])('ver %s is an unsupported version, exit 1', async (ver) => {
      const seal = await sign({ ...claims(), ver }, serverKey.privateKey, KID);
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('broken SEAL: unsupported version');
      expect(lines).not.toContain('level bronze');
      const json = await run(fetchFn, 'seal', 'verify', seal, '--json');
      expect(JSON.parse(json.out)).toMatchObject({
        valid: false,
        reason: 'unsupported version',
      });
    });

    it('a SEAL without ver is valid as legacy until the end of 25 September 2026 UTC', async () => {
      const iat = LEGACY_UNTIL - HOUR;
      const seal = await sign(legacyClaims(iat), serverKey.privateKey, KID);
      now = (LEGACY_UNTIL - 1) * 1000;
      const before = await run(fetchFn, 'seal', 'verify', seal);
      expect(before.code).toBe(0);
      const lines = before.out.trimEnd().split('\n');
      expect(lines.slice(0, 3)).toEqual([
        'valid SEAL',
        'level not in this SEAL, it was issued before version 1',
        'events 12',
      ]);
      expect(lines).toContain('verified tasks 1');
      expect(lines).not.toContain('operator verified no');

      now = LEGACY_UNTIL * 1000;
      const after = await run(fetchFn, 'seal', 'verify', seal);
      expect(after.code).toBe(1);
      expect(after.out.split('\n')[0]).toBe('broken SEAL: unsupported version');

      // Version 1 is valid either side of the cutoff.
      const v1 = await sign(
        claims({ iat, exp: iat + 24 * HOUR }),
        serverKey.privateKey,
        KID,
      );
      expect((await run(fetchFn, 'seal', 'verify', v1)).code).toBe(0);
    });

    it('--json prints valid, reason, payload and expiresAt', async () => {
      const seal = await currentSeal();
      const { code, out } = await run(
        fetchFn,
        'seal',
        'verify',
        seal,
        '--json',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        valid: true,
        reason: null,
        payload: claims(),
        expiresAt: new Date((NOW_SEC + 24 * HOUR) * 1000).toISOString(),
      });
    });

    it('a tampered signature is a broken SEAL, exit 1, no payload', async () => {
      const seal = tamper(await currentSeal());
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out).toBe('broken SEAL: bad signature\n');

      const json = await run(fetchFn, 'seal', 'verify', seal, '--json');
      expect(json.code).toBe(1);
      expect(JSON.parse(json.out)).toEqual({
        valid: false,
        reason: 'bad signature',
        payload: null,
        expiresAt: null,
      });
    });

    it('a SEAL signed by another key under a known kid is a bad signature', async () => {
      const other = await generateKeypair();
      const seal = await sign(claims(), other.privateKey, KID);
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out).toBe('broken SEAL: bad signature\n');
    });

    it('an unknown kid is refetched once, then broken', async () => {
      const seal = await sign(claims(), serverKey.privateKey, 'retired');
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      requests = [];
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out).toBe('broken SEAL: unknown kid\n');
      expect(requests).toEqual([WELL_KNOWN]);
    });

    it('a wrong issuer is broken, with the signed payload shown', async () => {
      const seal = await sign(
        claims({ iss: 'evil.example' as 'vouched.run' }),
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('broken SEAL: wrong issuer');
      expect(JSON.parse(lines.slice(1).join('\n')).iss).toBe('evil.example');
    });

    it('an expired SEAL says how long ago and exits 1', async () => {
      const seal = await sign(
        claims({ iat: NOW_SEC - 2 * HOUR, exp: NOW_SEC - 5 * 60 }),
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out.split('\n')[0]).toBe('broken SEAL: expired 5 minutes ago');
      expect(out).not.toContain('Expires in');

      const json = await run(fetchFn, 'seal', 'verify', seal, '--json');
      expect(JSON.parse(json.out)).toMatchObject({
        valid: false,
        reason: 'expired 5 minutes ago',
        expiresAt: new Date((NOW_SEC - 300) * 1000).toISOString(),
      });
    });

    it.each([
      ['not a JWS', 'hello'],
      ['bad header', 'eyJ4IjoxfQ.eyJ4IjoxfQ.c2ln'],
      ['empty', ''],
    ])('%s is malformed, exit 1, nothing fetched', async (_, seal) => {
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out).toBe('broken SEAL: malformed\n');
      expect(requests).toEqual([]);
    });

    it('a signed payload that is not a SEAL is malformed', async () => {
      const seal = await sign({ hello: 'world' }, serverKey.privateKey, KID);
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out.split('\n')[0]).toBe('broken SEAL: malformed');
    });

    it('--keys reads the keys from a file and never fetches', async () => {
      const file = join(home, 'vouched.json');
      await writeFile(file, JSON.stringify(published()));
      const seal = await currentSeal();
      const { code, out } = await run(
        offline,
        'seal',
        'verify',
        seal,
        '--keys',
        file,
      );
      expect(code).toBe(0);
      expect(out.split('\n')[0]).toBe('valid SEAL');
      expect(requests).toEqual([]);
    });

    it('--keys with a missing or wrong file exits 2', async () => {
      const seal = await currentSeal();
      const missing = await run(
        offline,
        'seal',
        'verify',
        seal,
        '--keys',
        join(home, 'nope.json'),
      );
      expect(missing.code).toBe(2);
      expect(missing.err).toContain('could not read keys from');

      const file = join(home, 'wrong.json');
      await writeFile(file, '{"keys":[]}');
      const wrong = await run(offline, 'seal', 'verify', seal, '--keys', file);
      expect(wrong.code).toBe(2);
      expect(wrong.err).toContain('is not a Vouched keys document');
      expect(requests).toEqual([]);
    });

    it('keys that cannot be fetched and are not cached exit 2', async () => {
      const { code, out, err } = await run(
        offline,
        'seal',
        'verify',
        await currentSeal(),
      );
      expect(code).toBe(2);
      expect(out).toBe('');
      expect(err).toContain(
        `could not load the Vouched keys from ${WELL_KNOWN}`,
      );
    });

    it('caches the keys with the fetch time and reuses them for a day', async () => {
      const seal = await currentSeal();
      await run(fetchFn, 'seal', 'verify', seal);
      const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      expect(cache).toEqual({
        v: 1,
        fetchedAt: new Date(NOW).toISOString(),
        wellKnown: published(),
      });

      requests = [];
      now = NOW + KEYS_MAX_AGE_MS - 60_000;
      const fresh = await currentSealAt(now);
      expect((await run(fetchFn, 'seal', 'verify', fresh)).code).toBe(0);
      expect(requests).toEqual([]);

      now = NOW + KEYS_MAX_AGE_MS + 60_000;
      expect(
        (await run(fetchFn, 'seal', 'verify', await currentSealAt(now))).code,
      ).toBe(0);
      expect(requests).toEqual([WELL_KNOWN]);
    });

    it('refetches cached keys that do not know the kid', async () => {
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      const rotated = await generateKeypair();
      published = () => ({
        keys: [jwk(KID, serverKey), jwk('vouched-test-2', rotated)],
      });
      requests = [];
      const seal = await sign(claims(), rotated.privateKey, 'vouched-test-2');
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(0);
      expect(out.split('\n')[0]).toBe('valid SEAL');
      expect(requests).toEqual([WELL_KNOWN]);
      const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      expect(cache.wellKnown.keys).toHaveLength(2);
    });

    it('falls back to stale cached keys when the API is unreachable', async () => {
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      now = NOW + KEYS_MAX_AGE_MS + 60_000;
      const { code, out, err } = await run(
        offline,
        'seal',
        'verify',
        await currentSealAt(now),
      );
      expect(code).toBe(0);
      expect(out.split('\n')[0]).toBe('valid SEAL');
      expect(err).toMatch(/^warning: could not fetch the Vouched keys/);
    });

    it('reads the SEAL from stdin when the argument is -', async () => {
      stdin = `${await currentSeal()}\n`;
      const { code, out } = await run(fetchFn, 'seal', 'verify', '-');
      expect(code).toBe(0);
      expect(out.split('\n')[0]).toBe('valid SEAL');

      stdin = tamper(stdin.trim());
      const broken = await run(fetchFn, 'seal', 'verify', '-');
      expect(broken.code).toBe(1);
      expect(broken.out).toBe('broken SEAL: bad signature\n');
    });

    it('needs no config or key', async () => {
      await rm(paths().key, { force: true });
      const { code } = await run(
        fetchFn,
        'seal',
        'verify',
        await currentSeal(),
      );
      expect(code).toBe(0);
    });

    async function currentSealAt(atMs: number): Promise<string> {
      const sec = Math.floor(atMs / 1000);
      return sign(
        claims({ iat: sec - HOUR, exp: sec + 24 * HOUR }),
        serverKey.privateKey,
        KID,
      );
    }
  });
});
