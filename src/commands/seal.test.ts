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
import { join } from 'node:path';
import {
  base64urlEncode,
  CLI_VERSION_HEADER,
  type VerifiedCredentialPayload as CredentialPayload,
  generateKeypair,
  HANDSHAKE_ROUTINE_RECORD_NOTE,
  LEGACY_ISSUER_UNTIL,
  LEGACY_ISSUERS,
  partHash,
  sign,
  signHandshake,
  verifyHandshake,
  WELL_KNOWN_MAX_AGE_SECONDS,
  WELL_KNOWN_URL,
  X402_UNPAID_NOTE,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_URL, paths, writeConfig } from '../config.js';
import { recordCapture } from '../fingerprint.js';
import { makeHandshake } from '../handshake.js';
import { createKey, loadKey } from '../identity.js';
import { createProgram } from '../program.js';
import type { WellKnown } from '../responses.js';
import {
  cacheKeys,
  ISSUER_ORIGIN,
  KEYS_MAX_AGE_MS,
  KEYS_OFFLINE_MAX_AGE_MS,
  keysBaseUrl,
  recordApiUrl,
} from '../seal.js';
import { VERSION } from '../version.js';
import type { SealDeps } from './seal.js';
import { NO_FINGERPRINT } from './seal-handshake.js';
import { NO_SEAL } from './seal-show.js';
import { SERVICE_HANDSHAKE } from './seal-verify.js';

const API_URL = 'https://api.test';
const WELL_KNOWN = `${API_URL}/.well-known/seal.json`;
const KID = 'sealkeeper-test-1';
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

