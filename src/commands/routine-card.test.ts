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
  AgentCard,
  base64urlEncode,
  type VerifiedCredentialPayload as CredentialPayload,
  generateKeypair,
  sign,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultRoutineConfig,
  paths,
  type RoutineLimits,
  writeConfig,
  writeRoutineConfig,
} from '../config.js';
import { createKey } from '../identity.js';
import { resetInvocation } from '../invocation.js';
import { createProgram } from '../program.js';
import {
  appendRoutine,
  budgetOf,
  type RoutineEntry,
  readRoutine,
} from '../routine.js';

// The daily routine refreshes the card card write last wrote (VOU-383).

const API_URL = 'https://api.test';
const KID = 'sealkeeper-test-1';
const HOUR = 3600;
// A fixed clock, so no test depends on the time it runs.
const NOW = new Date('2026-09-29T10:00:00.000Z');

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const unreachable = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

describe('the routine refreshes the card', () => {
  let root: string;
  let cardFile: string;
  let agentId: string;
  let serverKey: Awaited<ReturnType<typeof generateKeypair>>;
  // What GET /v1/agents/:id/seal answers, a SEAL or a withheld 404.
  let seal: () => Promise<Response>;
  let requests: string[];
  let fetchFn: typeof fetch;

  // A SEAL of 24 hours that has expSec left now.
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

  const issues = (expSec: number) => async () => {
    const credential = await credentialFor(expSec);
    const body = credential.split('.')[1] ?? '';
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return Response.json({ credential, payload });
  };

  const withheld = async () =>
    Response.json(
      {
        error: { code: 'withheld', message: 'withheld for cause' },
        id: agentId,
        reason: 'fraud',
      },
      { status: 404 },
    );

  async function run(
    fetcher: typeof fetch,
    ...args: string[]
  ): Promise<RunResult> {
    const program = createProgram({
      card: { fetch: fetcher },
      routine: { fetch: fetcher, stdoutTTY: () => false },
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
    const exitCode = process.exitCode;
    try {
      await program.parseAsync(args, { from: 'user' });
      const code = process.exitCode ?? 0;
      return { code: typeof code === 'number' ? code : Number(code), out, err };
    } catch (error) {
      if (error instanceof CommanderError) {
        return { code: error.exitCode, out, err };
      }
      throw error;
    } finally {
      process.exitCode = exitCode;
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  // Installed with every daily limit at 0 unless limits says otherwise, so
  // a run stops before it reads any work and only the card is left to see.
  async function installed(limits: Partial<RoutineLimits> = {}) {
    await writeRoutineConfig({
      ...defaultRoutineConfig(),
      limits: {
        ...defaultRoutineConfig().limits,
        claimsPerDay: 0,
        confirmsPerDay: 0,
        postsPerDay: 0,
        ...limits,
      },
      schedule: {
        time: '10:00',
        scheduler: 'cron',
        agent: 'claude-code',
        agentCommand: '/usr/local/bin/claude',
        job: 'run.sealkeeper.routine',
        files: [],
        installedAt: NOW.toISOString(),
      },
    });
  }

  // The requests of the run but the game status read every run makes
  // before it decides whether to start the agent (GAME-14), so what is
  // left is what the card refresh read.
  const cardRequests = () =>
    requests.filter((url) => url !== `${API_URL}/v1/game/status`);

  async function lastRun(): Promise<Extract<RoutineEntry, { kind: 'run' }>> {
    const run = (await readRoutine())
      .filter(
        (e): e is Extract<RoutineEntry, { kind: 'run' }> => e.kind === 'run',
      )
      .at(-1);
    if (run === undefined) throw new Error('no run line');
    return run;
  }

  const sealOf = (text: string) =>
    AgentCard.parse(JSON.parse(text)).capabilities.extensions[0]?.params
      .credential;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-routine-card-'));
    vi.stubEnv('SEALKEEPER_HOME', join(root, 'sk'));
    vi.stubEnv('SEALKEEPER_API_URL', '');
    vi.stubEnv('SEALKEEPER_ROUTINE_RUN', '');
    vi.stubEnv('SEALKEEPER_ROUTINE_RUN_ID', '');
    vi.stubEnv('SEALKEEPER_INVOCATION', 'sealkeeper');
    resetInvocation();
    await mkdir(join(root, 'site'));
    cardFile = join(root, 'site', 'agent-card.json');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: NOW.toISOString(),
    });
    serverKey = await generateKeypair();
    seal = issues(24 * HOUR);
    requests = [];
    fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === `${API_URL}/.well-known/seal.json`) {
        return Response.json({
          keys: [
            {
              kid: KID,
              kty: 'OKP',
              crv: 'Ed25519',
              alg: 'EdDSA',
              x: base64urlEncode(serverKey.publicKey),
            },
          ],
        });
      }
      if (url === `${API_URL}/v1/agents/${agentId}/seal`) return seal();
      return Response.json(
        { error: { code: 'not_found', message: 'not found' } },
        { status: 404 },
      );
    }) as typeof fetch;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetInvocation();
    await rm(root, { recursive: true, force: true });
  });

  async function writeCard(): Promise<string> {
    const written = await run(
      fetchFn,
      'card',
      'write',
      '--out',
      cardFile,
      '--url',
      'https://agent.example.com/a2a',
    );
    expect(written.code).toBe(0);
    return readFile(cardFile, 'utf8');
  }

  it('rewrites a card whose SEAL is inside the margin with a fresh SEAL, and routine status says when', async () => {
    seal = issues(HOUR);
    const before = await writeCard();
    await installed();
    seal = issues(24 * HOUR);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));

    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    const after = await readFile(cardFile, 'utf8');
    expect(sealOf(after)).not.toBe(sealOf(before));
    const cached = JSON.parse(await readFile(paths().credential, 'utf8'));
    expect(sealOf(after)).toBe(cached.seal);
    // The same card, with the --url card write took.
    expect(AgentCard.parse(JSON.parse(after)).url).toBe(
      'https://agent.example.com/a2a',
    );
    expect((await stat(cardFile)).mode & 0o777).toBe(0o644);
    expect(await lastRun()).toMatchObject({
      outcome: 'stopped',
      card: 'refreshed',
    });
    expect(result.out).toBe(
      'Routine run stopped. The daily limits are spent. Card refreshed.\n',
    );

    const status = await run(fetchFn, 'routine', 'status');
    expect(status.out).toContain(
      `Card      ${cardFile}, last written 2026-09-29T10:01:00.000Z\n`,
    );
    const json = await run(fetchFn, 'routine', 'status', '--json');
    expect(JSON.parse(json.out).card).toEqual({
      path: cardFile,
      writtenAt: '2026-09-29T10:01:00.000Z',
    });
  });

  it('leaves a card whose SEAL is fresh alone, byte for byte', async () => {
    const before = await writeCard();
    await installed();
    requests = [];
    vi.setSystemTime(new Date(NOW.getTime() + HOUR * 1000));

    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(await readFile(cardFile, 'utf8')).toBe(before);
    expect(requests).not.toContain(`${API_URL}/v1/agents/${agentId}/seal`);
    expect(await lastRun()).toMatchObject({ card: 'current' });
    expect(result.out).toContain('Card up to date.');
    // The record keeps the time card write wrote it.
    const status = await run(fetchFn, 'routine', 'status');
    expect(status.out).toContain(`, last written ${NOW.toISOString()}\n`);
  });

  it('writes nothing when card write never wrote a card', async () => {
    await installed();
    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(cardRequests()).toEqual([]);
    await expect(stat(cardFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths().cardWrite)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await lastRun()).not.toHaveProperty('card');
    expect(result.out).not.toContain('Card');
    const status = await run(fetchFn, 'routine', 'status');
    expect(status.out).not.toContain('Card');
  });

  it("never writes over a card another agent's card write recorded", async () => {
    const before = await writeCard();
    await installed();
    // init --force made a new agent in this home.
    ({ agentId } = await createKey({ force: true }));
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: NOW.toISOString(),
    });
    vi.setSystemTime(new Date(NOW.getTime() + 23 * HOUR * 1000));
    requests = [];

    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(await readFile(cardFile, 'utf8')).toBe(before);
    expect(cardRequests()).toEqual([]);
    expect(await lastRun()).not.toHaveProperty('card');
  });

  it("never writes over the card another agent's card write put at the same path", async () => {
    seal = issues(HOUR);
    await writeCard();
    await installed();
    const agentA = agentId;
    // A second agent in its own home writes its card to the same file.
    vi.stubEnv('SEALKEEPER_HOME', join(root, 'sk', 'agents', 'b'));
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'scout-b',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: NOW.toISOString(),
    });
    seal = issues(24 * HOUR);
    const cardB = await writeCard();
    // Back to the first agent, whose SEAL is inside the margin.
    vi.stubEnv('SEALKEEPER_HOME', join(root, 'sk'));
    agentId = agentA;
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));

    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(await readFile(cardFile, 'utf8')).toBe(cardB);
    expect(await lastRun()).toMatchObject({
      outcome: 'stopped',
      card: 'changed',
    });
    expect(result.out).toBe(
      'Routine run stopped. The daily limits are spent. Card not refreshed, the file holds another card.\n',
    );
  });

  it('never writes over a card the operator edited after card write', async () => {
    seal = issues(HOUR);
    const before = await writeCard();
    await installed();
    const edited = before.replace('"scout"', '"scout, edited"');
    expect(edited).not.toBe(before);
    await writeFile(cardFile, edited);
    seal = issues(24 * HOUR);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    requests = [];

    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(await readFile(cardFile, 'utf8')).toBe(edited);
    expect(cardRequests()).toEqual([]);
    expect(await lastRun()).toMatchObject({ card: 'changed' });
  });

  it('goes on and leaves the card as it was when the API does not answer', async () => {
    seal = issues(HOUR);
    const before = await writeCard();
    await installed();
    // The cached SEAL has expired, so there is nothing newer to write.
    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR * 1000));

    const result = await run(unreachable, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(await readFile(cardFile, 'utf8')).toBe(before);
    expect(await lastRun()).toMatchObject({
      outcome: 'stopped',
      reason: 'the daily limits are spent',
      card: 'offline',
    });
    expect(result.out).toBe(
      'Routine run stopped. The daily limits are spent. Card kept, the API could not be reached.\n',
    );
  });

  it('goes on when the SEAL is withheld, and the card holds what card write leaves', async () => {
    seal = issues(HOUR);
    const before = await writeCard();
    await installed();
    seal = withheld;
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));

    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(await lastRun()).toMatchObject({
      outcome: 'stopped',
      card: 'withheld',
    });
    expect(result.out).toContain(
      'Card kept, no SEAL is issued for this agent now.',
    );
    const kept = await readFile(cardFile, 'utf8');
    expect(kept).toBe(before);

    // card write in the same state writes nothing and exits 1, so the card
    // holds the same.
    const written = await run(fetchFn, 'card', 'write', '--out', cardFile);
    expect(written.code).toBe(1);
    expect(await readFile(cardFile, 'utf8')).toBe(kept);
  });

  it('counts against no daily limit', async () => {
    seal = issues(HOUR);
    await writeCard();
    await installed({ claimsPerDay: 1 });
    await appendRoutine({ kind: 'claim', runId: 'earlier', taskId: 't1' });
    seal = issues(24 * HOUR);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const routine = {
      ...defaultRoutineConfig(),
      limits: {
        ...defaultRoutineConfig().limits,
        claimsPerDay: 1,
        confirmsPerDay: 0,
        postsPerDay: 0,
      },
    };
    const used = async () => {
      const entries = await readRoutine();
      return (['claim', 'confirm', 'post'] as const).map(
        (kind) => budgetOf(entries, kind, routine).used,
      );
    };
    expect(await used()).toEqual([1, 0, 0]);

    const result = await run(fetchFn, 'routine', 'run');
    expect(result.code).toBe(0);
    expect(await lastRun()).toMatchObject({
      outcome: 'stopped',
      card: 'refreshed',
      claimed: 0,
      submitted: 0,
      confirmed: 0,
      posted: 0,
    });
    expect(await used()).toEqual([1, 0, 0]);
    // Only the limit lines of the spent limits, each with the use before
    // the run.
    const lines = (await readRoutine()).map((e) =>
      e.kind === 'limit' ? `${e.limit} ${e.used}` : e.kind,
    );
    expect(lines).toEqual([
      'claim',
      'claimsPerDay 1',
      'confirmsPerDay 0',
      'postsPerDay 0',
      'run',
    ]);
  });
});
