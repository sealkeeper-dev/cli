// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  REPORT_UPLOAD_HOST,
  REPORT_UPLOAD_MAX_BYTES,
  readAudience,
  SignedMyReportsPayload,
  SignedReportPayload,
  SignedReportUploadPayload,
  verify,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, writeConfig } from '../config.js';
import { createKey } from '../identity.js';
import { createProgram } from '../program.js';
import { takePurpose } from '../test-purpose.js';
import { evidenceKind, KEY_IN_REPORT } from './report.js';

const API_URL = 'https://api.test';
const TARGET = `${'T'.repeat(42)}A`;
const SERVICE = `${'S'.repeat(42)}A`;
const TASK_ID = '0b6f8a52-4c1e-4f2a-9d55-1f0e6b7d2a10';
const UPLOAD_ID = '6f1c2b3a-1111-4a2b-8c3d-4e5f6a7b8c9d';
const REPORT_ID_SEEN: string[] = [];
// The id of the nth upload the fake answers, UPLOAD_ID first.
const uploadIdOf = (n: number) =>
  n === 0
    ? UPLOAD_ID
    : `6f1c2b3a-1111-4a2b-8c3d-${String(n).padStart(12, '0')}`;

type RunResult = { code: number; out: string; err: string };
type Call = { method: string; path: string; payload?: unknown };

// Every signed payload names the API and the route it is for. The fake takes
// both off before it parses, and a payload without them fails the test.
const audErrors: unknown[] = [];
const unsigned = (payload: unknown, method: string, path: string) => {
  const check = readAudience(payload, [API_URL]);
  const named = takePurpose(check.payload, method, path);
  if (check.result !== 'match' || !named.ok) audErrors.push(payload);
  return named.payload;
};
afterEach(() => {
  expect(audErrors.splice(0)).toEqual([]);
});

// The API sends subjectKind only inside a listed agent's listing.
const agentAnswer = (id: string, handle: string, subjectKind?: string) => ({
  id,
  name: handle.split('/')[1],
  version: '1.0.0',
  operator: { slug: 'bob' },
  createdAt: '2026-10-01T00:00:00.000Z',
  handle,
  ...(subjectKind
    ? {
        listing: {
          domainKey: handle.split('/')[0],
          status: 'listed',
          subjectKind,
        },
      }
    : {}),
});

function error(
  status: number,
  code: string,
  issues?: { path: (string | number)[]; code: string; message: string }[],
): Response {
  return Response.json(
    {
      error: {
        code,
        message: `failed with ${code}`,
        ...(issues ? { issues } : {}),
      },
    },
    { status },
  );
}

// A stand in for the agent reads, the upload, the bucket and the report
// routes. Every call is recorded, and a signed body is verified against its
// kid, which must be the local agent.
class FakeApi {
  calls: Call[] = [];
  errors: string[] = [];
  put: { headers: Record<string, string>; body: Buffer } | null = null;
  // Every upload address is the bucket's, unless a test names another.
  uploadUrl: string | null = null;
  putStatus = 200;
  // The status of each PUT in turn, putStatus once they run out.
  putStatuses: number[] = [];
  uploads = 0;
  fileReply: ((payload: SignedReportPayload) => Response | null) | null = null;
  // The reports filed, by id, so a filing with a stored id is answered
  // with the report it names, as SealKeeper answers a retry.
  stored = new Map<string, unknown>();
  // How many filings to store and then answer with no answer at all.
  lostAnswers = 0;
  mineReply: Response | null = null;
  handleReply: Response | null = null;

  constructor(readonly agentId: string) {}

  private async signed(
    init: RequestInit | undefined,
    method: string,
    path: string,
  ) {
    const { envelope } = JSON.parse(String(init?.body)) as { envelope: string };
    const kid = decodeHeader(envelope).kid;
    if (kid !== this.agentId) this.errors.push(`kid ${kid}`);
    return unsigned(
      (await verify(envelope, base64urlDecode(kid))).payload,
      method,
      path,
    );
  }

