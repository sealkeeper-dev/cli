// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlEncode,
  generateKeypair,
  MCP_TOO_LARGE,
  SEAL_AT_IN_FUTURE,
  sign,
} from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../program.js';
import { VERSION } from '../version.js';
import { mcpLines } from './mcp.js';

const API_URL = 'https://api.test';
const KID = 'sealkeeper-test-1';
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NOW_SEC = NOW / 1000;
const AGENT = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';

type Keypair = Awaited<ReturnType<typeof generateKeypair>>;
type RunResult = { code: number; out: string; err: string };
type Line = Record<string, unknown> & {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

const call = (id: number, name: string, args: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });

// One character in the middle of the signature, changed.
function tamper(seal: string): string {
  const [header, payload, signature = ''] = seal.split('.');
  const i = Math.floor(signature.length / 2);
  const swapped = signature[i] === 'A' ? 'B' : 'A';
  return `${header}.${payload}.${signature.slice(0, i)}${swapped}${signature.slice(i + 1)}`;
}

async function* chunks(parts: (string | Buffer)[]) {
  for (const part of parts) yield part;
}

describe('sealkeeper mcp', () => {
  let home: string;
  let serverKey: Keypair;
  let keysFile: string;
  let requests: { url: string; body: unknown }[];
  let reply: () => Response;

  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      url: String(input),
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return reply();
  }) as typeof fetch;

  const seal = () =>
    sign(
      {
        iss: 'sealkeeper.run',
        sub: AGENT,
        ver: 1,
        iat: NOW_SEC,
        exp: NOW_SEC + 86_400,
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
      },
      serverKey.privateKey,
      KID,
    );

  // Runs sealkeeper mcp over the lines given as standard input, and
  // returns each line it wrote to standard output parsed.
  async function run(
    lines: string[],
    ...args: string[]
  ): Promise<RunResult & { answers: Line[] }> {
    const program = createProgram({
      mcp: {
        fetch: fetchFn,
        now: () => NOW,
        input: chunks(lines.map((line) => `${line}\n`)),
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
    let code = 0;
    try {
      await program.parseAsync(['mcp', ...args], { from: 'user' });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      code = error.exitCode;
    } finally {
      vi.mocked(process.stdout.write).mockRestore();
      vi.mocked(process.stderr.write).mockRestore();
    }
    const answers = out
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Line);
    return { code, out, err, answers };
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-mcp-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('SEALKEEPER_API_URL', API_URL);
    serverKey = await generateKeypair();
    keysFile = join(home, 'seal.json');
    await writeFile(
      keysFile,
      JSON.stringify({
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
    );
    requests = [];
    reply = () => Response.json({ error: 'unexpected' }, { status: 500 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('answers initialize and lists the three tools, with no init and nothing fetched', async () => {
    const { code, err, answers } = await run([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(requests).toEqual([]);
    // The notification gets no line.
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
    expect(answers[0]?.result).toEqual({
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'sealkeeper', title: 'SealKeeper', version: VERSION },
    });
    const tools = answers[1]?.result?.tools as {
      name: string;
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((t) => t.name)).toEqual([
      'find_agents',
      'get_trust',
      'verify_seal',
    ]);
    for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('verify_seal answers a valid SEAL with what seal verify says, checked against --keys', async () => {
    const { err, answers } = await run(
      [call(3, 'verify_seal', { seal: await seal(), agent: AGENT })],
      '--keys',
      keysFile,
    );
    expect(err).toBe('');
    expect(requests).toEqual([]);
    const result = answers[0]?.result as {
      content: { type: string; text: string }[];
      structuredContent: { valid: boolean; payload: { sub: string } };
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.valid).toBe(true);
    expect(result.structuredContent.payload.sub).toBe(AGENT);
    const text = result.content[0]?.text.split('\n') ?? [];
    expect(text[0]).toBe('valid Agent SEAL');
    expect(text).toContain('level Bronze Agent SEAL');
    expect(text.at(-1)).toBe('Expires in 24 hours 0 minutes');
    expect(JSON.parse(result.content[1]?.text ?? '')).toEqual(
      result.structuredContent,
    );
  });

  it('verify_seal answers a tampered SEAL as broken, and a SEAL for another agent as the wrong agent', async () => {
    const { answers } = await run(
      [
        call(4, 'verify_seal', { seal: tamper(await seal()) }),
        call(5, 'verify_seal', { seal: await seal(), agent: 'A'.repeat(43) }),
      ],
      '--keys',
      keysFile,
    );
    const broken = answers[0]?.result as {
      content: { text: string }[];
      structuredContent: { valid: boolean; reason: string; payload: unknown };
    };
    expect(broken.structuredContent).toMatchObject({
      valid: false,
      reason: 'bad signature',
      payload: null,
    });
    expect(broken.content[0]?.text).toBe('broken SEAL: bad signature');
    const other = answers[1]?.result as {
      structuredContent: { valid: boolean; reason: string };
    };
    expect(other.structuredContent).toMatchObject({
      valid: false,
      reason: 'wrong agent',
    });
  });

  it('verify_seal with --offline and no cached keys is a tool error, and nothing is fetched', async () => {
    const { err, answers } = await run(
      [call(6, 'verify_seal', { seal: await seal() })],
      '--offline',
    );
    expect(requests).toEqual([]);
    expect(err).toBe('');
    expect(answers[0]?.result).toEqual({
      content: [
        {
          type: 'text',
          text: 'there is no usable cached SealKeeper key file, run npx sealkeeper seal verify once without --offline, or pass --keys',
        },
      ],
      isError: true,
    });
  });

  it('verify_seal refuses a time to check at in the future, and bad arguments, as tool errors', async () => {
    const { answers } = await run(
      [
        call(7, 'verify_seal', {
          seal: await seal(),
          at: '2026-09-25T12:00:00Z',
        }),
        call(8, 'verify_seal', { seal: 'a.b.c', extra: 1 }),
      ],
      '--keys',
      keysFile,
    );
    expect(answers[0]?.result).toEqual({
      content: [{ type: 'text', text: SEAL_AT_IN_FUTURE }],
      isError: true,
    });
    expect(answers[1]?.result).toMatchObject({ isError: true });
  });

  it('find_agents forwards the call to the API with the arguments as sent, and passes its result through', async () => {
    const data = {
      skill: 'find-agents',
      agents: [{ handle: 'alice/weather', trustScore: 42 }],
      nextCursor: null,
    };
    const apiResult = {
      content: [
        { type: 'text', text: 'Found 1 agent.' },
        { type: 'text', text: JSON.stringify(data) },
      ],
      structuredContent: data,
    };
    reply = () => Response.json({ jsonrpc: '2.0', id: 1, result: apiResult });
    const { err, answers } = await run([
      call(9, 'find_agents', {
        q: 'weather',
        min_trust: 10,
        domain: 'Example.COM',
      }),
    ]);
    expect(err).toBe('');
    expect(requests).toEqual([
      {
        url: `${API_URL}/mcp`,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'find_agents',
            arguments: { q: 'weather', min_trust: 10, domain: 'Example.COM' },
          },
        },
      },
    ]);
    expect(answers).toEqual([{ jsonrpc: '2.0', id: 9, result: apiResult }]);
  });

  it('get_trust forwards a handle, and arguments as they came, which the API checks', async () => {
    const data = {
      skill: 'get-trust',
      status: 'not_found',
      agent: null,
      seal: null,
    };
    reply = () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            { type: 'text', text: 'No agent found.' },
            { type: 'text', text: JSON.stringify(data) },
          ],
          structuredContent: data,
        },
      });
    const { answers } = await run([
      call(10, 'get_trust', { agent: 'alice/weather' }),
      call(11, 'get_trust', {}),
    ]);
    expect(requests.map((r) => r.body)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_trust', arguments: { agent: 'alice/weather' } },
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_trust', arguments: {} },
      },
    ]);
    expect(answers[0]?.result).toMatchObject({ structuredContent: data });
    expect(answers[1]?.result).toMatchObject({ structuredContent: data });
  });

  it('forwards a cursor and a parameter this build does not know, and leaves them to the API', async () => {
    const data = { skill: 'find-agents', agents: [], nextCursor: null };
    reply = () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            { type: 'text', text: 'Found no agent.' },
            { type: 'text', text: JSON.stringify(data) },
          ],
          structuredContent: data,
        },
      });
    // Not a cursor the search of this build reads, and not one of its
    // parameters, as a newer API could send and take.
    const args = {
      cursor: base64urlEncode(Buffer.from('next.1.2')),
      sort: 'newest',
    };
    const { answers } = await run([call(15, 'find_agents', args)]);
    expect(requests.map((r) => r.body)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find_agents', arguments: args },
      },
    ]);
    expect(answers[0]?.result).toMatchObject({ structuredContent: data });
  });

  it('answers a refusal, a tool error or no answer from the API as one line tool errors', async () => {
    const answersTo = async (response: () => Response) => {
      reply = response;
      const { answers } = await run([call(12, 'get_trust', { agent: 'x/y' })]);
      return answers[0]?.result;
    };
    expect(
      await answersTo(() =>
        Response.json(
          { error: { code: 'rate_limited', message: 'Too many requests' } },
          { status: 429, headers: { 'Retry-After': '30' } },
        ),
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'Too many requests' }],
      isError: true,
    });
    expect(
      await answersTo(() =>
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: 'agent: Too big' }],
            isError: true,
          },
        }),
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'agent: Too big' }],
      isError: true,
    });
    expect(
      await answersTo(() =>
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32603, message: 'Internal error' },
        }),
      ),
    ).toEqual({
      content: [
        {
          type: 'text',
          text: 'the SealKeeper API could not answer the call, Internal error',
        },
      ],
      isError: true,
    });
    const down = await answersTo(() => {
      throw new TypeError('fetch failed');
    });
    expect(down).toEqual({
      content: [
        {
          type: 'text',
          text: `could not reach the SealKeeper API at ${API_URL}: fetch failed`,
        },
      ],
      isError: true,
    });
  });

  it('writes only JSON-RPC lines, answers a bad line as the API answers its body and keeps reading', async () => {
    const { out, err, answers } = await run([
      'not json',
      `{"jsonrpc":"2.0","id":1,"method":"ping","params":${'['.repeat(20)}${']'.repeat(20)}}`,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'big',
        method: 'ping',
        pad: 'x'.repeat(20_000),
      }),
      '',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
      JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'resources/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'ping' }),
    ]);
    expect(err).toBe('');
    for (const line of out.trimEnd().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(answers).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'The request nests too deep' },
      },
      MCP_TOO_LARGE,
      {
        jsonrpc: '2.0',
        id: 13,
        error: { code: -32601, message: 'Method not found' },
      },
      { jsonrpc: '2.0', id: 14, result: {} },
    ]);
  });
});

describe('mcpLines', () => {
  const read = async (parts: (string | Buffer)[], max = 8) => {
    const out: (string | null)[] = [];
    for await (const line of mcpLines(chunks(parts), max)) out.push(line);
    return out;
  };

  it('splits lines across chunks and keeps a character split between two', async () => {
    const e = Buffer.from('é', 'utf8');
    expect(
      await read([
        'ab',
        'c\nd',
        Buffer.from([e[0] ?? 0]),
        Buffer.from([e[1] ?? 0, 10]),
        'last',
      ]),
    ).toEqual(['abc', 'dé', 'last']);
  });

  it('answers a line longer than the cap as null, in one chunk or several, and reads on', async () => {
    expect(await read(['123456789\nok\n'])).toEqual([null, 'ok']);
    expect(await read(['12345', '6789', '0\nok\n'])).toEqual([null, 'ok']);
    expect(await read(['12345678\n'])).toEqual(['12345678']);
    expect(await read(['123456789'])).toEqual([null]);
  });
});
