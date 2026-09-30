// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partHash } from '@sealkeeper/schema';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Paths, paths, writeConfig } from './config.js';
import { observeParts, replaceSource } from './fingerprint.js';
import { observeClaudeCode } from './fingerprint-claude-code.js';
import { modelSetContent } from './fingerprint-content.js';
import { createObserver } from './fingerprint-observer.js';
import { declaredModel, readModelSet, writeModelSet } from './model-name.js';
import { modelNameOf, toolNameOf } from './names.js';
import { createProgram } from './program.js';

// VOU-566. The model name the next sync declares. A name an adapter reads
// wins over one set by hand, which is for a runtime with no adapter.

const AGENT_ID = 'A'.repeat(43);
const NOW = 1_790_812_800;

let home: string;
let p: Paths;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sealkeeper-model-'));
  p = paths(home);
  vi.stubEnv('SEALKEEPER_HOME', home);
  vi.stubEnv('CLAUDECODE', '');
  await writeConfig(
    {
      agentId: AGENT_ID,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      registeredAt: '2026-09-23T08:00:00Z',
    },
    p,
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const declared = () =>
  declaredModel({ paths: p, env: {}, now: () => NOW * 1000 });

// fingerprint-sources.json as written.
const readSources = async (): Promise<
  Record<string, { model_name?: string; model_set?: string } | undefined>
> => JSON.parse(await readFile(p.fingerprintSources, 'utf8'));

describe('declaredModel', () => {
  it('is null when no adapter read one and none is set', async () => {
    expect(await declared()).toBeNull();
    expect(await readModelSet(p)).toBeNull();
  });

  it('takes the name set by hand', async () => {
    await writeModelSet('gpt-4.1', p);
    expect(await declared()).toEqual({ name: 'gpt-4.1', source: 'set' });
  });

  it("takes the chosen adapter's name over the one set by hand", async () => {
    await writeModelSet('gpt-4.1', p);
    await observeParts('mastra', { model_name: 'claude-opus-4-5' }, p, NOW);
    expect(await declared()).toEqual({
      name: 'claude-opus-4-5',
      source: 'mastra',
    });
    // The Claude Code hooks replace their source whole, the name with it.
    await replaceSource('claude-code', { model_name: 'opus' }, p, NOW + 1);
    expect(await declared()).toEqual({ name: 'opus', source: 'claude-code' });
  });

  it('falls back to the name set by hand when the adapter has none, a bad one or a stale one', async () => {
    await writeModelSet('gpt-4.1', p);
    await observeParts('openclaw', {}, p, NOW);
    expect((await declared())?.source).toBe('set');
    await observeParts('openclaw', { model_name: 'anthropic/' }, p, NOW);
    expect((await declared())?.source).toBe('set');
    await observeParts('openclaw', { model_name: 'gpt-5' }, p, NOW - 8 * 86400);
    expect((await declared())?.source).toBe('set');
  });

  it('keeps the hashes of a source whose name does not read', async () => {
    await writeFile(
      p.fingerprintSources,
      JSON.stringify({ v: 1, mastra: { at: NOW, model_name: 42 } }),
    );
    expect(await declared()).toBeNull();
    await writeModelSet('gpt-4.1', p);
    expect(await declared()).toEqual({ name: 'gpt-4.1', source: 'set' });
  });

  it('reads a model.json that does not parse as none', async () => {
    await writeFile(p.model, '{"v":1,"name":"gpt 4"}\n');
    expect(await readModelSet(p)).toBeNull();
    await writeFile(p.model, 'not json');
    expect(await readModelSet(p)).toBeNull();
  });
});

// An AWS ARN names the operator's account and region, so only its part
// after the last slash is declared, and an id too long for a name is never
// cut short into one.
const ACCOUNT = '123456789012';
const PROFILE_ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0`;
const APP_PROFILE_ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:application-inference-profile/abcd1234efgh`;

describe('modelNameOf', () => {
  it('keeps an id that is a name, through toolNameOf', () => {
    expect(modelNameOf('claude-opus-4-5')).toBe('claude-opus-4-5');
    expect(modelNameOf(' openai/gpt-4.1 ')).toBe('openai/gpt-4.1');
    expect(modelNameOf('opus[1m]')).toBe('opus-1m-');
  });

  it('declares only the part after the last slash of an ARN or a long id', () => {
    expect(modelNameOf(PROFILE_ARN)).toBe(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    );
    expect(modelNameOf(APP_PROFILE_ARN)).toBe('abcd1234efgh');
    expect(modelNameOf(`org/${'m'.repeat(70)}/gpt-4.1`)).toBe('gpt-4.1');
    for (const id of [PROFILE_ARN, APP_PROFILE_ARN]) {
      expect(modelNameOf(id)).not.toContain(ACCOUNT);
      expect(modelNameOf(id)).not.toContain('us-east-1');
    }
  });

  it('declares none when what is left is still an ARN, too long or not a name', () => {
    for (const id of [
      `arn:aws:bedrock:us-east-1:${ACCOUNT}:model`,
      'a'.repeat(65),
      `x/${'a'.repeat(65)}`,
      `${PROFILE_ARN}/`,
      'sealkeeper-verified',
      '',
      42,
      undefined,
    ]) {
      expect(modelNameOf(id), String(id)).toBeNull();
    }
  });
});

describe('the adapters declare modelNameOf of the id they read', () => {
  it('Claude Code declares no account id from a Bedrock ARN and hashes the id as before', async () => {
    const where = {
      cwd: home,
      env: { ANTHROPIC_MODEL: APP_PROFILE_ARN, PATH: '' },
      claudeDir: join(home, 'no-claude'),
      home,
    };
    await observeClaudeCode(AGENT_ID, where, p);
    const text = await readFile(p.fingerprintSources, 'utf8');
    expect(text).not.toContain(ACCOUNT);
    const source = (await readSources())['claude-code'];
    expect(source?.model_name).toBe('abcd1234efgh');
    // The model part hashes the whole id through toolNameOf, as before.
    expect(source?.model_set).toBe(
      await partHash(
        AGENT_ID,
        modelSetContent([toolNameOf(APP_PROFILE_ARN) as string]),
      ),
    );
    expect((await declared())?.name).toBe('abcd1234efgh');
  });

  // A Mastra agent that plans with one model and runs its steps with
  // another names the first for the life of each process, so every sync
  // declares the same name and the API records no change of model.
  it('an observer that sees two models declares the first, process after process', async () => {
    for (let run = 0; run < 2; run++) {
      const observer = createObserver('mastra', () => p);
      await observer.model('gpt-4.1', 'gpt-4.1');
      expect((await declared())?.name).toBe('gpt-4.1');
      await observer.model('claude-sonnet-4-5', 'claude-sonnet-4-5');
      await observer.settled();
      expect((await declared())?.name).toBe('gpt-4.1');
      // Both ids are in the model part.
      expect((await readSources()).mastra?.model_set).toBe(
        await partHash(
          AGENT_ID,
          modelSetContent(['gpt-4.1', 'claude-sonnet-4-5']),
        ),
      );
    }
  });

  it('an observer whose first id gives no name clears the name of an earlier process', async () => {
    const before = createObserver('openclaw', () => p);
    await before.model('gpt-4.1', 'gpt-4.1');
    expect((await declared())?.name).toBe('gpt-4.1');
    const after = createObserver('openclaw', () => p);
    await after.model(toolNameOf(APP_PROFILE_ARN) as string, null);
    await after.model('gpt-4.1', 'gpt-4.1');
    await after.settled();
    expect((await readSources()).openclaw?.model_name).toBeUndefined();
    expect(await declared()).toBeNull();
  });
});

type RunResult = { code: number; out: string; err: string };

function throwOnExit(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) throwOnExit(sub);
}

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
  try {
    await program.parseAsync(args, { from: 'user' });
    return { code: 0, out, err };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { code: error.exitCode, out, err };
    }
    throw error;
  } finally {
    vi.restoreAllMocks();
  }
}