  fetch: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const call: Call = { method, path: url.pathname };
    this.calls.push(call);
    if (url.host === REPORT_UPLOAD_HOST) {
      this.put = {
        headers: { ...(init?.headers as Record<string, string>) },
        body: Buffer.from(init?.body as Uint8Array),
      };
      return new Response(null, {
        status: this.putStatuses.shift() ?? this.putStatus,
      });
    }
    if (method === 'GET' && url.pathname === `/v1/agents/${TARGET}`) {
      return Response.json(agentAnswer(TARGET, 'bob/scout', 'agent'));
    }
    if (method === 'GET' && url.pathname === '/v1/agents/bob/scout') {
      return (
        this.handleReply ?? Response.json(agentAnswer(TARGET, 'bob/scout'))
      );
    }
    if (method === 'GET' && url.pathname === '/v1/agents/acme.ai/weather') {
      return Response.json(agentAnswer(SERVICE, 'acme.ai/weather', 'service'));
    }
    if (method === 'POST' && url.pathname === '/v1/report-uploads') {
      call.payload = SignedReportUploadPayload.parse(
        await this.signed(init, method, url.pathname),
      );
      const uploadId = uploadIdOf(this.uploads++);
      return Response.json(
        {
          uploadId,
          upload: {
            method: 'PUT',
            url:
              this.uploadUrl ??
              `https://${REPORT_UPLOAD_HOST}/evidence-bucket/evidence/${uploadId}?X-Goog-Signature=abc`,
            headers: {
              'Content-Type': 'image/png',
              'X-Goog-Content-Length-Range': '0,4',
            },
          },
          expiresAt: '2026-10-30T10:15:00.000Z',
        },
        { status: 201 },
      );
    }
    if (method === 'POST' && url.pathname === '/v1/reports') {
      const payload = SignedReportPayload.parse(
        await this.signed(init, method, url.pathname),
      );
      call.payload = payload;
      REPORT_ID_SEEN.push(payload.reportId);
      const replied = this.fileReply?.(payload);
      if (replied) return replied;
      const stored = this.stored.get(payload.reportId);
      if (stored) return Response.json(stored, { status: 200 });
      const answer = {
        id: payload.reportId,
        status: 'received',
        category: payload.category,
        target: { kind: payload.targetKind, id: payload.targetId },
        createdAt: '2026-10-30T10:00:00.000Z',
        disclosureAt: null,
      };
      this.stored.set(payload.reportId, answer);
      if (this.lostAnswers > 0) {
        this.lostAnswers--;
        throw new TypeError('fetch failed');
      }
      return Response.json(answer, { status: 201 });
    }
    if (method === 'POST' && url.pathname === '/v1/reports/mine') {
      call.payload = SignedMyReportsPayload.parse(
        await this.signed(init, method, url.pathname),
      );
      return this.mineReply ?? Response.json({ reports: [], nextCursor: null });
    }
    return error(404, 'not_found');
  }) as typeof fetch;

  paths(): string[] {
    return this.calls.map((c) => `${c.method} ${c.path}`);
  }
}

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

