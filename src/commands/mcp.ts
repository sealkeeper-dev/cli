// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  MCP_REQUEST_MAX_BYTES,
  MCP_TOO_LARGE,
  type McpForwardCall,
  type McpResponse,
  type McpDeps as McpServer,
  type McpToolAnswer,
  mcpAnswer,
  mcpInternalError,
  mcpParse,
  SEAL_AT_IN_FUTURE,
  SEALKEEPER_MCP_NAME,
  SEALKEEPER_MCP_PATH,
  type VerifySealInput,
  WELL_KNOWN_PATH,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { apiErrorOf, createApiClient, type RawResponse } from '../api.js';
import { commandApiUrl } from '../cli-config.js';
import { stdout } from '../output.js';
import { McpCallAnswer } from '../responses.js';
import {
  checkSealWith,
  KEYS_OFFLINE_MAX_AGE_MS,
  KeysError,
  type SealCheck,
  sealCheckAtMs,
  sealCheckLines,
} from '../seal.js';
import { VERSION } from '../version.js';
import { configApiUrl } from './check.js';

// fetch stands in for the API, now for the clock and input for standard
// input, so tests can drive all three.
export type McpDeps = {
  fetch: typeof fetch;
  now: () => number;
  input: AsyncIterable<Buffer | string>;
};

const defaultMcpDeps: McpDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  input: process.stdin,
};

// The server as initialize names it.
const SERVER_INFO = { ...SEALKEEPER_MCP_NAME, version: VERSION };

// The lines of input, each without its line feed, or null for a line longer
// than max bytes, which is dropped as it arrives so it is never held whole.
// A last line with no line feed counts too.
export async function* mcpLines(
  input: AsyncIterable<Buffer | string>,
  max: number,
): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const raw of input) {
    let chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    for (let feed = chunk.indexOf(10); feed !== -1; feed = chunk.indexOf(10)) {
      const head = chunk.subarray(0, feed);
      yield over || size + head.length > max
        ? null
        : Buffer.concat([...parts, head]).toString('utf8');
      parts = [];
      size = 0;
      over = false;
      chunk = chunk.subarray(feed + 1);
    }
    if (over) continue;
    size += chunk.length;
    if (size > max) {
      over = true;
      parts = [];
    } else if (chunk.length > 0) {
      parts.push(chunk);
    }
  }
  if (over) yield null;
  else if (size > 0) yield Buffer.concat(parts).toString('utf8');
}

// The answer to one line, null for a notification or a response, which get
// none. A throw from a tool is answered as an internal error naming only
// the message's id.
async function answerLine(
  line: string | null,
  server: McpServer,
): Promise<McpResponse | null> {
  if (line === null) return MCP_TOO_LARGE;
  const read = mcpParse(line);
  if ('answer' in read) return read.answer;
  try {
    return await mcpAnswer(read.message, server);
  } catch {
    return mcpInternalError(read.message);
  }
}

// find_agents and get_trust as the API answers them. The call goes to the
// API's MCP server with the arguments as the client sent them, which the
// API checks, and its result comes back as it is. A failure is one line,
// as a tool error.
async function forward(
  call: McpForwardCall,
  apiUrl: string,
  fetchFn: typeof fetch,
): Promise<McpToolAnswer> {
  const api = createApiClient({ apiUrl, fetch: fetchFn });
  let res: RawResponse;
  try {
    res = await api.request(SEALKEEPER_MCP_PATH, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments },
      },
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  const answer = McpCallAnswer.safeParse(res.json);
  if (res.status !== 200 || !answer.success) {
    return { error: apiErrorOf(res.status, res.json, res.headers).message };
  }
  const { result, error } = answer.data;
  const text = result?.content[0]?.text;
  if (result?.isError === true) {
    return { error: text ?? 'the SealKeeper API could not run the tool' };
  }
  if (result?.structuredContent !== undefined && text !== undefined) {
    return { text, data: result.structuredContent };
  }
  return {
    error: `the SealKeeper API could not answer the call${error === undefined ? '' : `, ${error.message}`}`,
  };
}

// verify_seal on this machine, as seal verify checks a SEAL. The data is
// what seal verify --json prints, and the text what it prints without the
// payload, then any line about where the keys came from.
async function verifyLocally(
  input: VerifySealInput,
  source: { keysFile?: string; offline: boolean; apiUrl: string },
  deps: McpDeps,
): Promise<McpToolAnswer> {
  const nowMs = deps.now();
  const atMs = sealCheckAtMs(input.at, nowMs);
  if (atMs === null) return { error: SEAL_AT_IN_FUTURE };
  const notes: string[] = [];
  let result: SealCheck;
  try {
    result = await checkSealWith(
      input.seal.trim(),
      {
        ...(source.keysFile === undefined ? {} : { keysFile: source.keysFile }),
        offline: source.offline,
        apiUrl: async () => source.apiUrl,
        fetch: deps.fetch,
        note: (line) => notes.push(line),
      },
      nowMs,
      input.agent,
      atMs,
    );
  } catch (error) {
    if (error instanceof KeysError) return { error: error.message };
    throw error;
  }
  return {
    text: [...sealCheckLines(result, nowMs, false), ...notes].join('\n'),
    data: result,
  };
}

// A local MCP server for AI tools, on stdio. It reads one JSON-RPC message a
// line from standard input and writes each answer as one line to standard
// output, which carries nothing else, and ends when standard input closes.
// Messages are answered one at a time, in the order they came. Needs no key,
// no init and no account.
export function register(
  parent: Command,
  deps: Partial<McpDeps> = {},
): Command {
  const all: McpDeps = { ...defaultMcpDeps, ...deps };
  return parent
    .command('mcp')
    .description(
      'Run a local MCP server on stdio with find_agents, get_trust and verify_seal',
    )
    .option(
      '--keys <file>',
      `verify_seal checks against a saved copy of ${WELL_KNOWN_PATH}, nothing is fetched`,
    )
    .option(
      '--offline',
      `verify_seal uses the cached keys only, and answers an error when there are none or they are more than ${KEYS_OFFLINE_MAX_AGE_MS / (24 * 3600 * 1000)} days old`,
    )
    .action(async function (
      this: Command,
      options: { keys?: string; offline?: boolean },
    ): Promise<void> {
      const apiUrl = commandApiUrl(this, await configApiUrl());
      const source = {
        ...(options.keys === undefined ? {} : { keysFile: options.keys }),
        offline: options.offline === true,
        apiUrl,
      };
      const server: McpServer = {
        serverInfo: SERVER_INFO,
        callTool: (call: { input: VerifySealInput }) =>
          verifyLocally(call.input, source, all),
        forward: (call) => forward(call, apiUrl, all.fetch),
      };
      for await (const line of mcpLines(all.input, MCP_REQUEST_MAX_BYTES)) {
        if (line !== null && line.trim() === '') continue;
        const answer = await answerLine(line, server);
        if (answer !== null) stdout(JSON.stringify(answer));
      }
    });
}