describe('model set and model show', () => {
  it('shows none, sets a name and shows it, as text and as JSON', async () => {
    const none = await run('model', 'show');
    expect(none.code).toBe(0);
    expect(none.out).toContain('no model name, sync sends none');

    const set = await run('model', 'set', 'openai/gpt-4.1');
    expect(set.code).toBe(0);
    expect(set.out).toBe(
      'openai/gpt-4.1 set, sent as text with the next sync\n',
    );
    expect(await readModelSet(p)).toBe('openai/gpt-4.1');

    const shown = await run('model', 'show');
    expect(shown.out).toMatch(/^openai\/gpt-4\.1, set with .*model set\n$/);
    const json = await run('model', 'show', '--json');
    expect(JSON.parse(json.out)).toEqual({
      model: 'openai/gpt-4.1',
      source: 'set',
      set: 'openai/gpt-4.1',
    });
  });

  it('says the adapter name wins over the one set by hand', async () => {
    await observeParts('mastra', { model_name: 'claude-opus-4-5' }, p);
    const set = await run('model', 'set', 'gpt-4.1');
    expect(set.out).toBe(
      'gpt-4.1 set. The Mastra adapter reads claude-opus-4-5, which wins\n',
    );
    const shown = await run('model', 'show');
    expect(shown.out).toBe(
      "claude-opus-4-5, read by the Mastra adapter\ngpt-4.1 is set by hand, and the adapter's name wins\n",
    );
  });

  it('refuses a name the API would refuse and keeps the one before', async () => {
    await run('model', 'set', 'gpt-4.1');
    for (const bad of [
      'gpt 4',
      'a'.repeat(65),
      'anthropic/',
      '',
      'sealkeeper-verified',
    ]) {
      const res = await run('model', 'set', bad);
      expect(res.code, bad).toBe(1);
      expect(res.err).toContain('a model name is 1 to 64 letters');
    }
    expect(await readModelSet(p)).toBe('gpt-4.1');
  });

  it('needs init', async () => {
    await rm(p.config);
    const res = await run('model', 'set', 'gpt-4.1');
    expect(res.code).toBe(1);
    expect(res.err).toContain('not initialised');
    expect(await readModelSet(p)).toBeNull();
  });
});
