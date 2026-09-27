// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base64urlDecode,
  decodeHeader,
  readAudience,
  UpdateAgentRequest,
  verify,
} from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askRuntime,
  detectRuntime,
  offerRuntime,
  parseRuntime,
  RUNTIME_CHOICES,
  RUNTIME_ENV,
  RUNTIME_LATER,
  RUNTIME_UNKNOWN_INTRO,
  readRuntimeAnswer,
  recordRuntimeAsked,
  runtimeMenu,
  wasAskedRuntime,
} from './agent-runtime.js';
import type { Input } from './ask.js';
import { hookCommand } from './claude-code-settings.js';
import { paths } from './config.js';
import { createKey } from './identity.js';

const API_URL = 'https://api.test';

// A terminal, or a pipe when isTTY is false, that answers with each line in
// turn, then closes.
function answeringEach(
  lines: (string | null)[],
  isTTY = true,
): Input & { reads: number } {
  const input = {
    isTTY,
    reads: 0,
    readLine: async () => {
      const line = lines[input.reads] ?? null;
      input.reads++;
      return line;
    },
  };
  return input;
}

describe('detectRuntime', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sealkeeper-runtime-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const where = () => ({
    claudeDir: () => join(dir, 'claude'),
    cwd: () => join(dir, 'project'),
  });

  // Each with the value the named release sets, see RUNTIME_ENV.
  it.each([
    ['CODEX_THREAD_ID', '0199a213-81c0-7800-8aa1-bbab2a035a53', 'codex'],
    ['CODEX_SANDBOX', 'seatbelt', 'codex'],
    ['CODEX_SANDBOX_NETWORK_DISABLED', '1', 'codex'],
    ['CURSOR_AGENT', '1', 'cursor'],
    ['GEMINI_CLI', '1', 'gemini-cli'],
    ['CLAUDECODE', '1', 'claude-code'],
  ])('reads %s=%s as %s', async (name, value, runtime) => {
    expect(await detectRuntime({ env: { [name]: value }, ...where() })).toEqual(
      { runtime, from: name },
    );
  });

  it('checks only the variables confirmed against a release, in order', () => {
    // A new hint needs a named release and a source URL in RUNTIME_ENV.
    expect(RUNTIME_ENV.map(([name]) => name)).toEqual([
      'CODEX_THREAD_ID',
      'CODEX_SANDBOX',
      'CODEX_SANDBOX_NETWORK_DISABLED',
      'CURSOR_AGENT',
      'GEMINI_CLI',
      'CLAUDECODE',
    ]);
  });

  // The Claude Code IDE extensions set CLAUDECODE in every integrated
  // terminal, so an agent started from one inherits it.
  it.each([
    ['CODEX_THREAD_ID', '0199a213-81c0-7800-8aa1-bbab2a035a53', 'codex'],
    ['CURSOR_AGENT', '1', 'cursor'],
    ['GEMINI_CLI', '1', 'gemini-cli'],
  ])(
    'offers the inner agent over CLAUDECODE, %s wins',
    async (name, value, runtime) => {
      expect(
        await detectRuntime({
          env: { CLAUDECODE: '1', [name]: value },
          ...where(),
        }),
      ).toEqual({ runtime, from: name });
    },
  );

  it('takes the first variable in the table when several are set', async () => {
    expect(
      await detectRuntime({
        env: { GEMINI_CLI: '1', CODEX_SANDBOX: 'seatbelt' },
        ...where(),
      }),
    ).toEqual({ runtime: 'codex', from: 'CODEX_SANDBOX' });
  });

  it('reads nothing into variables the runtimes do not set', async () => {
    expect(
      await detectRuntime({
        env: { CURSOR_CLI: '1', CODEX_HOME: '/tmp/codex', GEMINI_API_KEY: 'x' },
        ...where(),
      }),
    ).toBeNull();
  });

  it('ignores an empty variable', async () => {
    expect(
      await detectRuntime({ env: { CLAUDECODE: ' ' }, ...where() }),
    ).toBeNull();
  });

  it('reads SealKeeper hooks in the Claude Code settings', async () => {
    await mkdir(join(dir, 'claude'), { recursive: true });
    await writeFile(
      join(dir, 'claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: hookCommand(
                    '/usr/local/bin/node',
                    '/usr/local/lib/node_modules/sealkeeper/dist/index.js',
                  ),
                },
              ],
            },
          ],
        },
      }),
    );
    expect(await detectRuntime({ env: {}, ...where() })).toEqual({
      runtime: 'claude-code',
      from: 'the Claude Code hooks',
    });
    // The environment says what runs init now, so it wins.
    expect(
      await detectRuntime({ env: { GEMINI_CLI: '1' }, ...where() }),
    ).toMatchObject({ runtime: 'gemini-cli' });
  });

  it('is null with nothing to go on, a Claude Code folder alone included', async () => {
    await mkdir(join(dir, 'claude'), { recursive: true });
    await writeFile(join(dir, 'claude', 'settings.json'), '{}');
    expect(await detectRuntime({ env: {}, ...where() })).toBeNull();
  });
});