describe('sealkeeper seal', () => {
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
      iss: 'sealkeeper.run',
      sub: agentId,
      ver: 1,
      iat: NOW_SEC,
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

  // The shape issued before version 1, with no ver. No longer accepted.
  const legacyClaims = (iat: number) => ({
    iss: 'sealkeeper.run',
    sub: agentId,
    iat,
    exp: iat + 24 * HOUR,
    version: '1.0.0',
    scores: { reliability: 0.9 },
    counts: { events: 12, verified_tasks: 1 },
  });

  // What seal show and seal verify print for claims(), one line each.
  const SUMMARY = [
    'level Bronze Agent SEAL',
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
    const program = createProgram({ seal: deps });
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
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-seal-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', API_URL);
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
      // The local API's keys, the issuer's and the production API's.
      if (
        url === WELL_KNOWN ||
        url === WELL_KNOWN_URL ||
        url === `${DEFAULT_API_URL}/.well-known/seal.json`
      ) {
        return Response.json(published());
      }
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
      // Issued 30 seconds ahead of the clock, inside the five minute skew,
      // so the time left still reads 24 hours 0 minutes.
      currentSeal = () =>
        sign(
          claims({ iat: nowSec + 30, exp: nowSec + 24 * HOUR + 30 }),
          serverKey.privateKey,
          KID,
        );
      await writeConfig({
        agentId,
        operatorLogin: 'alice',
        name: 'summariser',
        version: '1.0.0',
        apiUrl: API_URL,
        registeredAt: new Date().toISOString(),
      });
    });

    it('seal show prints its kind, the SEAL, its payload and time to expiry', async () => {
      const { code, out, err } = await run(fetchFn, 'seal', 'show');
      expect(code).toBe(0);
      expect(err).toBe('');
      const cache = JSON.parse(await readFile(paths().credential, 'utf8'));
      const [kind, first, ...rest] = out.trimEnd().split('\n');
      expect(kind).toBe('Agent SEAL');
      expect(first).toBe(cache.credential);
      expect(rest.at(-1)).toBe('Expires in 24 hours 0 minutes');
      const brace = rest.indexOf('{');
      expect(rest.slice(0, brace)).toEqual([
        ...SUMMARY.slice(0, -2),
        expect.stringMatching(/^last active \d{4}-\d{2}-\d{2}$/),
        'dormant days 2',
      ]);
      const payload = jsonBlock(rest);
      expect(payload).toMatchObject({ iss: 'sealkeeper.run', sub: agentId });
      expect(rest.slice(brace, -1).join('\n')).toBe(
        JSON.stringify(payload, null, 2),
      );
    });

    it('seal show opens with Service SEAL for a service and prints its x402 evidence', async () => {
      const index = JSON.parse(
        await readFile(
          new URL('../../fixtures/index.json', import.meta.url),
          'utf8',
        ),
      );
      const service = index.cases.find(
        (c: { name: string }) => c.name === 'v7-service-valid',
      ).expected.pinned.payload;
      const nowSec = Math.floor(now / 1000);
      currentSeal = () =>
        sign(
          {
            ...service,
            sub: agentId,
            iat: nowSec + 30,
            exp: nowSec + 24 * HOUR + 30,
          },
          serverKey.privateKey,
          KID,
        );
      const { code, out } = await run(fetchFn, 'seal', 'show');
      expect(code).toBe(0);
      const lines = out.split('\n');
      expect(lines[0]).toBe('Service SEAL');
      expect(lines[2]).toBe('level Bronze Service SEAL');
      expect(lines[3]).toBe('interfaces x402, paid yes');
      expect(lines).toContain(
        'x402 valid challenges 55 of 56 checks, 3 endpoints',
      );
      expect(lines).toContain(X402_UNPAID_NOTE);
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

    it('seal show asks the API even with a cached SEAL, and falls back to it offline', async () => {
      await run(fetchFn, 'seal', 'write', '--dir', home);
      requests = [];
      const { code } = await run(fetchFn, 'seal', 'show');
      expect(code).toBe(0);
      expect(requests).toContain(`${API_URL}/v1/agents/${agentId}/seal`);
      const offlineShow = await run(offline, 'seal', 'show');
      expect(offlineShow.code).toBe(0);
      expect(offlineShow.err).toContain('using the cached SEAL');
    });

    it('seal show prints the hold rather than a cached SEAL of a held agent', async () => {
      await run(fetchFn, 'seal', 'write', '--dir', home);
      const { code, out, err } = await run(
        withheldFetch({
          error: { code: 'withheld', message: 'withheld for cause' },
          reason: 'safety',
        }),
        'seal',
        'show',
      );
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe(
        'no SEAL, withheld for cause, reason safety, none is issued while the hold is in force\n',
      );
    });

    it('seal show with no API and no cache exits 1', async () => {
      const { code, out, err } = await run(offline, 'seal', 'show');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe(`${NO_SEAL}\n`);
    });

    // The SEAL route's 404 when no SEAL is issued, with the agent's id.
    const withheldFetch = (body: object) =>
      (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        // The local API's keys, the issuer's and the production API's.
        if (
          url === WELL_KNOWN ||
          url === WELL_KNOWN_URL ||
          url === `${DEFAULT_API_URL}/.well-known/seal.json`
        ) {
          return Response.json(published());
        }
        return Response.json({ id: agentId, ...body }, { status: 404 });
      }) as typeof fetch;

    it('seal show names the hold reason class when the SEAL is withheld for cause', async () => {
      for (const reason of ['fraud', 'spam_ring']) {
        const { code, out, err } = await run(
          withheldFetch({
            error: { code: 'withheld', message: 'withheld for cause' },
            reason,
          }),
          'seal',
          'show',
        );
        expect(code).toBe(1);
        expect(out).toBe('');
        expect(err).toBe(
          `no SEAL, withheld for cause, reason ${reason}, none is issued while the hold is in force\n`,
        );
      }
    });

    it('seal show gives the dormant days when the SEAL is withheld while dormant', async () => {
      const { code, out, err } = await run(
        withheldFetch({
          error: { code: 'no_seal', message: 'dormant' },
          dormant_days: 95,
        }),
        'seal',
        'show',
      );
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe(
        'no SEAL, withheld while the agent is dormant, 95 days, one returns on the next scoring run after activity\n',
      );
    });

    it("seal show says a suspended agent's SEAL is withheld since when and what lifts it", async () => {
      const suspended = await run(
        withheldFetch({
          error: { code: 'withheld', message: 'suspended' },
          reason: 'failed_checks',
          since: '2026-10-12T09:00:00.000Z',
        }),
        'seal',
        'show',
      );
      expect(suspended.code).toBe(1);
      expect(suspended.out).toBe('');
      expect(suspended.err).toBe(
        'no SEAL, withheld while the agent is suspended since 2026-10-12 09:00 UTC after its task checks failed, a passing recheck lifts it\n',
      );
      const stale = await run(
        withheldFetch({
          error: { code: 'withheld', message: 'no recent check' },
          reason: 'no_recent_check',
        }),
        'seal',
        'show',
      );
      expect(stale.code).toBe(1);
      expect(stale.err).toBe(
        'no SEAL, withheld until the agent passes a task check again\n',
      );
      const checking = await run(
        withheldFetch({ error: { code: 'checking', message: 'checking' } }),
        'seal',
        'show',
      );
      expect(checking.code).toBe(1);
      expect(checking.err).toBe(
        'no SEAL, withheld while the agent is checked\n',
      );
    });

    it('seal show without config prints the init hint', async () => {
      await rm(paths().config);
      const { code, err } = await run(fetchFn, 'seal', 'show');
      expect(code).toBe(1);
      expect(err).toBe('not initialised, run npx sealkeeper init\n');
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

    it('files a local API keys under its own origin, so they never check a production SEAL in seal verify', async () => {
      // The local API signs its own SEAL with a dev key under the
      // production iss, as a stack run from the public .env.example does.
      // The issuer's domain lists only the production key.
      const devKey = await generateKeypair();
      const nowSec = Math.floor(now / 1000);
      currentSeal = () =>
        sign(
          claims({ iat: nowSec, exp: nowSec + 24 * HOUR }),
          devKey.privateKey,
          'dev',
        );
      const local = (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url === WELL_KNOWN) {
          return Response.json({ keys: [jwk('dev', devKey)] });
        }
        if (url === WELL_KNOWN_URL) return Response.json(published());
        return fetchFn(input);
      }) as typeof fetch;

      const shown = await run(local, 'seal', 'show');
      expect(shown.code).toBe(0);
      const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      expect(cache.origin).toBe(API_URL);

      // A later run reuses the cached SEAL against the local API's own
      // keys, without asking the issuer's domain or the API again.
      requests = [];
      const written = await run(local, 'seal', 'write', '--dir', home);
      expect(written.code).toBe(0);
      expect(requests).toEqual([]);

      // The dev-signed SEAL with the production iss is refused online and
      // offline, whatever getCredential cached.
      const forged = await currentSeal();
      const online = await run(local, 'seal', 'verify', forged);
      expect(online.code).toBe(1);
      expect(online.out).toBe('broken SEAL: unknown kid\n');
      await cacheKeys(
        paths(),
        API_URL,
        { keys: [jwk('dev', devKey)] } as WellKnown,
        now,
      );
      const cut = await run(offline, 'seal', 'verify', forged, '--offline');
      expect(cut.code).toBe(2);
      expect(cut.out).toBe('');
      expect(cut.err).toContain(
        'the cached keys from https://sealkeeper.run do not include kid dev',
      );
    });

    it('seal write defaults to the current directory', async () => {
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
    // A production SEAL gets its keys from the issuer's domain wherever the
    // CLI points, so these point at the production API, where
    // seal verify prints no line about where the keys came from.
    beforeEach(() => {
      vi.stubEnv('SEALKEEPER_API_URL', DEFAULT_API_URL);
    });

    it('a valid SEAL exits 0 with the payload and time to expiry', async () => {
      const seal = await currentSeal();
      const { code, out, err } = await run(fetchFn, 'seal', 'verify', seal);
      expect(err).toBe('');
      expect(code).toBe(0);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('valid Agent SEAL');
      expect(lines.slice(1, lines.indexOf('{'))).toEqual(SUMMARY);
      expect(lines.at(-1)).toBe('Expires in 24 hours 0 minutes');
      expect(jsonBlock(lines)).toEqual(claims());
      expect(requests).toEqual([WELL_KNOWN_URL]);
    });

    // While safety is not measured the issuer leaves the safety
    // key out of scores and keeps safety_incidents_90d in the counts.
    it('a SEAL with no safety score is valid and prints the same summary', async () => {
      const seal = await sign(
        claims({ scores: { reliability: 0.9, cost_latency: null } }),
        serverKey.privateKey,
        KID,
      );
      const { code, out, err } = await run(fetchFn, 'seal', 'verify', seal);
      expect(err).toBe('');
      expect(code).toBe(0);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('valid Agent SEAL');
      expect(lines.slice(1, lines.indexOf('{'))).toEqual(SUMMARY);
      expect(jsonBlock(lines).scores).toEqual({
        reliability: 0.9,
        cost_latency: null,
      });
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
      expect(lines).toContain('level none, Agent SEAL');
      expect(lines).toContain('operator verified yes');
      expect(lines).toContain('last active never');
      expect(lines).toContain('dormant days none');
      expect(lines).toContain(
        'identity oidc operator from https://login.example.com, attested 2026-09-23',
      );
    });

    it('a version 2 SEAL is valid and shows the counted values beside the counts', async () => {
      const counted = {
        verified_tasks: 17,
        seed_tasks: 17,
        server_checked_tasks: 0,
        confirmed_tasks: 0,
      };
      const seal = await sign(
        { ...claims(), ver: 2, counted },
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(0);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('valid Agent SEAL');
      expect(lines).toContain('verified tasks 26, 17 counted');
      expect(lines).toContain('seed tasks 25, 17 counted');
      expect(lines).toContain('server checked tasks 1, 0 counted');
      expect(lines).toContain('confirmed tasks 0, 0 counted');
      expect(lines).toContain('distinct operators 1');
      // A version 1 SEAL from before counted evidence still verifies, and
      // shows the counts alone.
      const v1 = await run(
        fetchFn,
        'seal',
        'verify',
        await sign(claims(), serverKey.privateKey, KID),
      );
      expect(v1.code).toBe(0);
      expect(v1.out).toContain('verified tasks 26\n');
      expect(v1.out).not.toContain('counted');
    });

    it('a version 3 SEAL is valid and shows the posted counts, fingerprint and state', async () => {
      const { version: _version, ...rest } = claims();
      const seal = await sign(
        {
          ...rest,
          ver: 3,
          counts: {
            ...rest.counts,
            posted_tasks: 4,
            posted_distinct_operators: 2,
            posted_confirmed_tasks: 1,
          },
          counted: {
            verified_tasks: 17,
            seed_tasks: 17,
            server_checked_tasks: 0,
            confirmed_tasks: 0,
            posted_tasks: 3,
            posted_confirmed_tasks: 1,
          },
          fingerprint: {
            hash: 'BwjgHg-Z9sC4K05UnygMCN_CD7onYm12GfK83VEIpTQ',
            at: rest.iat,
          },
          state: 'matches',
        },
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(0);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('valid Agent SEAL');
      expect(lines).toContain('seed tasks 25, 17 counted');
      expect(lines).toContain('posted tasks 4, 3 counted');
      expect(lines).toContain('posted confirmed tasks 1, 1 counted');
      expect(lines).toContain('posted distinct operators 2');
      expect(lines).toContain(
        `fingerprint BwjgHg-Z9sC4K05UnygMCN_CD7onYm12GfK83VEIpTQ since ${new Date(rest.iat * 1000).toISOString().slice(0, 10)}`,
      );
      expect(lines).toContain('state matches');
    });

    // A version 4 SEAL carries the Trust Score and the top
    // categories, printed in the plain output, and --json prints them in
    // the payload as signed.
    it('a version 4 SEAL is valid and shows the Trust Score and the top categories', async () => {
      const { version: _version, ...rest } = claims();
      const v4 = {
        ...rest,
        ver: 4,
        counts: {
          ...rest.counts,
          posted_tasks: 4,
          posted_distinct_operators: 2,
          posted_confirmed_tasks: 1,
        },
        counted: {
          verified_tasks: 17,
          seed_tasks: 17,
          server_checked_tasks: 0,
          confirmed_tasks: 0,
          posted_tasks: 3,
          posted_confirmed_tasks: 1,
        },
        fingerprint: null,
        state: 'matches',
        trust: 412,
        top_categories: [
          { category: 'code', score: 230 },
          { category: 'data', score: 90 },
          { category: 'math', score: 90 },
        ],
      };
      const seal = await sign(v4, serverKey.privateKey, KID);
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(0);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('valid Agent SEAL');
      expect(lines).toContain('posted tasks 4, 3 counted');
      expect(lines).toContain('fingerprint none sent');
      expect(lines).toContain('state matches');
      expect(lines).toContain('Trust Score 412');
      expect(lines).toContain('top categories code 230, data 90, math 90');
      const json = await run(fetchFn, 'seal', 'verify', seal, '--json');
      expect(JSON.parse(json.out)).toMatchObject({
        valid: true,
        payload: { ver: 4, trust: 412, top_categories: v4.top_categories },
      });
      // No category yet reads as none, and a version 3 SEAL prints neither.
      const empty = await run(
        fetchFn,
        'seal',
        'verify',
        await sign(
          { ...v4, trust: 0, top_categories: [] },
          serverKey.privateKey,
          KID,
        ),
      );
      expect(empty.out).toContain('Trust Score 0\ntop categories none yet\n');
      const { trust: _t, top_categories: _c, ...v3 } = { ...v4, ver: 3 };
      const three = await run(
        fetchFn,
        'seal',
        'verify',
        await sign(v3, serverKey.privateKey, KID),
      );
      expect(three.code).toBe(0);
      expect(three.out).not.toContain('Trust Score');
      expect(three.out).not.toContain('top categories');
      // An unknown field on version 4 is broken, as on every version.
      const extra = await run(
        fetchFn,
        'seal',
        'verify',
        await sign({ ...v4, extra: true }, serverKey.privateKey, KID),
      );
      expect(extra.code).toBe(1);
      expect(extra.out.split('\n')[0]).toBe('broken SEAL: malformed');
    });

    // A listed agent's version 5 SEAL prints its handle, its owner
    // status and its endpoint checks beside the version 4 lines.
    it('a version 5 SEAL of a listed agent is valid and shows its owner and endpoint checks', async () => {
      const { version: _version, ...rest } = claims();
      const v5 = {
        ...rest,
        ver: 5,
        counts: {
          ...rest.counts,
          posted_tasks: 0,
          posted_distinct_operators: 0,
          posted_confirmed_tasks: 0,
        },
        counted: {
          verified_tasks: 17,
          seed_tasks: 17,
          server_checked_tasks: 0,
          confirmed_tasks: 0,
          posted_tasks: 0,
          posted_confirmed_tasks: 0,
        },
        fingerprint: null,
        state: 'matches',
        trust: 0,
        top_categories: [],
        owner: { status: 'unverified' },
        listing: {
          handle: 'acme.ai/helper',
          domain_key: 'acme.ai',
          card_url: 'https://acme.ai/.well-known/agent-card.json',
        },
        evidence: [
          {
            type: 'endpoint_check',
            window_start: '2026-09-01T00:00:00.000Z',
            window_end: '2026-10-01T00:00:00.000Z',
            task_total: 12,
            task_ok: 11,
            uptime_pct: 99.5,
            p95_ms: 820,
            last_checked_at: null,
          },
        ],
      };
      const unverified = await run(
        fetchFn,
        'seal',
        'verify',
        await sign(v5, serverKey.privateKey, KID),
      );
      expect(unverified.code).toBe(0);
      const lines = unverified.out.trimEnd().split('\n');
      expect(lines[0]).toBe('valid Agent SEAL');
      expect(lines).toContain('Trust Score 0');
      expect(lines).toContain('listed as acme.ai/helper');
      expect(lines).toContain('owner unverified');
      expect(lines).toContain('endpoint checks 11 of 12 OK');
      const verified = await run(
        fetchFn,
        'seal',
        'verify',
        await sign(
          {
            ...v5,
            owner: {
              status: 'verified',
              verified_at: '2026-10-12T08:00:00.000Z',
              method: 'email',
            },
          },
          serverKey.privateKey,
          KID,
        ),
      );
      expect(verified.out).toContain('owner verified by email on 2026-10-12');
    });

    it.each([8, 0])('ver %s is an unsupported version, exit 1', async (ver) => {
      const seal = await sign({ ...claims(), ver }, serverKey.privateKey, KID);
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('broken SEAL: unsupported version');
      expect(lines).not.toContain('level Bronze Agent SEAL');
      const json = await run(fetchFn, 'seal', 'verify', seal, '--json');
      expect(JSON.parse(json.out)).toMatchObject({
        valid: false,
        reason: 'unsupported version',
      });
    });

    it('a SEAL without ver, issued before version 1, is an unsupported version, exit 1', async () => {
      const seal = await sign(
        legacyClaims(NOW_SEC - HOUR),
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out.split('\n')[0]).toBe('broken SEAL: unsupported version');
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
      const { code, out, err } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out).toBe('broken SEAL: unknown kid\n');
      expect(requests).toEqual([WELL_KNOWN_URL]);
      // On the production API there is nothing to say about the keys.
      expect(err).toBe('');
    });

    it('a wrong issuer is broken, with the signed payload shown', async () => {
      const seal = await sign(
        claims({ iss: 'evil.example' as 'sealkeeper.run' }),
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      const lines = out.trimEnd().split('\n');
      expect(lines[0]).toBe('broken SEAL: wrong issuer');
      expect(JSON.parse(lines.slice(1).join('\n')).iss).toBe('evil.example');
    });

    it('accepts the old issuer until LEGACY_ISSUER_UNTIL, then names it a wrong issuer', async () => {
      const legacy = LEGACY_ISSUERS[0];
      const iat = LEGACY_ISSUER_UNTIL - HOUR;
      const seal = await sign(
        claims({ iss: legacy as 'sealkeeper.run', iat, exp: iat + 24 * HOUR }),
        serverKey.privateKey,
        KID,
      );
      now = (LEGACY_ISSUER_UNTIL - 1) * 1000;
      const before = await run(fetchFn, 'seal', 'verify', seal);
      expect(before.code).toBe(0);
      expect(before.out.split('\n')[0]).toBe('valid Agent SEAL');
      now = LEGACY_ISSUER_UNTIL * 1000;
      const after = await run(fetchFn, 'seal', 'verify', seal);
      expect(after.code).toBe(1);
      expect(after.out.split('\n')[0]).toBe('broken SEAL: wrong issuer');
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

    it('a signed sealkeeper.run payload that is not a SEAL is malformed', async () => {
      const seal = await sign(
        { iss: 'sealkeeper.run', ver: 1, hello: 'world' },
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out.split('\n')[0]).toBe('broken SEAL: malformed');
    });

    it('a signed payload of another issuer, in no SEAL shape, is a wrong issuer', async () => {
      for (const payload of [{ hello: 'world' }, { iss: 'other.example' }]) {
        const seal = await sign(payload, serverKey.privateKey, KID);
        const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
        expect(code).toBe(1);
        expect(out.split('\n')[0]).toBe('broken SEAL: wrong issuer');
      }
    });

    it('a SEAL issued more than five minutes ahead is not yet valid', async () => {
      const seal = await sign(
        claims({ iat: NOW_SEC + 301, exp: NOW_SEC + 301 + 24 * HOUR }),
        serverKey.privateKey,
        KID,
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(1);
      expect(out.split('\n')[0]).toBe('broken SEAL: not yet valid');
      expect(out).not.toContain('Expires in');
    });

    // --at checks a SEAL kept beside a past event at that time,
    // with the same verifySeal as the API, and says when it has lapsed
    // since.
    describe('--at', () => {
      const DAY = 24 * HOUR;
      const T = NOW_SEC - 3 * DAY;
      const iso = (sec: number) => new Date(sec * 1000).toISOString();
      const old = () =>
        sign(claims({ iat: T, exp: T + DAY }), serverKey.privateKey, KID);

      it('a SEAL expired now but within its lifetime at --at exits 0 and says it lapsed', async () => {
        const seal = await old();
        const { code, out, err } = await run(
          fetchFn,
          'seal',
          'verify',
          seal,
          '--at',
          iso(T + HOUR),
        );
        expect(err).toBe('');
        expect(code).toBe(0);
        const lines = out.trimEnd().split('\n');
        expect(lines[0]).toBe(`valid Agent SEAL at ${iso(T + HOUR)}`);
        expect(lines.slice(1, lines.indexOf('{'))).toEqual(SUMMARY);
        expect(lines.at(-1)).toBe(
          `expired since ${iso(T + DAY)}, valid at the time checked only`,
        );
        // An offset is read and the time printed in UTC.
        const offset = await run(
          fetchFn,
          'seal',
          'verify',
          seal,
          '--at',
          '2026-09-21T15:00:00+02:00',
        );
        expect(offset.out.split('\n')[0]).toBe(
          'valid Agent SEAL at 2026-09-21T13:00:00.000Z',
        );
        // Without --at the same SEAL is expired.
        const nowCheck = await run(fetchFn, 'seal', 'verify', seal);
        expect(nowCheck.code).toBe(1);
        expect(nowCheck.out.split('\n')[0]).toMatch(/^broken SEAL: expired /);
      });

      it('a SEAL still live at --at prints the usual time to expiry', async () => {
        const seal = await currentSeal();
        const { code, out } = await run(
          fetchFn,
          'seal',
          'verify',
          seal,
          '--at',
          iso(NOW_SEC + 60),
        );
        expect(code).toBe(0);
        const lines = out.trimEnd().split('\n');
        expect(lines[0]).toBe(`valid Agent SEAL at ${iso(NOW_SEC + 60)}`);
        expect(lines.at(-1)).toBe('Expires in 24 hours 0 minutes');
      });

      it('--at before iat is not yet valid, exit 1', async () => {
        const { code, out } = await run(
          fetchFn,
          'seal',
          'verify',
          await old(),
          '--at',
          iso(T - HOUR),
        );
        expect(code).toBe(1);
        expect(out.split('\n')[0]).toBe('broken SEAL: not yet valid');
      });

      it('--at with a bad signature is a broken SEAL, exit 1, never valid', async () => {
        const { code, out } = await run(
          fetchFn,
          'seal',
          'verify',
          tamper(await old()),
          '--at',
          iso(T + HOUR),
        );
        expect(code).toBe(1);
        expect(out).toBe('broken SEAL: bad signature\n');
      });

      it('--json carries at and lapsed', async () => {
        const seal = await old();
        const json = await run(
          fetchFn,
          'seal',
          'verify',
          seal,
          '--at',
          iso(T + HOUR),
          '--json',
        );
        expect(json.code).toBe(0);
        expect(JSON.parse(json.out)).toEqual({
          valid: true,
          reason: null,
          payload: claims({ iat: T, exp: T + DAY }),
          expiresAt: iso(T + DAY),
          at: iso(T + HOUR),
          lapsed: true,
        });
        const live = await run(
          fetchFn,
          'seal',
          'verify',
          await currentSeal(),
          '--at',
          iso(NOW_SEC + 60),
          '--json',
        );
        expect(JSON.parse(live.out)).toMatchObject({
          valid: true,
          at: iso(NOW_SEC + 60),
          lapsed: false,
        });
        // Without --at neither is there.
        const plain = JSON.parse(
          (await run(fetchFn, 'seal', 'verify', seal, '--json')).out,
        );
        expect(plain).not.toHaveProperty('lapsed');
        expect(plain).not.toHaveProperty('at');
      });

      it('refuses --at in the future or not ISO 8601, with nothing fetched', async () => {
        const seal = await currentSeal();
        const future = await run(
          fetchFn,
          'seal',
          'verify',
          seal,
          '--at',
          iso(NOW_SEC + DAY),
        );
        expect(future.code).toBe(1);
        expect(future.out).toBe('');
        expect(future.err).toContain('--at must not be in the future');
        // Inside the five minute skew it is taken.
        expect(
          (
            await run(
              fetchFn,
              'seal',
              'verify',
              seal,
              '--at',
              iso(NOW_SEC + 300),
            )
          ).code,
        ).toBe(0);
        requests = [];
        for (const at of ['yesterday', '2026-09-24', '2026-09-24T12:00:00']) {
          const bad = await run(fetchFn, 'seal', 'verify', seal, '--at', at);
          expect(bad.code).toBe(1);
          expect(bad.err).toContain(
            '--at must be an ISO 8601 date time, such as 2026-10-01T12:00:00Z',
          );
        }
        expect(requests).toEqual([]);
      });
    });

    it('--keys reads the keys from a file and never fetches', async () => {
      const file = join(home, 'sealkeeper.json');
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
      expect(out.split('\n')[0]).toBe('valid Agent SEAL');
      expect(requests).toEqual([]);
    });

    it('--agent refuses a copied SEAL for another agent as a broken SEAL, exit 1', async () => {
      const seal = await currentSeal();
      const other = await generateKeypair();
      const copied = await run(
        fetchFn,
        'seal',
        'verify',
        seal,
        '--agent',
        other.agentId,
      );
      expect(copied.code).toBe(1);
      expect(copied.out.split('\n')[0]).toBe('broken SEAL: wrong agent');
      // Never the summary of a SEAL for someone else.
      expect(copied.out).not.toContain('level Bronze Agent SEAL');
      const json = await run(
        fetchFn,
        'seal',
        'verify',
        seal,
        '--agent',
        other.agentId,
        '--json',
      );
      expect(JSON.parse(json.out)).toMatchObject({
        valid: false,
        reason: 'wrong agent',
      });
      const right = await run(
        fetchFn,
        'seal',
        'verify',
        seal,
        '--agent',
        agentId,
      );
      expect(right.code).toBe(0);
      const bad = await run(fetchFn, 'seal', 'verify', seal, '--agent', 'x');
      expect(bad.code).toBe(1);
      expect(bad.err).toContain('--agent must be an agent id');
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
      expect(wrong.err).toContain('is not a SealKeeper keys document');
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
        `could not load the SealKeeper keys from ${WELL_KNOWN_URL}`,
      );
    });

    it('caches the keys with the fetch time and reuses them for a day', async () => {
      const seal = await currentSeal();
      await run(fetchFn, 'seal', 'verify', seal);
      const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      expect(cache).toEqual({
        v: 1,
        origin: ISSUER_ORIGIN,
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
      expect(requests).toEqual([WELL_KNOWN_URL]);
    });

    it('refetches cached keys that do not know the kid', async () => {
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      const rotated = await generateKeypair();
      published = () => ({
        keys: [jwk(KID, serverKey), jwk('sealkeeper-test-2', rotated)],
      });
      requests = [];
      const seal = await sign(
        claims(),
        rotated.privateKey,
        'sealkeeper-test-2',
      );
      const { code, out } = await run(fetchFn, 'seal', 'verify', seal);
      expect(code).toBe(0);
      expect(out.split('\n')[0]).toBe('valid Agent SEAL');
      expect(requests).toEqual([WELL_KNOWN_URL]);
      const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      expect(cache.wellKnown.keys).toHaveLength(2);
    });

    it('refetches the keys after their five minute max-age and never falls back when the fetch fails', async () => {
      expect(KEYS_MAX_AGE_MS).toBe(WELL_KNOWN_MAX_AGE_SECONDS * 1000);
      expect(KEYS_MAX_AGE_MS).toBe(300_000);
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      // SealKeeper withdraws the key after a compromise. Within the max-age
      // the copy stands, after it the list is read again and the SEAL that
      // key signed is broken.
      published = () => ({ keys: [jwk('sealkeeper-test-2', serverKey)] });
      requests = [];
      now = NOW + KEYS_MAX_AGE_MS + 1000;
      const stale = await run(
        fetchFn,
        'seal',
        'verify',
        await currentSealAt(now),
      );
      expect(requests).toEqual([WELL_KNOWN_URL]);
      expect(stale.code).toBe(1);
      expect(stale.out).toBe('broken SEAL: unknown kid\n');

      // A fetch that fails is exit 2, not the cached copy.
      published = () => ({ keys: [jwk(KID, serverKey)] });
      await run(fetchFn, 'seal', 'verify', await currentSealAt(now));
      now += KEYS_MAX_AGE_MS + 1000;
      const { code, out, err } = await run(
        offline,
        'seal',
        'verify',
        await currentSealAt(now),
      );
      expect(code).toBe(2);
      expect(out).toBe('');
      expect(err).toContain(
        `could not load the SealKeeper keys from ${WELL_KNOWN_URL}`,
      );
      expect(err).toContain(
        'a cached copy is used only with npx sealkeeper seal verify --offline',
      );
    });

    it('never uses keys cached from another API origin', async () => {
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      await writeFile(
        paths().wellKnown,
        JSON.stringify({ ...cache, origin: 'https://other.test' }),
      );
      const offlineRun = await run(
        offline,
        'seal',
        'verify',
        await currentSeal(),
      );
      expect(offlineRun.code).toBe(2);
      expect(offlineRun.err).not.toContain('using the copy');

      requests = [];
      expect(
        (await run(fetchFn, 'seal', 'verify', await currentSeal())).code,
      ).toBe(0);
      expect(requests).toEqual([WELL_KNOWN_URL]);
      const rewritten = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      expect(rewritten.origin).toBe(ISSUER_ORIGIN);
    });

    it('fetches again over a cache from before the origin was kept', async () => {
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      const { origin: _, ...old } = JSON.parse(
        await readFile(paths().wellKnown, 'utf8'),
      );
      await writeFile(paths().wellKnown, JSON.stringify(old));
      requests = [];
      expect(
        (await run(fetchFn, 'seal', 'verify', await currentSeal())).code,
      ).toBe(0);
      expect(requests).toEqual([WELL_KNOWN_URL]);
    });

    it('reads cached keys with --offline only up to 7 days old, and names their age', async () => {
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      expect(KEYS_OFFLINE_MAX_AGE_MS).toBe(7 * 24 * 3600 * 1000);
      now = NOW + KEYS_OFFLINE_MAX_AGE_MS - 60_000;
      const inside = await run(
        offline,
        'seal',
        'verify',
        await currentSealAt(now),
        '--offline',
      );
      expect(inside.code).toBe(0);
      expect(inside.err).toBe(
        `offline, using the SealKeeper keys from ${ISSUER_ORIGIN} fetched at ${new Date(NOW).toISOString()}, 6 days old\n`,
      );

      now = NOW + KEYS_OFFLINE_MAX_AGE_MS + 60_000;
      const past = await run(
        offline,
        'seal',
        'verify',
        await currentSealAt(now),
        '--offline',
      );
      expect(past.code).toBe(2);
      expect(past.err).toContain(`is more than 7 days old`);
    });

    it('refetches cached keys dated in the future and never falls back to them', async () => {
      await run(fetchFn, 'seal', 'verify', await currentSeal());
      const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      const ahead = new Date(NOW + 3 * KEYS_OFFLINE_MAX_AGE_MS).toISOString();
      await writeFile(
        paths().wellKnown,
        JSON.stringify({ ...cache, fetchedAt: ahead }),
      );

      const offlineRun = await run(
        offline,
        'seal',
        'verify',
        await currentSeal(),
        '--offline',
      );
      expect(offlineRun.code).toBe(2);
      expect(offlineRun.err).not.toContain('using the');
      expect(offlineRun.err).toContain(
        `the copy fetched at ${ahead} is dated in the future`,
      );

      requests = [];
      expect(
        (await run(fetchFn, 'seal', 'verify', await currentSeal())).code,
      ).toBe(0);
      expect(requests).toEqual([WELL_KNOWN_URL]);
      const rewritten = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
      expect(rewritten.fetchedAt).toBe(new Date(NOW).toISOString());
    });

    it('reads the SEAL from stdin when the argument is -', async () => {
      stdin = `${await currentSeal()}\n`;
      const { code, out } = await run(fetchFn, 'seal', 'verify', '-');
      expect(code).toBe(0);
      expect(out.split('\n')[0]).toBe('valid Agent SEAL');

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

    describe('where the keys come from', () => {
      // The production API. The fetch answers the issuer's documented URL
      // and the API's own keys path, and records which one was asked.
      const PRODUCTION_KEYS = `${DEFAULT_API_URL}/.well-known/seal.json`;
      const production = (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url === WELL_KNOWN_URL || url === PRODUCTION_KEYS) {
          return Response.json(published());
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      beforeEach(() => {
        vi.stubEnv('SEALKEEPER_API_URL', DEFAULT_API_URL);
      });

      it('fetches the keys of a production SEAL from the issuer URL and caches them under its origin', async () => {
        const { code } = await run(
          production,
          'seal',
          'verify',
          await currentSeal(),
        );
        expect(code).toBe(0);
        expect(WELL_KNOWN_URL).toBe(
          'https://sealkeeper.run/.well-known/seal.json',
        );
        expect(requests).toEqual([WELL_KNOWN_URL]);
        const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
        expect(cache.origin).toBe('https://sealkeeper.run');
      });

      // The issuer's site is not the SealKeeper API, so it is not
      // told which CLI asks. A local API is, like every other API request.
      it('sends the CLI version to an API for the keys and never to the issuer site', async () => {
        const versions: Record<string, string | null> = {};
        const recording = (async (
          input: string | URL | Request,
          init?: RequestInit,
        ) => {
          versions[String(input)] = new Headers(init?.headers).get(
            CLI_VERSION_HEADER,
          );
          return Response.json(published());
        }) as typeof fetch;
        await run(recording, 'seal', 'verify', await currentSeal());
        vi.stubEnv('SEALKEEPER_API_URL', API_URL);
        // Only a SEAL of another issuer takes its keys from that API.
        const foreign = await sign(
          claims({ iss: 'other.test' as 'sealkeeper.run' }),
          serverKey.privateKey,
          KID,
        );
        await run(recording, 'seal', 'verify', foreign);
        expect(versions).toEqual({
          [WELL_KNOWN_URL]: null,
          [WELL_KNOWN]: VERSION,
        });
      });

      it('fetches the keys for a SEAL of another issuer from the API', async () => {
        const seal = await sign(
          claims({ iss: 'evil.example' as 'sealkeeper.run' }),
          serverKey.privateKey,
          KID,
        );
        const { code, out } = await run(production, 'seal', 'verify', seal);
        expect(code).toBe(1);
        expect(out.split('\n')[0]).toBe('broken SEAL: wrong issuer');
        expect(requests).toEqual([PRODUCTION_KEYS]);
      });

      it('never uses keys cached from a local API for a production SEAL', async () => {
        await cacheKeys(paths(), API_URL, published() as WellKnown, NOW);
        const { code, err } = await run(
          offline,
          'seal',
          'verify',
          await currentSeal(),
          '--offline',
        );
        expect(code).toBe(2);
        expect(err).toContain(
          'the cached keys from https://sealkeeper.run do not include kid',
        );
      });
    });

    describe('where the keys come from, edge cases', () => {
      const production = (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        return url === WELL_KNOWN_URL
          ? Response.json(published())
          : new Response('not found', { status: 404 });
      }) as typeof fetch;

      it('fetches the keys of a legacy vouched.run SEAL from the issuer URL', async () => {
        vi.stubEnv('SEALKEEPER_API_URL', DEFAULT_API_URL);
        const seal = await sign(
          claims({ iss: LEGACY_ISSUERS[0] as 'sealkeeper.run' }),
          serverKey.privateKey,
          KID,
        );
        const { code } = await run(production, 'seal', 'verify', seal);
        expect(code).toBe(0);
        expect(requests).toEqual([WELL_KNOWN_URL]);
      });

      it('checks a production SEAL with the issuer keys when the CLI points at a local API, and says so on every result', async () => {
        vi.stubEnv('SEALKEEPER_API_URL', API_URL);
        // A local API serves its own keys, which never check a production
        // SEAL, so a SEAL signed with a known dev key and the production
        // iss is refused.
        const devKey = await generateKeypair();
        const local = (async (input: string | URL | Request) => {
          const url = String(input);
          requests.push(url);
          if (url === WELL_KNOWN) {
            return Response.json({ keys: [jwk('dev', devKey)] });
          }
          return url === WELL_KNOWN_URL
            ? Response.json(published())
            : new Response('not found', { status: 404 });
        }) as typeof fetch;
        const note = `the keys came from ${ISSUER_ORIGIN}, the issuer's domain, not from ${API_URL}, the API this CLI points at. To check a SEAL that API signed, pass its /.well-known/seal.json with --keys\n`;
        const forged = await sign(claims(), devKey.privateKey, 'dev');
        const refused = await run(local, 'seal', 'verify', forged);
        expect(refused.code).toBe(1);
        expect(refused.out).toBe('broken SEAL: unknown kid\n');
        expect(refused.err).toBe(note);
        expect(requests).toEqual([WELL_KNOWN_URL]);
        const valid = await run(local, 'seal', 'verify', await currentSeal());
        expect(valid.code).toBe(0);
        expect(valid.err).toBe(note);
        // With --keys naming the local keys, the local SEAL verifies, and
        // nothing is said about a fetch that never happened.
        const file = join(home, 'local.json');
        await writeFile(file, JSON.stringify({ keys: [jwk('dev', devKey)] }));
        const named = await run(
          local,
          'seal',
          'verify',
          forged,
          '--keys',
          file,
        );
        expect(named.code).toBe(0);
        expect(named.err).toBe('');
      });

      it('keysBaseUrl reads the API origin through a trailing slash or a path', () => {
        for (const api of [
          `${DEFAULT_API_URL}/`,
          `${DEFAULT_API_URL}/v1`,
          `${DEFAULT_API_URL}/v1/`,
        ]) {
          expect(keysBaseUrl(api, 'sealkeeper.run'), api).toBe(ISSUER_ORIGIN);
        }
        // A production SEAL takes the issuer's keys wherever the CLI points.
        expect(keysBaseUrl(`${API_URL}/`, 'sealkeeper.run')).toBe(
          ISSUER_ORIGIN,
        );
        expect(keysBaseUrl(`${API_URL}/base`, 'other.test')).toBe(
          `${API_URL}/base`,
        );
        expect(keysBaseUrl(`${DEFAULT_API_URL}/`, 'other.test')).toBe(
          `${DEFAULT_API_URL}/`,
        );
      });

      it('fetches from the issuer URL when the production API URL has a trailing slash', async () => {
        vi.stubEnv('SEALKEEPER_API_URL', `${DEFAULT_API_URL}/`);
        const { code } = await run(
          production,
          'seal',
          'verify',
          await currentSeal(),
        );
        expect(code).toBe(0);
        expect(requests).toEqual([WELL_KNOWN_URL]);
      });

      it('fetches once, with no double slash, from a local API URL with a trailing slash', async () => {
        vi.stubEnv('SEALKEEPER_API_URL', `${API_URL}/`);
        const foreign = await sign(
          claims({ iss: 'other.test' as 'sealkeeper.run' }),
          serverKey.privateKey,
          KID,
        );
        const { code, out } = await run(fetchFn, 'seal', 'verify', foreign);
        expect(code).toBe(1);
        expect(out.split('\n')[0]).toBe('broken SEAL: wrong issuer');
        expect(requests).toEqual([WELL_KNOWN]);
        const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
        expect(cache.origin).toBe(API_URL);
      });
    });

    describe('--offline', () => {
      it('verifies with a fresh cache and never fetches', async () => {
        await run(fetchFn, 'seal', 'verify', await currentSeal());
        requests = [];
        const { code, out, err } = await run(
          offline,
          'seal',
          'verify',
          await currentSeal(),
          '--offline',
        );
        expect(code).toBe(0);
        expect(out.split('\n')[0]).toBe('valid Agent SEAL');
        expect(err).toBe(
          `offline, using the SealKeeper keys from ${ISSUER_ORIGIN} fetched at ${new Date(NOW).toISOString()}, 0 minutes old\n`,
        );
        expect(requests).toEqual([]);
      });

      it('uses a cache past a day and under the offline limit without fetching', async () => {
        await run(fetchFn, 'seal', 'verify', await currentSeal());
        requests = [];
        now = NOW + KEYS_OFFLINE_MAX_AGE_MS - 60_000;
        const { code, err } = await run(
          fetchFn,
          'seal',
          'verify',
          await currentSealAt(now),
          '--offline',
        );
        expect(code).toBe(0);
        expect(err).toContain('6 days old');
        expect(requests).toEqual([]);
      });

      it('exits 2 with one line when there is no cache', async () => {
        const { code, out, err } = await run(
          fetchFn,
          'seal',
          'verify',
          await currentSeal(),
          '--offline',
        );
        expect(code).toBe(2);
        expect(out).toBe('');
        expect(err.trimEnd().split('\n')).toHaveLength(1);
        expect(err).toContain(
          'there is no usable cached SealKeeper key file, run npx sealkeeper seal verify once without --offline, or pass --keys',
        );
        expect(requests).toEqual([]);
      });

      it('says the same when the cache file does not read', async () => {
        await writeFile(paths().wellKnown, '{"fetchedAt":');
        const { code, err } = await run(
          fetchFn,
          'seal',
          'verify',
          await currentSeal(),
          '--offline',
        );
        expect(code).toBe(2);
        expect(err).toContain(
          'there is no usable cached SealKeeper key file, run npx sealkeeper seal verify once without --offline, or pass --keys',
        );
        expect(requests).toEqual([]);
      });

      it('says the cache lacks the kid when the cache is there without it', async () => {
        await run(fetchFn, 'seal', 'verify', await currentSeal());
        const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
        await writeFile(
          paths().wellKnown,
          JSON.stringify({
            ...cache,
            wellKnown: {
              keys: cache.wellKnown.keys.map((k: object) => ({
                ...k,
                kid: 'another-kid',
              })),
            },
          }),
        );
        requests = [];
        const { code, err } = await run(
          fetchFn,
          'seal',
          'verify',
          await currentSeal(),
          '--offline',
        );
        expect(code).toBe(2);
        expect(err).toContain(
          `the cached keys from ${ISSUER_ORIGIN} do not include kid ${KID}, run npx sealkeeper seal verify once without --offline, or pass --keys`,
        );
        expect(requests).toEqual([]);
      });

      it('exits 2 when the cache is older than the offline limit', async () => {
        await run(fetchFn, 'seal', 'verify', await currentSeal());
        requests = [];
        now = NOW + KEYS_OFFLINE_MAX_AGE_MS + 60_000;
        const { code, err } = await run(
          fetchFn,
          'seal',
          'verify',
          await currentSealAt(now),
          '--offline',
        );
        expect(code).toBe(2);
        expect(err).toContain('is more than 7 days old');
        expect(requests).toEqual([]);
      });

      it('exits 2 when the cache is dated in the future', async () => {
        await run(fetchFn, 'seal', 'verify', await currentSeal());
        const cache = JSON.parse(await readFile(paths().wellKnown, 'utf8'));
        await writeFile(
          paths().wellKnown,
          JSON.stringify({
            ...cache,
            fetchedAt: new Date(NOW + 3600_000).toISOString(),
          }),
        );
        const { code, err } = await run(
          fetchFn,
          'seal',
          'verify',
          await currentSeal(),
          '--offline',
        );
        expect(code).toBe(2);
        expect(err).toContain('is dated in the future');
      });

      it('--keys wins and reads the file', async () => {
        const file = join(home, 'sealkeeper.json');
        await writeFile(file, JSON.stringify(published()));
        const { code } = await run(
          offline,
          'seal',
          'verify',
          await currentSeal(),
          '--offline',
          '--keys',
          file,
        );
        expect(code).toBe(0);
        expect(requests).toEqual([]);
      });
    });

    // The reader fixtures, signed with the fixture key and checked at the
    // pinned clock, one SEAL of each kind and SEALs from before the kind.
    describe('the kind of SEAL', () => {
      const PINNED = '2026-10-01T12:00:00Z';
      const fixture = (path: string) =>
        readFile(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8');
      const KEYS = new URL('../../fixtures/keys.json', import.meta.url)
        .pathname;
      const verifyFixture = async (file: string, ...args: string[]) => {
        stdin = await fixture(`seals/${file}`);
        return run(offline, 'seal', 'verify', '-', '--at', PINNED, ...args);
      };
      const X402_LINES = [
        'x402 valid challenges 55 of 56 checks, 3 endpoints',
        'wallet proven',
        'wallet changes in 30 days 0',
        'price 0 as declared, 0 above declared, 0 below declared, 3 no declared price, 0 changes in 30 days',
        'SealKeeper checked this service without paying. It did not check the paid results.',
      ];

      beforeEach(() => {
        now = Date.parse('2026-10-02T12:00:00Z');
      });

      it('names a Service SEAL on its first line, its level with its kind and its x402 evidence', async () => {
        const { code, out, err } = await verifyFixture(
          'v7-service-valid.txt',
          '--keys',
          KEYS,
        );
        expect(code).toBe(0);
        expect(err).toBe('');
        const lines = out.split('\n');
        expect(lines[0]).toBe('valid Service SEAL at 2026-10-01T12:00:00.000Z');
        expect(lines[1]).toBe('level Bronze Service SEAL');
        expect(lines[2]).toBe('interfaces x402, paid yes');
        expect(lines.some((l) => l.includes('Agent SEAL'))).toBe(false);
        const at = lines.indexOf(X402_LINES[0] as string);
        expect(lines.slice(at, at + X402_LINES.length)).toEqual(X402_LINES);
        expect(lines[at - 1]).toBe('owner unverified');
        expect(requests).toEqual([]);
      });

      it('names an Agent SEAL on its first line and prints no interfaces', async () => {
        const { code, out } = await verifyFixture(
          'v7-valid.txt',
          '--keys',
          KEYS,
        );
        expect(code).toBe(0);
        const lines = out.split('\n');
        expect(lines[0]).toBe('valid Agent SEAL at 2026-10-01T12:00:00.000Z');
        expect(lines[1]).toBe('level Bronze Agent SEAL');
        expect(lines.some((l) => l.startsWith('interfaces '))).toBe(false);
        expect(lines).not.toContain(X402_UNPAID_NOTE);
      });

      it('prints the x402 evidence beside the endpoint checks of a listed agent', async () => {
        const { code, out } = await verifyFixture(
          'v7-listed-x402-valid.txt',
          '--keys',
          KEYS,
        );
        expect(code).toBe(0);
        const lines = out.split('\n');
        expect(lines[0]).toBe('valid Agent SEAL at 2026-10-01T12:00:00.000Z');
        const at = lines.indexOf('endpoint checks 11 of 12 OK');
        expect(lines[at + 1]).toBe(X402_LINES[0]);
        expect(lines).toContain(X402_UNPAID_NOTE);
      });

      it('reads a SEAL from before the kind as an Agent SEAL', async () => {
        for (const file of ['v1-valid.txt', 'v4-valid.txt', 'v6-valid.txt']) {
          const { code, out } = await verifyFixture(file, '--keys', KEYS);
          expect(code, file).toBe(0);
          const lines = out.split('\n');
          expect(lines[0], file).toBe(
            'valid Agent SEAL at 2026-10-01T12:00:00.000Z',
          );
          expect(lines[1], file).toBe('level Bronze Agent SEAL');
        }
      });

      it('names no kind for a broken SEAL, whatever its payload says', async () => {
        stdin = tamper((await fixture('seals/v7-service-valid.txt')).trim());
        const { code, out } = await run(
          offline,
          'seal',
          'verify',
          '-',
          '--at',
          PINNED,
          '--keys',
          KEYS,
        );
        expect(code).toBe(1);
        expect(out.split('\n')[0]).toBe('broken SEAL: bad signature');
        expect(out).not.toContain('Service SEAL');
        expect(out).not.toContain(X402_UNPAID_NOTE);
      });

      it('names the kind the same way with --offline, for both kinds', async () => {
        const keys = JSON.parse(await fixture('keys.json'));
        await cacheKeys(paths(), ISSUER_ORIGIN, keys, now);
        for (const [file, kind] of [
          ['v7-service-valid.txt', 'Service SEAL'],
          ['v7-valid.txt', 'Agent SEAL'],
        ] as const) {
          const { code, out, err } = await verifyFixture(file, '--offline');
          expect(code, file).toBe(0);
          expect(out.split('\n')[0], file).toBe(
            `valid ${kind} at 2026-10-01T12:00:00.000Z`,
          );
          expect(err, file).toContain('offline, using the SealKeeper keys');
        }
        expect(requests).toEqual([]);
      });

      it('--json carries the subject as signed and adds nothing', async () => {
        const { code, out } = await verifyFixture(
          'v7-service-valid.txt',
          '--keys',
          KEYS,
          '--json',
        );
        expect(code).toBe(0);
        const json = JSON.parse(out);
        expect(Object.keys(json)).toEqual([
          'valid',
          'reason',
          'payload',
          'expiresAt',
          'at',
          'lapsed',
        ]);
        expect(json.payload.subject).toEqual({
          kind: 'service',
          interfaces: ['x402'],
          paid: true,
        });
      });

      it('prints a Service SEAL and refuses the handshake beside it, exit 1', async () => {
        const handshake = (await fixture('handshake/handshake.txt')).trim();
        const plain = await verifyFixture(
          'v7-service-valid.txt',
          '--keys',
          KEYS,
          '--handshake',
          handshake,
        );
        expect(plain.code).toBe(1);
        expect(plain.err).toBe('');
        const lines = plain.out.trimEnd().split('\n');
        expect(lines[0]).toBe('valid Service SEAL at 2026-10-01T12:00:00.000Z');
        expect(lines.slice(-1)).toEqual(SERVICE_HANDSHAKE.lines);
        const json = await verifyFixture(
          'v7-service-valid.txt',
          '--keys',
          KEYS,
          '--handshake',
          handshake,
          '--json',
        );
        expect(json.code).toBe(1);
        const answer = JSON.parse(json.out);
        expect(answer.valid).toBe(true);
        expect(answer.handshake).toEqual({ valid: false, reason: 'service' });
        expect(requests).toEqual([]);
      });

      it('reads no record for a handshake beside a Service SEAL online', async () => {
        vi.stubEnv('SEALKEEPER_API_URL', DEFAULT_API_URL);
        const keys = JSON.parse(await fixture('keys.json'));
        published = () => keys;
        stdin = await fixture('seals/v7-service-valid.txt');
        const handshake = (await fixture('handshake/handshake.txt')).trim();
        const { code, out } = await run(
          fetchFn,
          'seal',
          'verify',
          '-',
          '--at',
          PINNED,
          '--handshake',
          handshake,
        );
        expect(code).toBe(1);
        expect(out.trimEnd().split('\n').slice(-1)).toEqual(
          SERVICE_HANDSHAKE.lines,
        );
        expect(requests).toEqual([WELL_KNOWN_URL]);
      });
    });

    async function currentSealAt(atMs: number): Promise<string> {
      const sec = Math.floor(atMs / 1000);
      return sign(
        claims({ iat: sec, exp: sec + 24 * HOUR }),
        serverKey.privateKey,
        KID,
      );
    }
  });

  // The handshake. seal handshake signs the fingerprint sync last
  // wrote, and seal verify --handshake checks it beside the SEAL. The
  // issuer writes version 1, which carries no fingerprint, so the check
  // reads the agent answer from the API and says so.
  describe('handshake', () => {
    // The production API, so a production SEAL's keys and record come from
    // one issuer.
    const AGENT = () => `${DEFAULT_API_URL}/v1/agents/${agentId}`;
    // The fingerprint hash the agent answer holds for the agent, null for
    // none.
    let recordHash: string | null;
    // The routine fingerprint hash the agent answer holds, null for none and
    // undefined for an answer without the field.
    let routineHash: string | null | undefined;
    let withRecord: typeof fetch;
    const answerOf = (hash: string) => ({
      hash,
      at: new Date(NOW - 60_000).toISOString(),
      parts: {
        model_set: 'declared',
        prompt: 'not_declared',
        tools: 'declared',
        framework: 'declared',
      },
    });

    const capture = async (tools: string) => {
      const fp = await recordCapture(
        paths(),
        {
          model_set: await partHash(agentId, 'claude-sonnet-4-5'),
          prompt: 'not_declared',
          tools: await partHash(agentId, tools),
          framework: await partHash(agentId, 'claude-code@2.1.283'),
        },
        NOW_SEC - 60,
      );
      if (fp === null) throw new Error('nothing recorded');
      return fp;
    };

    const handshake = async (...args: string[]) => {
      const r = await run(withRecord, 'seal', 'handshake', ...args);
      expect(r.code).toBe(0);
      return r.out.trim();
    };

    const lastLines = (out: string, n: number) =>
      out.trimEnd().split('\n').slice(-n);

    // A version 3 payload carrying hash as its fingerprint.
    const v3 = (hash: string | null) => {
      const { version: _v, ...rest } = claims();
      return {
        ...rest,
        ver: 3,
        counts: {
          ...rest.counts,
          posted_tasks: 0,
          posted_distinct_operators: 0,
          posted_confirmed_tasks: 0,
        },
        counted: {
          verified_tasks: 17,
          seed_tasks: 17,
          server_checked_tasks: 0,
          confirmed_tasks: 0,
          posted_tasks: 0,
          posted_confirmed_tasks: 0,
        },
        fingerprint: hash === null ? null : { hash, at: NOW_SEC - 3600 },
        state: 'matches',
      };
    };

    const NOTE =
      "compared with the issuer's current record, the SEAL carries no fingerprint until version 3";
    // What a handshake shows, by what the verifier asked for.
    const NO_NONCE =
      'no nonce of yours, so it does not show the presenter holds the key, a copy replays for 24 hours';
    const NONCE_ONLY =
      'it shows key possession to whoever holds your nonce, no more, pass --for with your own name to refuse one relayed from another verifier';
    const FOR_YOU =
      'made for you over your nonce, so the key holder answered you';

    beforeEach(async () => {
      vi.stubEnv('SEALKEEPER_API_URL', DEFAULT_API_URL);
      await writeConfig({
        agentId,
        operatorLogin: 'alice',
        name: 'summariser',
        version: '1.0.0',
        apiUrl: API_URL,
        registeredAt: new Date(NOW).toISOString(),
      });
      recordHash = null;
      routineHash = undefined;
      withRecord = (async (input: string | URL | Request) => {
        if (String(input) === AGENT()) {
          requests.push(String(input));
          return Response.json({
            fingerprint: recordHash === null ? null : answerOf(recordHash),
            ...(routineHash === undefined
              ? {}
              : {
                  routineFingerprint:
                    routineHash === null ? null : answerOf(routineHash),
                }),
          });
        }
        return fetchFn(input);
      }) as typeof fetch;
    });

    it('seal handshake exits 1 with one line when there is no fingerprint', async () => {
      const { code, out, err } = await run(withRecord, 'seal', 'handshake');
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toBe(`${NO_FINGERPRINT}\n`);
    });

    it('seal handshake signs the current fingerprint, with the nonce', async () => {
      const fp = await capture('mcp:github');
      expect(
        await verifyHandshake(await handshake(), agentId, NOW_SEC),
      ).toEqual({
        ok: true,
        payload: {
          sub: agentId,
          fingerprint: fp.hash,
          at: fp.captured_at,
          setup: 'session',
          iat: NOW_SEC,
        },
      });
      const withNonce = await handshake('--nonce', 'check 42');
      expect(
        (await verifyHandshake(withNonce, agentId, NOW_SEC, 'check 42')).ok,
      ).toBe(true);
      const json = JSON.parse(await handshake('--json'));
      expect(json.payload).toMatchObject({
        sub: agentId,
        fingerprint: fp.hash,
      });
      expect((await verifyHandshake(json.handshake, agentId, NOW_SEC)).ok).toBe(
        true,
      );
    });

    it('seal handshake refuses a nonce over 64 characters', async () => {
      await capture('mcp:github');
      const { code, err } = await run(
        withRecord,
        'seal',
        'handshake',
        '--nonce',
        'n'.repeat(65),
      );
      expect(code).toBe(1);
      expect(err).toContain('--nonce must be 1 to 64 printable ASCII');
    });

    it('a version 1 SEAL falls back to the agent answer and says so', async () => {
      recordHash = (await capture('mcp:github')).hash;
      const { code, out, err } = await run(
        withRecord,
        'seal',
        'verify',
        await currentSeal(),
        '--handshake',
        await handshake(),
      );
      expect(err).toBe('');
      // Matches, but with no nonce of the verifier's it shows nothing about
      // who presents it, so the exit is 4, not 0.
      expect(code).toBe(4);
      expect(lastLines(out, 4)).toEqual([
        'Expires in 24 hours 0 minutes',
        'handshake Matches, session setup',
        NOTE,
        NO_NONCE,
      ]);
      expect(requests).toContain(AGENT());
    });

    it('reads Changed when the tools changed since the record', async () => {
      recordHash = (await capture('mcp:github')).hash;
      await capture('mcp:github\nmcp:linear');
      const { code, out } = await run(
        withRecord,
        'seal',
        'verify',
        await currentSeal(),
        '--handshake',
        await handshake(),
      );
      expect(code).toBe(3);
      expect(lastLines(out, 3)).toEqual([
        'handshake Changed, session setup',
        NOTE,
        NO_NONCE,
      ]);
    });

    it('compares a version 3 SEAL with its own fingerprint, without the API', async () => {
      const fp = await capture('mcp:github');
      const hs = await handshake();
      const verifyWith = async (hash: string | null) =>
        run(
          withRecord,
          'seal',
          'verify',
          await sign(v3(hash), serverKey.privateKey, KID),
          '--handshake',
          hs,
        );
      const matched = await verifyWith(fp.hash);
      expect(matched.code).toBe(4);
      expect(lastLines(matched.out, 2)).toEqual([
        'handshake Matches, session setup',
        NO_NONCE,
      ]);
      const changed = await verifyWith(
        'BHAfx6dALmCdt3aXz-g6iAjLLGDurK95DZm15ZjIVZg',
      );
      expect(changed.code).toBe(3);
      expect(lastLines(changed.out, 2)).toEqual([
        'handshake Changed, session setup',
        NO_NONCE,
      ]);
      const none = await verifyWith(null);
      expect(none.code).toBe(3);
      expect(lastLines(none.out, 2)).toEqual([
        'handshake valid, session setup, no fingerprint on record to compare with',
        NO_NONCE,
      ]);
      expect(requests).not.toContain(AGENT());
    });

    // A routine handshake is compared with the routine's fingerprint only,
    // from the record while the SEAL carries none of the routine's, and a
    // session handshake never with the routine's.
    describe('the routine setup', () => {
      const ROUTINE_NOTE = HANDSHAKE_ROUTINE_RECORD_NOTE;
      const captureRoutine = async (tools: string) => {
        const fp = await recordCapture(
          paths(),
          {
            model_set: await partHash(agentId, 'claude-opus-5'),
            prompt: 'not_declared',
            tools: await partHash(agentId, tools),
            framework: await partHash(agentId, 'claude-code@2.1.300'),
          },
          NOW_SEC - 30,
          'claude-code-routine',
        );
        if (fp === null) throw new Error('nothing recorded');
        return fp;
      };
      const routineHandshake = async () => {
        const jws = await makeHandshake(
          NOW,
          { routine: 'claude-code-routine' },
          paths(),
        );
        if (jws === null) throw new Error('no routine handshake');
        return jws;
      };

      it('signs the routine fingerprint with the routine setup', async () => {
        const fp = await captureRoutine('');
        expect(
          await verifyHandshake(await routineHandshake(), agentId, NOW_SEC),
        ).toEqual({
          ok: true,
          payload: {
            sub: agentId,
            fingerprint: fp.hash,
            at: fp.captured_at,
            setup: 'routine',
            iat: NOW_SEC,
          },
        });
      });

      it("reads the record's routine fingerprint beside a version 3 SEAL, and the session handshake still Matches", async () => {
        const session = await capture('mcp:github');
        const routine = await captureRoutine('');
        routineHash = routine.hash;
        const seal = await sign(v3(session.hash), serverKey.privateKey, KID);
        const verified = await run(
          withRecord,
          'seal',
          'verify',
          seal,
          '--handshake',
          await routineHandshake(),
          '--json',
        );
        expect(verified.code).toBe(4);
        expect(JSON.parse(verified.out).handshake).toEqual({
          valid: true,
          result: 'matches',
          against: 'record',
          proof: 'none',
          setup: 'routine',
        });
        expect(requests).toContain(AGENT());

        const lines = await run(
          withRecord,
          'seal',
          'verify',
          seal,
          '--handshake',
          await routineHandshake(),
        );
        expect(lastLines(lines.out, 3)).toEqual([
          'handshake Matches, routine setup',
          ROUTINE_NOTE,
          NO_NONCE,
        ]);

        // The routine moved on the record. The session handshake is
        // compared with the session fingerprint alone.
        routineHash = 'BHAfx6dALmCdt3aXz-g6iAjLLGDurK95DZm15ZjIVZg';
        const sessionCheck = await run(
          withRecord,
          'seal',
          'verify',
          seal,
          '--handshake',
          await handshake(),
        );
        expect(sessionCheck.code).toBe(4);
        expect(lastLines(sessionCheck.out, 2)).toEqual([
          'handshake Matches, session setup',
          NO_NONCE,
        ]);
        const routineCheck = await run(
          withRecord,
          'seal',
          'verify',
          seal,
          '--handshake',
          await routineHandshake(),
        );
        expect(routineCheck.code).toBe(3);
        expect(lastLines(routineCheck.out, 3)[0]).toBe(
          'handshake Changed, routine setup',
        );
      });

      it('reads an answer without routineFingerprint as no routine fingerprint', async () => {
        const session = await capture('mcp:github');
        await captureRoutine('');
        recordHash = session.hash;
        const { code, out } = await run(
          withRecord,
          'seal',
          'verify',
          await sign(v3(session.hash), serverKey.privateKey, KID),
          '--handshake',
          await routineHandshake(),
        );
        expect(code).toBe(3);
        expect(lastLines(out, 3)).toEqual([
          'handshake valid, routine setup, no fingerprint on record to compare with',
          ROUTINE_NOTE,
          NO_NONCE,
        ]);
      });

      it('says the SEAL carries no routine fingerprint until version 6 when --offline fetches no record', async () => {
        const session = await capture('mcp:github');
        await captureRoutine('');
        const seal = await sign(v3(session.hash), serverKey.privateKey, KID);
        expect((await run(withRecord, 'seal', 'verify', seal)).code).toBe(0);
        requests = [];
        const { code, err } = await run(
          withRecord,
          'seal',
          'verify',
          seal,
          '--offline',
          '--handshake',
          await routineHandshake(),
        );
        expect(code).toBe(2);
        expect(err).toContain(
          'the SEAL carries no routine fingerprint until version 6, and --keys and --offline fetch no record to compare with',
        );
        expect(requests).toEqual([]);
      });
    });

    it('refuses a handshake signed by another key', async () => {
      const fp = await capture('mcp:github');
      recordHash = fp.hash;
      const other = await generateKeypair();
      const forged = await signHandshake(
        other.privateKey,
        agentId,
        fp,
        NOW_SEC,
      );
      const { code, out } = await run(
        withRecord,
        'seal',
        'verify',
        await currentSeal(),
        '--handshake',
        forged,
      );
      expect(code).toBe(1);
      expect(lastLines(out, 1)).toEqual(['handshake refused: bad signature']);
      expect(requests).not.toContain(AGENT());
    });

    it('refuses a wrong nonce', async () => {
      recordHash = (await capture('mcp:github')).hash;
      const hs = await handshake('--nonce', 'check-1');
      stdin = await currentSeal();
      const verifyWith = (nonce: string) =>
        run(
          withRecord,
          'seal',
          'verify',
          '--handshake',
          hs,
          '--nonce',
          nonce,
          '--json',
          '-',
        );
      const right = await verifyWith('check-1');
      expect(right.code).toBe(0);
      expect(JSON.parse(right.out).handshake).toEqual({
        valid: true,
        result: 'matches',
        against: 'record',
        proof: 'nonce',
        setup: 'session',
      });
      const wrong = await verifyWith('check-2');
      expect(wrong.code).toBe(1);
      expect(JSON.parse(wrong.out)).toMatchObject({
        valid: true,
        handshake: { valid: false, reason: 'nonce_mismatch' },
      });
    });

    // --at moves the SEAL's clock only. A handshake is a live
    // proof of who presents the SEAL, so it is checked against the real
    // clock whatever --at names.
    it('checks a handshake beside --at against the real clock, not --at', async () => {
      recordHash = (await capture('mcp:github')).hash;
      const key = await loadKey();
      if (key === null) throw new Error('no key');
      const signedAt = (iat: number) =>
        signHandshake(
          key.privateKey,
          agentId,
          { hash: recordHash ?? '', captured_at: NOW_SEC - 2 * HOUR },
          iat,
          'check-1',
        );
      const seal = await sign(
        claims({ iat: NOW_SEC - 2 * HOUR, exp: NOW_SEC + 22 * HOUR }),
        serverKey.privateKey,
        KID,
      );
      const at = new Date((NOW_SEC - HOUR) * 1000).toISOString();
      const verifyWith = async (hs: string) =>
        run(
          withRecord,
          'seal',
          'verify',
          seal,
          '--at',
          at,
          '--handshake',
          hs,
          '--nonce',
          'check-1',
          '--json',
        );
      // Signed now, so live by the real clock, an hour off --at.
      const live = await verifyWith(await signedAt(NOW_SEC));
      expect(live.code).toBe(0);
      expect(JSON.parse(live.out)).toMatchObject({
        valid: true,
        at,
        lapsed: false,
        handshake: {
          valid: true,
          result: 'matches',
          against: 'record',
          proof: 'nonce',
          setup: 'session',
        },
      });
      // Signed at --at, so stale by the real clock.
      const then = await verifyWith(await signedAt(NOW_SEC - HOUR));
      expect(then.code).toBe(1);
      expect(JSON.parse(then.out)).toMatchObject({
        valid: true,
        at,
        handshake: { valid: false, reason: 'stale' },
      });
    });

    it('takes a card copy 6 hours old and refuses one 25 hours old or a nonce 6 minutes old', async () => {
      const fp = await capture('mcp:github');
      recordHash = fp.hash;
      const key = await loadKey();
      if (key === null) throw new Error('no key');
      const signedAgo = (seconds: number, nonce?: string) =>
        signHandshake(
          key.privateKey,
          agentId,
          { hash: fp.hash, captured_at: NOW_SEC - seconds - 600 },
          NOW_SEC - seconds,
          nonce,
        );
      const verifyWith = async (hs: string, ...more: string[]) =>
        run(
          withRecord,
          'seal',
          'verify',
          await currentSeal(),
          '--handshake',
          hs,
          ...more,
        );
      const card = await verifyWith(await signedAgo(6 * HOUR));
      expect(card.code).toBe(4);
      expect(lastLines(card.out, 3)).toEqual([
        'handshake Matches, session setup',
        NOTE,
        NO_NONCE,
      ]);
      const old = await verifyWith(await signedAgo(25 * HOUR));
      expect(old.code).toBe(1);
      expect(lastLines(old.out, 1)).toEqual([
        'handshake refused: signed outside its window, 5 minutes with a nonce and 24 hours without',
      ]);
      // A live challenge, the nonce, gets 5 minutes.
      const hs = await handshake('--nonce', 'check-1');
      now = NOW + 301_000;
      const late = await verifyWith(hs, '--nonce', 'check-1');
      expect(late.code).toBe(1);
      expect(lastLines(late.out, 1)).toEqual([
        'handshake refused: signed outside its window, 5 minutes with a nonce and 24 hours without',
      ]);
    });

    it('does not check a handshake beside a broken SEAL', async () => {
      await capture('mcp:github');
      const { code, out } = await run(
        withRecord,
        'seal',
        'verify',
        tamper(await currentSeal()),
        '--handshake',
        await handshake(),
      );
      expect(code).toBe(1);
      expect(out).not.toContain('handshake');
    });

    it('with --offline a version 1 SEAL has no record to compare with and exits 2', async () => {
      recordHash = (await capture('mcp:github')).hash;
      const seal = await currentSeal();
      expect((await run(withRecord, 'seal', 'verify', seal)).code).toBe(0);
      requests = [];
      const { code, err } = await run(
        withRecord,
        'seal',
        'verify',
        seal,
        '--offline',
        '--handshake',
        await handshake(),
      );
      expect(code).toBe(2);
      expect(err).toContain('the SEAL carries no fingerprint until version 3');
      expect(requests).toEqual([]);
    });

    // The record comes from the API paired with where the keys came from,
    // never from another issuer's API.
    it('never reads the record from a local API for a production SEAL, whose keys came from the issuer', async () => {
      vi.stubEnv('SEALKEEPER_API_URL', API_URL);
      recordHash = (await capture('mcp:github')).hash;
      const { code, err } = await run(
        withRecord,
        'seal',
        'verify',
        await currentSeal(),
        '--handshake',
        await handshake(),
      );
      expect(code).toBe(2);
      expect(err).toContain(
        `its keys came from ${ISSUER_ORIGIN}, not the API this CLI points at, ${API_URL}`,
      );
      expect(requests).toEqual([WELL_KNOWN_URL]);
      expect(recordApiUrl(API_URL, 'sealkeeper.run')).toBeNull();
      expect(recordApiUrl(API_URL, 'other.test')).toBe(API_URL);
    });

    it('refuses a relayed handshake made for another verifier when --for names this one', async () => {
      recordHash = (await capture('mcp:github')).hash;
      // M passed V's nonce to the agent and asked for a handshake made for
      // M, then relays it to V.
      const forM = await handshake('--nonce', 'check-1', '--for', 'm.example');
      const payload = JSON.parse(
        Buffer.from(forM.split('.')[1] ?? '', 'base64url').toString(),
      );
      expect(payload).toMatchObject({ nonce: 'check-1', aud: 'm.example' });
      const verifyAs = (hs: string, ...more: string[]) =>
        run(
          withRecord,
          'seal',
          'verify',
          stdin,
          '--handshake',
          hs,
          '--nonce',
          'check-1',
          ...more,
        );
      stdin = await currentSeal();
      const relayed = await verifyAs(forM, '--for', 'v.example');
      expect(relayed.code).toBe(1);
      expect(lastLines(relayed.out, 1)).toEqual([
        'handshake refused: made for another verifier',
      ]);
      // Without --for the verifier is told what the nonce alone shows.
      const loose = await verifyAs(forM);
      expect(loose.code).toBe(0);
      expect(lastLines(loose.out, 3)).toEqual([
        'handshake Matches, session setup',
        NOTE,
        NONCE_ONLY,
      ]);
      const forV = await handshake('--nonce', 'check-1', '--for', 'v.example');
      const bound = await verifyAs(forV, '--for', 'v.example');
      expect(bound.code).toBe(0);
      expect(lastLines(bound.out, 1)).toEqual([FOR_YOU]);
    });

    it('--for needs --handshake and both sides check its length', async () => {
      await capture('mcp:github');
      const alone = await run(
        withRecord,
        'seal',
        'verify',
        await currentSeal(),
        '--for',
        'v.example',
      );
      expect(alone.code).toBe(1);
      expect(alone.err).toContain('--for needs --handshake');
      const long = await run(
        withRecord,
        'seal',
        'handshake',
        '--for',
        'v'.repeat(65),
      );
      expect(long.code).toBe(1);
      expect(long.err).toContain('--for must be 1 to 64 printable ASCII');
    });

    it('reads the record of a production SEAL from the production API, never the issuer domain', async () => {
      vi.stubEnv('SEALKEEPER_API_URL', DEFAULT_API_URL);
      const fp = await capture('mcp:github');
      const productionAgent = `${DEFAULT_API_URL}/v1/agents/${agentId}`;
      const production = (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url === WELL_KNOWN_URL) return Response.json(published());
        if (url === productionAgent) {
          return Response.json({
            fingerprint: {
              hash: fp.hash,
              at: new Date(NOW - 60_000).toISOString(),
              parts: {
                model_set: 'declared',
                prompt: 'not_declared',
                tools: 'declared',
                framework: 'declared',
              },
            },
          });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;
      const hs = (await run(production, 'seal', 'handshake')).out.trim();
      const { code, out } = await run(
        production,
        'seal',
        'verify',
        await currentSeal(),
        '--handshake',
        hs,
      );
      expect(code).toBe(4);
      expect(lastLines(out, 3)).toEqual([
        'handshake Matches, session setup',
        NOTE,
        NO_NONCE,
      ]);
      expect(requests).toEqual([WELL_KNOWN_URL, productionAgent]);
      expect(recordApiUrl(DEFAULT_API_URL, 'sealkeeper.run')).toBe(
        DEFAULT_API_URL,
      );
    });

    it('--nonce needs --handshake', async () => {
      const { code, err } = await run(
        withRecord,
        'seal',
        'verify',
        await currentSeal(),
        '--nonce',
        'check-1',
      );
      expect(code).toBe(1);
      expect(err).toContain('--nonce needs --handshake');
    });
  });
});