describe('sealkeeper report', () => {
  let home: string;
  let work: string;
  let agentId: string;
  let api: FakeApi;

  async function run(...args: string[]): Promise<RunResult> {
    const program = createProgram({ tasks: { fetch: api.fetch } });
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
    } catch (e) {
      if (e instanceof CommanderError) return { code: e.exitCode, out, err };
      throw e;
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
  }

  const fileReport = (...extra: string[]) =>
    run(
      'report',
      'bob/scout',
      '--category',
      'fraud',
      '--description',
      'Took payment and sent nothing back.',
      ...extra,
    );

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-report-'));
    work = await mkdtemp(join(tmpdir(), 'sealkeeper-report-work-'));
    vi.spyOn(process, 'cwd').mockReturnValue(work);
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', '');
    ({ agentId } = await createKey());
    await writeConfig({
      agentId,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      apiUrl: API_URL,
      registeredAt: new Date().toISOString(),
    });
    api = new FakeApi(agentId);
  });

  afterEach(async () => {
    expect(api.errors).toEqual([]);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it('files a report on a handle with references and a file, signed by this agent', async () => {
    await writeFile(join(work, 'receipt.png'), Buffer.from([1, 2, 3, 4]));
    const { code, out, err } = await fileReport(
      '--evidence',
      `task_id=${TASK_ID}`,
      '--evidence',
      'url=https://example.com/log',
      '--file',
      'receipt.png',
    );
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(api.paths()).toEqual([
      'GET /v1/agents/bob/scout',
      'POST /v1/report-uploads',
      'PUT /evidence-bucket/evidence/6f1c2b3a-1111-4a2b-8c3d-4e5f6a7b8c9d',
      'POST /v1/reports',
    ]);
    expect(api.calls[1]?.payload).toMatchObject({
      fileName: 'receipt.png',
      contentType: 'image/png',
      sizeBytes: 4,
    });
    expect(api.put?.headers).toEqual({
      'Content-Type': 'image/png',
      'X-Goog-Content-Length-Range': '0,4',
    });
    expect([...(api.put?.body ?? [])]).toEqual([1, 2, 3, 4]);
    expect(api.calls[3]?.payload).toMatchObject({
      targetKind: 'agent',
      targetId: TARGET,
      category: 'fraud',
      description: 'Took payment and sent nothing back.',
      surface: 'cli',
      evidence: [
        { kind: 'sealkeeper_record', refType: 'task_id', refValue: TASK_ID },
        {
          kind: 'other',
          refType: 'url',
          refValue: 'https://example.com/log',
        },
        { kind: 'other', refType: 'file', refValue: UPLOAD_ID },
      ],
    });
    expect(out).toMatch(/^report +[0-9a-f-]{36}$/m);
    expect(out).toMatch(/^target +bob\/scout, agent$/m);
    expect(out).toMatch(/^status +received$/m);
    expect(out).toContain('report list');
  });

  it('files on a service named by its page URL as a service', async () => {
    const { code } = await run(
      'report',
      'https://sealkeeper.run/agents/acme.ai/weather',
      '--category',
      'price_dishonesty',
      '--description',
      'Charged twice the stated price.',
      '--evidence',
      `x402_tx_hash=0x${'a'.repeat(64)}`,
    );
    expect(code).toBe(0);
    expect(api.calls.at(-1)?.payload).toMatchObject({
      targetKind: 'service',
      targetId: SERVICE,
      evidence: [
        {
          kind: 'external',
          refType: 'x402_tx_hash',
          refValue: `0x${'a'.repeat(64)}`,
        },
      ],
    });
  });

  it('takes an agent id and prints the answer with --json', async () => {
    const { code, out } = await run(
      'report',
      TARGET,
      '--category',
      'security',
      '--description',
      'Leaks its API key in every answer.',
      '--evidence',
      'receipt_hash=sha256:0123456789abcdef',
      '--json',
    );
    expect(code).toBe(0);
    const answer = JSON.parse(out) as { id: string; target: unknown };
    expect(answer.target).toEqual({ kind: 'agent', id: TARGET });
    expect(REPORT_ID_SEEN).toContain(answer.id);
  });

  it.each([
    [
      ['--category', 'spam', '--evidence', `task_id=${TASK_ID}`],
      '--category must be one of fraud',
    ],
    [['--evidence', 'hash=abc'], '--evidence takes <ref_type>=<value>'],
    [
      ['--evidence', 'task_id=nope'],
      '--evidence task_id=nope, a task id is a UUID',
    ],
    [[], 'a report holds 1 to 10 pieces of evidence, as --evidence or --file'],
    [['--file', 'notes.exe'], 'refusing to send notes.exe'],
    [['--file', '.env.txt'], 'holds secrets'],
  ])('refuses %j before anything is sent', async (flags, line) => {
    await writeFile(join(work, '.env.txt'), 'TOKEN=1');
    await writeFile(join(work, 'notes.exe'), 'x');
    const { code, err } = await fileReport(...flags);
    expect(code).toBe(1);
    expect(err).toContain(line);
    expect(api.calls).toEqual([]);
  });

  it('refuses a file outside the current directory unless allowed', async () => {
    const other = await mkdtemp(join(tmpdir(), 'sealkeeper-report-other-'));
    try {
      const file = join(other, 'log.txt');
      await writeFile(file, 'GET /pay 402');
      const refused = await fileReport('--file', file);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('outside the current directory');
      expect(api.calls).toEqual([]);
      const allowed = await fileReport('--file', file, '--allow-outside-cwd');
      expect(allowed.code).toBe(0);
      expect(api.calls[1]?.payload).toMatchObject({
        fileName: 'log.txt',
        contentType: 'text/plain',
        sizeBytes: 12,
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('refuses a file larger than an upload takes before reading it', async () => {
    await writeFile(
      join(work, 'big.log'),
      Buffer.alloc(REPORT_UPLOAD_MAX_BYTES + 1),
    );
    const { code, err } = await fileReport('--file', 'big.log');
    expect(code).toBe(1);
    expect(err).toContain('Nothing was read');
    expect(api.calls).toEqual([]);
  });

  it.each([
    'scout',
    'https://example.com/agents/bob/scout',
    'https://sealkeeper.run/tasks/1',
  ])('refuses the target %s before anything is sent', async (target) => {
    const { code, err } = await run(
      'report',
      target,
      '--category',
      'fraud',
      '--description',
      'x',
      '--evidence',
      `task_id=${TASK_ID}`,
    );
    expect(code).toBe(1);
    expect(err).toContain('is not an agent or a service');
    expect(api.calls).toEqual([]);
  });

  it('names the handle a renamed agent has now and files nothing', async () => {
    api.handleReply = Response.json(
      {
        error: { code: 'renamed', message: 'This agent is now bob/scout-2' },
        id: TARGET,
        handle: 'bob/scout-2',
      },
      { status: 404 },
    );
    const { code, err } = await fileReport('--evidence', `task_id=${TASK_ID}`);
    expect(code).toBe(1);
    expect(err).toContain('bob/scout is now bob/scout-2');
    expect(api.paths()).toEqual(['GET /v1/agents/bob/scout']);
  });

  it('tells the operator to claim an agent whose key is not handed over', async () => {
    api.fileReply = () => error(403, 'key_not_handed_over');
    const { code, err } = await fileReport('--evidence', `task_id=${TASK_ID}`);
    expect(code).toBe(1);
    expect(err).toContain(
      'this agent is not claimed yet, claim it on its SealKeeper page first',
    );
  });

  it('says to run init on a machine with no agent and sends nothing', async () => {
    await rm(paths(home).config);
    const { code, err } = await fileReport('--evidence', `task_id=${TASK_ID}`);
    expect(code).toBe(1);
    expect(err).toMatch(/not initialised, run .*init/);
    expect(api.calls).toEqual([]);
  });

  it('says to run init when SealKeeper does not know this agent', async () => {
    api.fileReply = () => error(401, 'unknown_agent');
    const { code, err } = await fileReport('--evidence', `task_id=${TASK_ID}`);
    expect(code).toBe(1);
    expect(err).toMatch(/this agent is not registered, run .*init/);
  });

  it('refuses a description that holds the private key and sends nothing', async () => {
    const key = (await readFile(paths(home).key, 'utf8')).trim();
    const { code, err } = await run(
      'report',
      'bob/scout',
      '--category',
      'fraud',
      '--description',
      `It asked for ${key}`,
      '--evidence',
      `task_id=${TASK_ID}`,
    );
    expect(code).toBe(1);
    expect(err).toContain(KEY_IN_REPORT);
    expect(api.calls).toEqual([]);
  });

  it('refuses a file that holds the private key and sends nothing', async () => {
    const key = (await readFile(paths(home).key, 'utf8')).trim();
    await writeFile(join(work, 'dump.txt'), `key=${key}\n`);
    const { code, err } = await fileReport('--file', 'dump.txt');
    expect(code).toBe(1);
    expect(err).toContain(
      "refusing to send dump.txt, it contains this agent's private key",
    );
    expect(api.calls).toEqual([]);
  });

  it('asks for --description and sends nothing', async () => {
    const { code, err } = await run(
      'report',
      'bob/scout',
      '--category',
      'fraud',
      '--evidence',
      `task_id=${TASK_ID}`,
    );
    expect(code).toBe(1);
    expect(err).toContain('--description is needed');
    expect(api.calls).toEqual([]);
  });

  it('files nothing when the upload is refused', async () => {
    await writeFile(join(work, 'receipt.png'), Buffer.from([1, 2, 3, 4]));
    api.putStatus = 403;
    const { code, err } = await fileReport('--file', 'receipt.png');
    expect(code).toBe(1);
    expect(err).toContain(
      'could not upload receipt.png, the upload answered HTTP 403',
    );
    expect(api.paths()).not.toContain('POST /v1/reports');
  });

  it('reads the agent from a page below its page URL', async () => {
    const { code } = await run(
      'report',
      'https://sealkeeper.run/agents/bob/scout/duels',
      '--category',
      'fraud',
      '--description',
      'Took payment and sent nothing back.',
      '--evidence',
      `task_id=${TASK_ID}`,
    );
    expect(code).toBe(0);
    expect(api.paths()[0]).toBe('GET /v1/agents/bob/scout');
    expect(api.calls.at(-1)?.payload).toMatchObject({ targetId: TARGET });
  });

  it('names the flag of a reference SealKeeper holds no record of', async () => {
    api.fileReply = () =>
      error(422, 'evidence_not_found', [
        {
          path: ['evidence', 0, 'refValue'],
          code: 'evidence_not_found',
          message: 'No task has this id',
        },
      ]);
    const { code, err } = await fileReport('--evidence', `task_id=${TASK_ID}`);
    expect(code).toBe(1);
    expect(err).toContain(`--evidence task_id=${TASK_ID}, no task has this id`);
  });

  it('never sends a file to an upload address off the storage host', async () => {
    await writeFile(join(work, 'receipt.png'), Buffer.from([1, 2, 3, 4]));
    api.uploadUrl = 'https://elsewhere.test/upload';
    const { code, err } = await fileReport('--file', 'receipt.png');
    expect(code).toBe(1);
    expect(err).toContain(`the upload address is not ${REPORT_UPLOAD_HOST}`);
    expect(api.paths()).toEqual([
      'GET /v1/agents/bob/scout',
      'POST /v1/report-uploads',
    ]);
  });

  describe('run again', () => {
    const filings = () =>
      api.calls
        .filter((c) => c.method === 'POST' && c.path === '/v1/reports')
        .map((c) => c.payload as SignedReportPayload);
    const uploadsSent = () =>
      api.calls.filter((c) => c.path === '/v1/report-uploads').length;
    const fileRefs = (payload: SignedReportPayload | undefined) =>
      (payload?.evidence ?? [])
        .filter((e) => e.refType === 'file')
        .map((e) => e.refValue);

    beforeEach(async () => {
      await writeFile(join(work, 'receipt.png'), Buffer.from([1, 2, 3, 4]));
      await writeFile(join(work, 'call.log'), 'GET /pay 402\n');
    });

    it('files once when the same command runs again after an answer that never came', async () => {
      api.lostAnswers = 1;
      const first = await fileReport('--file', 'receipt.png');
      expect(first.code).toBe(1);
      const again = await fileReport('--file', 'receipt.png');
      expect(again.err).toBe('');
      expect(again.code).toBe(0);
      expect(uploadsSent()).toBe(1);
      const [one, two] = filings();
      expect(two?.reportId).toBe(one?.reportId);
      expect(fileRefs(two)).toEqual([UPLOAD_ID]);
      expect(api.stored.size).toBe(1);
      expect(again.out).toMatch(
        new RegExp(`^report +${one?.reportId ?? 'none'}$`, 'm'),
      );
    });

    it('files a second report with a new id when the same command runs again after it was filed', async () => {
      const first = await fileReport('--file', 'receipt.png');
      expect(first.code).toBe(0);
      const again = await fileReport('--file', 'receipt.png');
      expect(again.err).toBe('');
      expect(again.code).toBe(0);
      const [one, two] = filings();
      expect(two?.reportId).not.toBe(one?.reportId);
      expect(api.stored.size).toBe(2);
      expect(uploadsSent()).toBe(2);
      expect(again.out).toMatch(
        new RegExp(`^report +${two?.reportId ?? 'none'}$`, 'm'),
      );
    });

    it('files a new report after a filing answered as one SealKeeper already held', async () => {
      const withRef = () =>
        fileReport('--evidence', 'url=https://example.com/log');
      api.lostAnswers = 1;
      await withRef();
      const replay = await withRef();
      expect(replay.code).toBe(0);
      const next = await withRef();
      expect(next.code).toBe(0);
      const [one, two, three] = filings();
      expect(two?.reportId).toBe(one?.reportId);
      expect(three?.reportId).not.toBe(one?.reportId);
      expect(api.stored.size).toBe(2);
      await expect(stat(paths(home).reportPending)).rejects.toThrow();
    });

    it('files once under the same id when the same command runs again after SealKeeper refused it', async () => {
      const withRef = () =>
        fileReport('--evidence', 'url=https://example.com/log');
      for (const [status, code] of [
        [500, 'internal'],
        [429, 'rate_limited'],
      ] as const) {
        let refusals = 1;
        api.fileReply = () => (refusals-- > 0 ? error(status, code) : null);
        const first = await withRef();
        expect(first.code).toBe(1);
        const again = await withRef();
        expect(again.err).toBe('');
        expect(again.code).toBe(0);
        const [one, two] = filings().slice(-2);
        expect(two?.reportId).toBe(one?.reportId);
        expect(api.stored.has(two?.reportId ?? '')).toBe(true);
        await expect(stat(paths(home).reportPending)).rejects.toThrow();
      }
      expect(api.stored.size).toBe(2);
    });

    it('drops an id SealKeeper says is in use, so the next run files under a new one', async () => {
      const withRef = () =>
        fileReport('--evidence', 'url=https://example.com/log');
      api.lostAnswers = 1;
      await withRef();
      const taken = filings()[0]?.reportId;
      api.fileReply = (payload) =>
        payload.reportId === taken ? error(409, 'report_id_taken') : null;
      const refused = await withRef();
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        'this report id is in use, run the same command again to file it under a new one',
      );
      const again = await withRef();
      expect(again.err).toBe('');
      expect(again.code).toBe(0);
      expect(filings().at(-1)?.reportId).not.toBe(taken);
      await expect(stat(paths(home).reportPending)).rejects.toThrow();
    });

    it('uploads only the files still missing when run again after a failed upload', async () => {
      api.putStatuses = [200, 500];
      const first = await fileReport(
        '--file',
        'receipt.png',
        '--file',
        'call.log',
      );
      expect(first.code).toBe(1);
      expect(first.err).toContain('could not upload call.log');
      expect(filings()).toEqual([]);
      const again = await fileReport(
        '--file',
        'receipt.png',
        '--file',
        'call.log',
      );
      expect(again.code).toBe(0);
      expect(uploadsSent()).toBe(3);
      expect(api.calls.at(-3)?.payload).toMatchObject({ fileName: 'call.log' });
      expect(fileRefs(filings()[0])).toEqual([UPLOAD_ID, uploadIdOf(2)]);
    });

    it('files a new report when the description changed, sending no file again', async () => {
      api.lostAnswers = 1;
      await fileReport('--file', 'receipt.png');
      const changed = await run(
        'report',
        'bob/scout',
        '--category',
        'fraud',
        '--description',
        'Took payment twice and sent nothing back.',
        '--file',
        'receipt.png',
      );
      expect(changed.code).toBe(0);
      const [one, two] = filings();
      expect(two?.reportId).not.toBe(one?.reportId);
      expect(uploadsSent()).toBe(1);
      expect(fileRefs(two)).toEqual([UPLOAD_ID]);
    });

    it('keeps the report id and the uploads only until the report is filed, readable by the owner alone', async () => {
      const p = paths(home);
      api.lostAnswers = 1;
      await fileReport('--file', 'receipt.png');
      const kept = JSON.parse(await readFile(p.reportPending, 'utf8'));
      expect(kept).toEqual({
        v: 1,
        reports: [
          {
            key: expect.stringMatching(/^[0-9a-f]{64}$/),
            reportId: filings()[0]?.reportId,
          },
        ],
        uploads: [
          {
            file: expect.stringMatching(/^[0-9a-f]{64}$/),
            uploadId: UPLOAD_ID,
          },
        ],
      });
      if (process.platform !== 'win32') {
        expect((await stat(p.reportPending)).mode & 0o777).toBe(0o600);
      }
      const again = await fileReport('--file', 'receipt.png');
      expect(again.code).toBe(0);
      await expect(stat(p.reportPending)).rejects.toThrow();
    });

    it('uploads every file again once when SealKeeper no longer takes a kept upload', async () => {
      api.lostAnswers = 1;
      await fileReport('--file', 'receipt.png');
      api.stored.clear();
      api.fileReply = (payload) =>
        fileRefs(payload).includes(UPLOAD_ID)
          ? error(422, 'evidence_not_found', [
              {
                path: ['evidence', 0, 'refValue'],
                code: 'evidence_not_found',
                message: 'No upload of yours has this id',
              },
            ])
          : null;
      const again = await fileReport('--file', 'receipt.png');
      expect(again.err).toBe('');
      expect(again.code).toBe(0);
      expect(uploadsSent()).toBe(2);
      expect(fileRefs(filings().at(-1))).toEqual([uploadIdOf(1)]);
      await expect(stat(paths(home).reportPending)).rejects.toThrow();
    });

    it('uploads again only when SealKeeper refuses the kept file, not a reference before it', async () => {
      const withRef = () =>
        fileReport(
          '--evidence',
          'url=https://example.com/log',
          '--file',
          'receipt.png',
        );
      api.lostAnswers = 1;
      await withRef();
      api.stored.clear();
      const refusedAt = (index: number) => () =>
        error(422, 'evidence_not_found', [
          {
            path: ['evidence', index, 'refValue'],
            code: 'evidence_not_found',
            message: 'No record has this id',
          },
        ]);
      api.fileReply = refusedAt(0);
      const onRef = await withRef();
      expect(onRef.code).toBe(1);
      expect(onRef.err).toContain(
        '--evidence url=https://example.com/log, no record has this id',
      );
      expect(uploadsSent()).toBe(1);
      api.fileReply = (payload) =>
        fileRefs(payload).includes(UPLOAD_ID) ? refusedAt(1)() : null;
      const onFile = await withRef();
      expect(onFile.err).toBe('');
      expect(onFile.code).toBe(0);
      expect(uploadsSent()).toBe(2);
      expect(fileRefs(filings().at(-1))).toEqual([uploadIdOf(1)]);
    });

    it('uploads every file again once when a kept upload is evidence already', async () => {
      api.lostAnswers = 1;
      await fileReport('--file', 'receipt.png');
      api.stored.clear();
      api.fileReply = (payload) =>
        fileRefs(payload).includes(UPLOAD_ID)
          ? error(409, 'upload_used')
          : null;
      const again = await fileReport('--file', 'receipt.png');
      expect(again.err).toBe('');
      expect(again.code).toBe(0);
      expect(uploadsSent()).toBe(2);
      expect(fileRefs(filings().at(-1))).toEqual([uploadIdOf(1)]);
    });

    it('uploads a file given twice once for each', async () => {
      api.lostAnswers = 1;
      await fileReport('--file', 'receipt.png', '--file', 'receipt.png');
      const again = await fileReport(
        '--file',
        'receipt.png',
        '--file',
        'receipt.png',
      );
      expect(again.code).toBe(0);
      const refs = fileRefs(filings().at(-1));
      expect(new Set(refs).size).toBe(2);
    });
  });

  it('maps each reference type to its kind of evidence', () => {
    expect(evidenceKind('task_id')).toBe('sealkeeper_record');
    expect(evidenceKind('test_result_id')).toBe('sealkeeper_record');
    expect(evidenceKind('receipt_hash')).toBe('external');
    expect(evidenceKind('x402_tx_hash')).toBe('external');
    expect(evidenceKind('url')).toBe('other');
  });

  describe('list', () => {
    const page = (nextCursor: string | null) =>
      Response.json({
        reports: [
          {
            id: '11111111-2222-4333-8444-555555555555',
            reporter: { kind: 'agent', agentId: 'x' },
            target: { kind: 'service', id: SERVICE },
            category: 'fraud',
            description: 'Took payment.',
            status: 'dismissed',
            decisionReason: 'The receipt shows a refund.',
            decidedAt: '2026-10-29T09:00:00.000Z',
            disclosureAt: null,
            publishedAt: null,
            createdAt: '2026-10-28T09:00:00.000Z',
            evidence: [],
          },
          {
            id: '66666666-7777-4888-8999-000000000000',
            reporter: { kind: 'agent', agentId: 'x' },
            target: { kind: 'agent', id: TARGET },
            category: 'impersonation',
            description: 'Poses as another agent.',
            status: 'upheld',
            decisionReason: 'Confirmed.',
            decidedAt: '2026-10-29T10:00:00.000Z',
            disclosureAt: null,
            publishedAt: '2026-10-29T10:00:00.000Z',
            createdAt: '2026-10-27T09:00:00.000Z',
            evidence: [],
            somethingNew: true,
          },
        ],
        nextCursor,
      });

    it('prints each report with its status and reason, signed as this agent', async () => {
      api.mineReply = page(null);
      const { code, out } = await run('report', 'list');
      expect(code).toBe(0);
      expect(api.paths()).toEqual(['POST /v1/reports/mine']);
      expect(out).toMatch(/^status +dismissed$/m);
      expect(out).toMatch(/^reason +The receipt shows a refund\.$/m);
      expect(out).toMatch(/^target +service S+A$/m);
      expect(out).toMatch(/^public +2026-10-29 10:00 UTC$/m);
      expect(out).not.toContain('Older reports');
    });

    it('says how to read the next page', async () => {
      api.mineReply = page('abc');
      const { out } = await run('report', 'list');
      expect(out).toContain('report list --cursor abc');
    });

    it('prints the page with --json', async () => {
      api.mineReply = page(null);
      const { out } = await run('report', 'list', '--json');
      expect((JSON.parse(out) as { reports: unknown[] }).reports).toHaveLength(
        2,
      );
    });

    it('refuses a cursor the list never printed and sends nothing', async () => {
      const { code, err } = await run('report', 'list', '--cursor', 'not!one');
      expect(code).toBe(1);
      expect(err).toContain('--cursor is not one the list printed');
      expect(api.calls).toEqual([]);
    });

    it('says when the agent filed none', async () => {
      const { out } = await run('report', 'list');
      expect(out.trim()).toBe('this agent has filed no reports');
    });
  });
});