describe('parseRuntime and readRuntimeAnswer', () => {
  it('parses every runtime id, in any case', () => {
    expect(parseRuntime('claude-code')).toBe('claude-code');
    expect(parseRuntime(' Codex ')).toBe('codex');
    expect(parseRuntime('unknown')).toBe('unknown');
    expect(parseRuntime('cursor-agent')).toBeNull();
    expect(parseRuntime('')).toBeNull();
  });

  it('reads a number from the menu, an id or a label, and Enter as skip', () => {
    expect(readRuntimeAnswer('1')).toBe('claude-code');
    expect(readRuntimeAnswer(String(RUNTIME_CHOICES.length))).toBe('other');
    expect(readRuntimeAnswer('gemini-cli')).toBe('gemini-cli');
    expect(readRuntimeAnswer('Gemini CLI')).toBe('gemini-cli');
    expect(readRuntimeAnswer('  ')).toBeNull();
    expect(readRuntimeAnswer('0')).toBe('unclear');
    expect(readRuntimeAnswer('99')).toBe('unclear');
    expect(readRuntimeAnswer('unknown')).toBe('unclear');
    expect(readRuntimeAnswer('gpt')).toBe('unclear');
  });

  it('lists every choice but unknown in the menu', () => {
    expect(RUNTIME_CHOICES).not.toContain('unknown');
    expect(runtimeMenu()).toBe(
      '1 Claude Code  2 Codex  3 Cursor  4 Gemini CLI  5 OpenClaw  6 Mastra  7 Other',
    );
  });
});

describe('askRuntime', () => {
  let err: string;
  beforeEach(() => {
    err = '';
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('NO_COLOR', '');
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    vi.mocked(process.stderr.write).mockRestore();
    vi.unstubAllEnvs();
  });

  const claude = { runtime: 'claude-code', from: 'CLAUDECODE' } as const;

  it('takes the detected runtime on Enter', async () => {
    const input = answeringEach(['']);
    expect(await askRuntime(input, claude)).toBe('claude-code');
    expect(err).toContain(
      'This agent runs in Claude Code, from CLAUDECODE. Right? [Y/n] ',
    );
    expect(input.reads).toBe(1);
  });

  it('goes on to the list on n', async () => {
    const input = answeringEach(['n', '2']);
    expect(await askRuntime(input, claude)).toBe('codex');
    expect(err).toContain('What does this agent run in?\n');
  });

  it('asks the list again on an unclear answer, then skips', async () => {
    const input = answeringEach(['x', 'y', 'z']);
    expect(await askRuntime(input, null)).toBeNull();
    expect(input.reads).toBe(3);
    expect(err).toContain('Please answer with a number from 1 to 7. ');
  });

  it('skips on a closed input', async () => {
    expect(await askRuntime(answeringEach([]), claude)).toBeNull();
    expect(await askRuntime(answeringEach([]), null)).toBeNull();
  });
});

