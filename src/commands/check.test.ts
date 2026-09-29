// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SealCheckResponse } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createProgram } from '../program.js';
import { type SealFixture, sealFixture } from '../test-seal.js';

const ID = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const JWS = 'eyJh.eyJi.c2ln';

// What the API sends today, the SEAL as seal and as credential.
const failing: SealCheckResponse = {
  ok: false,
  id: ID,
  handle: 'alice/claude-code',
  checks: [
    { name: 'minVerified', required: 1, actual: 0, ok: false },
    { name: 'maxIncidents', required: 0, actual: 0, ok: true },
    { name: 'minReliability', required: 0.8, actual: null, ok: false },
  ],
  credential: JWS,
  seal: JWS,
};

const passing: SealCheckResponse = {
  ok: true,
  id: ID,
  handle: 'alice/claude-code',
  checks: [
    { name: 'minVerified', required: 0, actual: 0, ok: true },
    { name: 'maxIncidents', required: 0, actual: 0, ok: true },
  ],
  credential: JWS,
  seal: JWS,
};

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('sealkeeper check', () => {
  let home: string;
  let urls: string[];
  let reply: (url: string) => Response | Promise<Response>;
  let fixture: SealFixture;

  // A passing answer must carry a SEAL that verifies, so it is signed with
  // a key the fake API publishes. A failing one is never verified.
  beforeAll(async () => {
    fixture = await sealFixture();
    passing.seal = passing.credential = await fixture.seal(ID);
  });

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram();
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
      return { code: Number(process.exitCode ?? 0), out, err };
    } catch (e) {
      if (e instanceof CommanderError) return { code: e.exitCode, out, err };
      throw e;
    } finally {
      process.exitCode = undefined;
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  beforeEach(async () => {
    // No config and no key here. check needs neither.
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-check-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', 'https://api.test');
    urls = [];
    reply = () => Response.json(passing);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const keys = fixture.keysFor(String(input));
        if (keys) return keys;
        urls.push(String(input));
        expect(init?.method ?? 'GET').toBe('GET');
        expect(init?.body).toBeUndefined();
        return reply(String(input));
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('prints each check and PASS, exit 0', async () => {
    const r = await run('check', 'alice/claude-code', '--min-verified', '0');
    expect(r).toEqual({
      code: 0,
      out: [
        'ok   verified tasks 0, need at least 0',
        'ok   incidents 0, allow at most 0',
        'PASS alice/claude-code',
        '',
      ].join('\n'),
      err: '',
    });
    expect(urls).toEqual([
      'https://api.test/v1/check/alice/claude-code?minVerified=0',
    ]);
  });

  it('prints FAIL lines and exits 1 when a check fails', async () => {
    reply = () => Response.json(failing);
    const r = await run(
      'check',
      'alice/claude-code',
      '--min-reliability',
      '0.8',
      '--max-incidents',
      '0',
    );
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      [
        'FAIL verified tasks 0, need at least 1',
        'ok   incidents 0, allow at most 0',
        'FAIL reliability none yet, need at least 0.8',
        'FAIL alice/claude-code',
        '',
      ].join('\n'),
    );
    expect(urls).toEqual([
      'https://api.test/v1/check/alice/claude-code?maxIncidents=0&minReliability=0.8',
    ]);
  });

  const withheld: SealCheckResponse = {
    ok: false,
    id: ID,
    handle: 'alice/claude-code',
    checks: [
      { name: 'seal', required: 'present', actual: 'withheld', ok: false },
      { name: 'minVerified', required: 1, actual: 30, ok: true },
      { name: 'maxIncidents', required: 0, actual: 0, ok: true },
      { name: 'minLevel', required: 'bronze', actual: 'none', ok: false },
    ],
    credential: null,
    seal: null,
  };
  const SEAL_URL = 'https://api.test/v1/agents/alice/claude-code/seal';
  // The check answer, and the SEAL route by handle answering sealAnswer.
  const withheldReply =
    (sealAnswer: () => Response) =>
    (url: string): Response =>
      url === SEAL_URL ? sealAnswer() : Response.json(withheld);
  const noSeal = (dormantDays: number | null) =>
    Response.json(
      {
        error: { code: 'no_seal', message: 'This agent has been dormant.' },
        id: ID,
        dormant_days: dormantDays,
      },
      { status: 404 },
    );
  const held = (reason: unknown) =>
    Response.json(
      {
        error: { code: 'withheld', message: 'withheld for cause' },
        id: ID,
        reason,
      },
      { status: 404 },
    );
  const withheldLines = (sealLine: string) =>
    [
      sealLine,
      'ok   verified tasks 30, need at least 1',
      'ok   incidents 0, allow at most 0',
      'FAIL level none, need at least bronze',
      'FAIL alice/claude-code',
      '',
    ].join('\n');

  it('prints the dormant days and exits 1 when the SEAL is withheld while dormant', async () => {
    reply = withheldReply(() => noSeal(95));
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      withheldLines(
        'FAIL no SEAL, withheld while the agent is dormant, 95 days, need a current SEAL',
      ),
    );
    expect(urls).toEqual([
      'https://api.test/v1/check/alice/claude-code',
      SEAL_URL,
    ]);
  });

  it('prints the hold reason class when the SEAL is withheld for cause', async () => {
    reply = withheldReply(() => held('fraud'));
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(1);
    expect(r.out).toBe(
      withheldLines(
        'FAIL no SEAL, withheld for cause, reason fraud, need a current SEAL',
      ),
    );
  });

  it('prints a reason class this version does not know as it is', async () => {
    reply = withheldReply(() => held('spam_ring'));
    const r = await run('check', 'alice/claude-code');
    expect(r.out.split('\n')[0]).toBe(
      'FAIL no SEAL, withheld for cause, reason spam_ring, need a current SEAL',
    );
  });

  it('says withheld alone when the reason cannot be read', async () => {
    for (const answer of [
      () => held('not a class\u001b[31m'),
      () => noSeal(null),
      () =>
        Response.json({ error: { code: 'x', message: 'x' } }, { status: 500 }),
      () => Response.json(withheld),
    ]) {
      reply = withheldReply(answer);
      const r = await run('check', 'alice/claude-code');
      expect(r.code).toBe(1);
      expect(r.out.split('\n')[0]).toMatch(
        /^FAIL no SEAL, withheld( for cause| while the agent is dormant)?, need a current SEAL$/,
      );
    }
    reply = withheldReply(() => {
      throw new TypeError('fetch failed');
    });
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(1);
    expect(r.out.split('\n')[0]).toBe(
      'FAIL no SEAL, withheld, need a current SEAL',
    );
  });

  it('prints the answer as it came with --json, with no SEAL request', async () => {
    reply = withheldReply(() => held('fraud'));
    const json = await run('check', 'alice/claude-code', '--json');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: false,
      seal: null,
      credential: null,
    });
    expect(urls).toEqual(['https://api.test/v1/check/alice/claude-code']);
  });

  it('refuses an answer with no SEAL and no withheld check', async () => {
    reply = () => Response.json({ ...passing, seal: null, credential: null });
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(2);
    expect(r.err).toContain('unexpected response');
  });

  it('leaves the bronze default to the API, and --min-level none asks for no level', async () => {
    await run('check', 'alice/claude-code');
    await run('check', 'alice/claude-code', '--min-level', 'none');
    expect(urls).toEqual([
      'https://api.test/v1/check/alice/claude-code',
      'https://api.test/v1/check/alice/claude-code?minLevel=none',
    ]);
    const help = createProgram()
      .commands.find((c) => c.name() === 'check')
      ?.helpInformation();
    expect(help?.replace(/\s+/g, ' ')).toContain('default bronze');
  });

  // VOU-436. Safety is not measured, so the API answers minSafety with a
  // null actual for every agent, and the SEAL it carries has no safety key.
  it('prints a minSafety check with no safety score as none yet, exit 1', async () => {
    reply = () =>
      Response.json({
        ...failing,
        checks: [
          { name: 'minVerified', required: 1, actual: 7, ok: true },
          { name: 'maxIncidents', required: 0, actual: 0, ok: true },
          { name: 'minSafety', required: 0.5, actual: null, ok: false },
        ],
      });
    const r = await run('check', 'alice/claude-code', '--min-safety', '0.5');
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      [
        'ok   verified tasks 7, need at least 1',
        'ok   incidents 0, allow at most 0',
        'FAIL safety none yet, need at least 0.5',
        'FAIL alice/claude-code',
        '',
      ].join('\n'),
    );
    expect(urls).toEqual([
      'https://api.test/v1/check/alice/claude-code?minSafety=0.5',
    ]);
  });

  it('--min-level sends minLevel and prints the level line', async () => {
    reply = () =>
      Response.json({
        ...passing,
        ok: false,
        checks: [
          ...passing.checks,
          { name: 'minLevel', required: 'silver', actual: 'bronze', ok: false },
        ],
      });
    const r = await run(
      'check',
      'alice/claude-code',
      '--min-verified',
      '0',
      '--min-level',
      'silver',
    );
    expect(r.code).toBe(1);
    expect(r.out.split('\n').at(-3)).toBe(
      'FAIL level bronze, need at least silver',
    );
    expect(urls).toEqual([
      'https://api.test/v1/check/alice/claude-code?minVerified=0&minLevel=silver',
    ]);
    const bad = await run(
      'check',
      'alice/claude-code',
      '--min-level',
      'platinum',
    );
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('invalid minLevel platinum');
    expect(urls).toHaveLength(1);
  });

  it.each([
    [
      'a SEAL whose signature does not verify',
      async () => {
        const [h, p, sig = ''] = (passing.seal ?? '').split('.');
        const flipped = sig.startsWith('A')
          ? `B${sig.slice(1)}`
          : `A${sig.slice(1)}`;
        return { ...passing, seal: `${h}.${p}.${flipped}` };
      },
      'its SEAL is bad signature',
    ],
    [
      'a SEAL for another agent',
      async () => {
        const other = await fixture.seal('A'.repeat(43));
        return { ...passing, seal: other, credential: other };
      },
      'its SEAL names another agent',
    ],
    [
      'an answer about another handle',
      async () => ({ ...passing, handle: 'someone/else' }),
      'the API answered for someone/else',
    ],
  ])('does not pass on %s, exit 2', async (_, answer, why) => {
    const body = await answer();
    reply = () => Response.json(body);
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain(`not trusting alice/claude-code, ${why}`);
  });

  it('--json prints the CheckResponse and keeps the exit code', async () => {
    reply = () => Response.json(failing);
    const r = await run('check', 'alice/claude-code', '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual(failing);
    reply = () => Response.json(passing);
    const ok = await run('--json', 'check', 'alice/claude-code');
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual(passing);
  });

  it('reads an answer with only seal or only credential and prints both', async () => {
    const { credential: _c, ...sealOnly } = passing;
    reply = () => Response.json(sealOnly);
    const a = await run('--json', 'check', 'alice/claude-code');
    expect(a.code).toBe(0);
    expect(JSON.parse(a.out)).toEqual(passing);
    const { seal: _s, ...credentialOnly } = passing;
    reply = () => Response.json(credentialOnly);
    const b = await run('--json', 'check', 'alice/claude-code');
    expect(b.code).toBe(0);
    expect(JSON.parse(b.out)).toEqual(passing);
  });

  it('prints a check and a level this version does not know', async () => {
    reply = () =>
      Response.json({
        ...passing,
        ok: false,
        checks: [
          ...passing.checks,
          { name: 'minTenure', required: 30, actual: 12, ok: false },
          { name: 'minLevel', required: 'platinum', actual: 'gold', ok: false },
        ],
      });
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL minTenure 12, required 30');
    expect(r.out).toContain('FAIL level gold, need at least platinum');
  });

  it('exits 2 with the message for an unknown agent', async () => {
    reply = () =>
      Response.json(
        { error: { code: 'not_found', message: 'Agent not found' } },
        { status: 404 },
      );
    const r = await run('check', 'alice/nobody');
    expect(r).toEqual({
      code: 2,
      out: '',
      err: 'no agent alice/nobody\n',
    });
  });

  it('exits 2 and names the new handle for a renamed agent', async () => {
    reply = () =>
      Response.json(
        {
          error: { code: 'renamed', message: 'This agent is now x' },
          id: ID,
          handle: 'alice/ranger',
        },
        { status: 404 },
      );
    const r = await run('check', 'alice/scout');
    expect(r.code).toBe(2);
    expect(r.err).toBe('alice/scout is now alice/ranger\n');
  });

  it('exits 2 when the API cannot be reached', async () => {
    reply = () => {
      throw new TypeError('fetch failed');
    };
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(2);
    expect(r.err).toBe(
      'could not reach the SealKeeper API at https://api.test: fetch failed\n',
    );
  });

  it('exits 2 naming the new address when the API answers a redirect', async () => {
    reply = () =>
      new Response(null, {
        status: 301,
        headers: {
          Location: 'https://api.sealkeeper.run/v1/check/alice/claude-code',
        },
      });
    const r = await run('check', 'alice/claude-code');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(
      /^the API at https:\/\/api\.test moved to https:\/\/api\.sealkeeper\.run, set apiUrl in .+config\.json to it\n$/,
    );
    expect(urls).toHaveLength(1);
  });

  it('exits 2 without a request for a bad handle or flag', async () => {
    const handle = await run('check', 'alice');
    expect(handle.code).toBe(2);
    expect(handle.err).toContain('invalid handle alice');
    const flag = await run('check', 'alice/claude-code', '--min-safety', '1.5');
    expect(flag.code).toBe(2);
    expect(flag.err).toContain('invalid minSafety 1.5');
    const empty = await run('check', 'alice/claude-code', '--min-verified', '');
    expect(empty.code).toBe(2);
    expect(urls).toEqual([]);
  });
});