describe('offerRuntime', () => {
  let home: string;
  let agentId: string;
  let patches: unknown[];
  let reply: Response | null;
  let out: string[];
  let info: string[];

  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url !== `${API_URL}/v1/agents/${agentId}` || init?.method !== 'PATCH') {
      throw new TypeError('fetch failed');
    }
    const { envelope } = JSON.parse(String(init.body)) as { envelope: string };
    const { kid } = decodeHeader(envelope);
    const payload = readAudience(
      (await verify(envelope, base64urlDecode(kid))).payload,
      [API_URL],
    ).payload;
    patches.push(UpdateAgentRequest.parse(payload));
    if (reply !== null) return reply;
    return Response.json({
      id: agentId,
      name: 'scout',
      version: '1.0.0',
      operator: { login: 'alice' },
      createdAt: '2026-09-23T10:00:00.000Z',
      runtime: (payload as { runtime: string }).runtime,
    });
  }) as typeof fetch;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-offer-runtime-'));
    vi.stubEnv('SEALKEEPER_HOME', home);
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('NO_COLOR', '');
    ({ agentId } = await createKey());
    patches = [];
    reply = null;
    out = [];
    info = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.mocked(process.stderr.write).mockRestore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function offer(input: Input | undefined, runtime: string | undefined) {
    const readRuntime = vi.fn(async () => runtime);
    const done = offerRuntime({
      config: { agentId, apiUrl: API_URL },
      readRuntime,
      input,
      fetch: fetchFn,
      report: {
        ok: (text) => out.push(text),
        info: (text) => info.push(text),
      },
      claudeDir: () => join(home, 'claude'),
      cwd: () => join(home, 'project'),
      env: { CLAUDECODE: '1' },
    });
    return { done, readRuntime };
  }

  it('asks an unknown agent once, sends the signed PATCH and never asks again', async () => {
    const first = offer(answeringEach(['']), 'unknown');
    await first.done;
    expect(info).toEqual([RUNTIME_UNKNOWN_INTRO]);
    expect(out).toEqual(['Runtime set to Claude Code']);
    expect(patches).toEqual([
      { runtime: 'claude-code', issuedAt: expect.any(String) },
    ]);
    expect(await wasAskedRuntime(agentId)).toBe(true);

    const input = answeringEach(['']);
    const second = offer(input, 'unknown');
    await second.done;
    expect(input.reads).toBe(0);
    expect(second.readRuntime).not.toHaveBeenCalled();
    expect(patches).toHaveLength(1);
  });

  it('records a skip and sends nothing', async () => {
    await offer(answeringEach(['n', '']), 'unknown').done;
    expect(patches).toEqual([]);
    expect(info).toEqual([RUNTIME_UNKNOWN_INTRO, RUNTIME_LATER]);
    expect(await wasAskedRuntime(agentId)).toBe(true);
  });

  it('asks nothing without a terminal, and reads nothing', async () => {
    const input = answeringEach([''], false);
    const { done, readRuntime } = offer(input, 'unknown');
    await done;
    expect(input.reads).toBe(0);
    expect(readRuntime).not.toHaveBeenCalled();
    expect(await wasAskedRuntime(agentId)).toBe(false);
  });

  it('asks nothing and records nothing when the API does not say', async () => {
    const input = answeringEach(['']);
    await offer(input, undefined).done;
    expect(input.reads).toBe(0);
    expect(info).toEqual([]);
    expect(await wasAskedRuntime(agentId)).toBe(false);
  });

  it('asks nothing when the API has a runtime, and reads it only once', async () => {
    const input = answeringEach(['']);
    await offer(input, 'codex').done;
    expect(input.reads).toBe(0);
    expect(info).toEqual([]);
    expect(await wasAskedRuntime(agentId)).toBe(true);
    const second = offer(answeringEach(['']), 'unknown');
    await second.done;
    expect(second.readRuntime).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
  });

  it('asks a new agent on the same machine again', async () => {
    await recordRuntimeAsked('another-agent');
    expect(await wasAskedRuntime(agentId)).toBe(false);
    await recordRuntimeAsked(agentId);
    expect(await wasAskedRuntime(agentId)).toBe(true);
  });

  it('says a refusal on one line and still counts as asked', async () => {
    reply = Response.json(
      { error: { code: 'stale_runtime', message: 'stale' } },
      { status: 409 },
    );
    await offer(answeringEach(['']), 'unknown').done;
    expect(out).toEqual([]);
    expect(info[1]).toBe(
      'runtime not set, a newer runtime change of this agent is already stored. Run npx sealkeeper agent runtime claude-code to try again.',
    );
    expect(await wasAskedRuntime(agentId)).toBe(true);
  });

  it('treats a broken marker file as never asked', async () => {
    await writeFile(paths().runtimeQuestion, 'not json');
    expect(await wasAskedRuntime(agentId)).toBe(false);
  });
});
