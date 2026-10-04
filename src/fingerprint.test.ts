// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Fingerprint,
  fingerprintHash,
  partHash,
} from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  mastraVersion,
  openClawVersion,
  toolLine,
} from './adapter-fingerprint.js';
import {
  backgroundSync,
  resetBackgroundSyncThrottle,
} from './background-sync.js';
import { handleHook } from './claude-code.js';
import { HOOK_EVENTS, RETIRED_HOOK_EVENTS } from './claude-code-settings.js';
import { type Paths, paths, writeConfig } from './config.js';
import {
  type CapturedParts,
  captureParts,
  currentFingerprint,
  FINGERPRINT_WINDOW,
  NOTHING_DECLARED,
  observeParts,
  partsFromCaptures,
  recordCapture,
  refreshFingerprint,
  replaceSource,
  SOURCE_MAX_AGE_SECONDS,
} from './fingerprint.js';
import { captureClaudeCode, projectDir } from './fingerprint-claude-code.js';
import { stableJson } from './fingerprint-content.js';
import { sealKeeperSession, withSealKeeper } from './mastra.js';
import { declaredModel } from './model-name.js';
import { sealKeeperPlugin } from './openclaw.js';

const AGENT = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
// 1 October 2026, Unix seconds.
const NOW = 1_790_812_800;

let root: string;
let p: Paths;

async function initialise(home: Paths = p): Promise<void> {
  await writeConfig(
    {
      agentId: AGENT,
      operatorLogin: 'alice',
      name: 'scout',
      version: '1.0.0',
      registeredAt: '2026-09-23T08:00:00Z',
      autoSync: true,
    },
    home,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sealkeeper-fingerprint-'));
  p = paths(join(root, 'home'));
  await mkdir(p.home, { recursive: true });
  await initialise();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const h = (text: string) => partHash(AGENT, text);

async function parts(
  overrides: Partial<Record<keyof CapturedParts, string>>,
): Promise<CapturedParts> {
  const out = { ...NOTHING_DECLARED };
  for (const [name, text] of Object.entries(overrides)) {
    out[name as keyof CapturedParts] = await h(text);
  }
  return out;
}

async function record(
  captured: CapturedParts,
  at: number,
): Promise<Fingerprint> {
  const fp = await recordCapture(p, captured, at);
  if (fp === null) throw new Error('nothing recorded');
  return fp;
}

describe('the unstable rule', () => {
  const capture = async (tools: string, at: number) => ({
    at,
    parts: await parts({ tools, model_set: 'claude-sonnet-4-5' }),
  });

  it('marks a part unstable after five differing captures in a row', async () => {
    const captures = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((t, i) => capture(t, i)),
    );
    const result = partsFromCaptures(captures);
    expect(result.tools).toBe('unstable');
    // The model did not change, so it stays declared.
    expect(result.model_set).toEqual({ hash: await h('claude-sonnet-4-5') });
    expect(result.prompt).toBe('not_declared');
  });

  it('counts a part that flips back and forth, since each capture differs from the last', async () => {
    const captures = await Promise.all(
      ['a', 'b', 'a', 'b', 'a'].map((t, i) => capture(t, i)),
    );
    expect(partsFromCaptures(captures).tools).toBe('unstable');
  });

  it('keeps a part declared after four changes, or when two captures in a row match', async () => {
    const four = await Promise.all(
      ['a', 'b', 'c', 'd'].map((t, i) => capture(t, i)),
    );
    expect(partsFromCaptures(four).tools).toEqual({ hash: await h('d') });
    const repeat = await Promise.all(
      ['a', 'b', 'c', 'c', 'd'].map((t, i) => capture(t, i)),
    );
    expect(partsFromCaptures(repeat).tools).toEqual({ hash: await h('d') });
  });

  it('reads unstable in fingerprint.json after five differing captures and ends at the next match', async () => {
    for (const [i, tools] of ['a', 'b', 'c', 'd'].entries()) {
      const fp = await record(await parts({ tools }), 100 + i);
      expect(fp.parts.tools).toEqual({ hash: await h(tools) });
    }
    const fifth = await record(await parts({ tools: 'e' }), 104);
    expect(fifth.parts.tools).toBe('unstable');
    expect(fifth.hash).toBe(await fingerprintHash(fifth.parts));
    const sixth = await record(await parts({ tools: 'f' }), 105);
    expect(sixth.parts.tools).toBe('unstable');
    const settled = await record(await parts({ tools: 'f' }), 106);
    expect(settled.parts.tools).toEqual({ hash: await h('f') });

    const file = JSON.parse(await readFile(p.fingerprint, 'utf8'));
    expect(file.captures).toHaveLength(FINGERPRINT_WINDOW);
    expect(file.captures.map((c: { at: number }) => c.at)).toEqual([
      102, 103, 104, 105, 106,
    ]);
    expect(await currentFingerprint(p)).toEqual(settled);
  });
});

describe('fingerprint.json', () => {
  it('reads as null when missing or broken, and a broken file starts a new window', async () => {
    expect(await currentFingerprint(p)).toBeNull();
    await writeFile(p.fingerprint, '{ not json');
    expect(await currentFingerprint(p)).toBeNull();
    expect(await record(NOTHING_DECLARED, 7)).toEqual({
      parts: {
        model_set: 'not_declared',
        prompt: 'not_declared',
        tools: 'not_declared',
        framework: 'not_declared',
      },
      hash: 'GupgdwZ9bk92irIz_drScpdSxs6gX2CrSEL9A-ndiHI',
      captured_at: 7,
    });
  });

  it('is never written, and no home is made, before init', async () => {
    const before = paths(join(root, 'not-yet'));
    expect(await refreshFingerprint({ paths: before })).toBeNull();
    await expect(readdir(before.home)).rejects.toThrow();
    const bare = paths(join(root, 'bare'));
    await mkdir(bare.home);
    expect(await recordCapture(bare, NOTHING_DECLARED, 1)).toBeNull();
    expect(await readdir(bare.home)).toEqual([]);
  });
});

describe('Claude Code capture', () => {
  let project: string;
  let claudeDir: string;
  const EXEC = '/opt/claude/versions/2.1.283';

  beforeEach(async () => {
    project = join(root, 'work', 'research-bot');
    claudeDir = join(root, 'user-claude');
    await mkdir(join(project, '.claude'), { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['secret-arg'] },
          linear: { url: 'https://example.com/mcp' },
        },
      }),
    );
    await writeFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['mcp__github__create_issue', 'Bash(ls)'] },
      }),
    );
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'claude-sonnet-4-5' }),
    );
  });

  const where = (env: NodeJS.ProcessEnv = {}) => ({
    cwd: project,
    env: { CLAUDE_CODE_EXECPATH: EXEC, ...env },
    claudeDir,
    home: root,
  });

  it('hashes the model, the MCP servers and tools, and the version for the agent, and declares no prompt', async () => {
    expect(await captureClaudeCode(AGENT, where())).toEqual({
      model_set: await h('claude-sonnet-4-5'),
      prompt: 'not_declared',
      tools: await h('mcp:github\nmcp:linear\ntool:mcp__github__create_issue'),
      framework: 'fZr0sK5GawVx1whZ8jTP7ZEHoteH22nOQS0fH4-UeOw',
    });
  });

  it('reads server names from ~/.claude.json, user and local to the project, never their settings', async () => {
    await writeFile(
      join(root, '.claude.json'),
      JSON.stringify({
        mcpServers: { memory: { command: 'secret-cmd', env: { K: 'v' } } },
        projects: {
          [project]: { mcpServers: { sentry: { args: ['secret'] } } },
          [join(root, 'other')]: { mcpServers: { elsewhere: {} } },
        },
      }),
    );
    expect((await captureClaudeCode(AGENT, where())).tools).toBe(
      await h(
        'mcp:github\nmcp:linear\nmcp:memory\nmcp:sentry\ntool:mcp__github__create_issue',
      ),
    );
  });

  it('reads the project from a folder below it and leaves out disabled servers', async () => {
    const sub = join(project, 'packages', 'core');
    await mkdir(sub, { recursive: true });
    expect(await projectDir(sub, root)).toBe(project);
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ disabledMcpjsonServers: ['linear'] }),
    );
    const got = await captureClaudeCode(AGENT, { ...where(), cwd: sub });
    expect(got.tools).toBe(
      await h('mcp:github\ntool:mcp__github__create_issue'),
    );
  });

  it('takes ANTHROPIC_MODEL first, then a settings env block, then the nearest model', async () => {
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ model: 'claude-opus-4-1' }),
    );
    expect((await captureClaudeCode(AGENT, where())).model_set).toBe(
      await h('claude-opus-4-1'),
    );
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-haiku-4-5' } }),
    );
    expect((await captureClaudeCode(AGENT, where())).model_set).toBe(
      await h('claude-haiku-4-5'),
    );
    expect(
      (
        await captureClaudeCode(
          AGENT,
          where({ ANTHROPIC_MODEL: 'alice-model' }),
        )
      ).model_set,
    ).toBe(await h('alice-model'));
  });

  it('declares nothing it cannot see', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    const got = await captureClaudeCode(AGENT, {
      cwd: empty,
      env: { PATH: '' },
      claudeDir: join(root, 'none'),
      home: root,
    });
    expect(got).toEqual(NOTHING_DECLARED);
  });

  it('reads the version from AI_AGENT, then from the claude binary on PATH', async () => {
    const version = async (env: NodeJS.ProcessEnv) =>
      (await captureClaudeCode(AGENT, { ...where(), env })).framework;
    expect(
      await version({ PATH: '', AI_AGENT: 'claude-code_2-1-290_agent' }),
    ).toBe(await h('claude-code@2.1.290'));

    // A native install links claude to versions/<version>.
    const versions = join(root, 'share', 'claude', 'versions');
    const bin = join(root, 'bin');
    await mkdir(versions, { recursive: true });
    await mkdir(bin);
    await writeFile(join(versions, '2.1.300'), '');
    await symlink(join(versions, '2.1.300'), join(bin, 'claude'));
    expect(await version({ PATH: bin })).toBe(await h('claude-code@2.1.300'));

    // An npm install links claude to cli.js in the package.
    const pkg = join(
      root,
      'lib',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
    );
    const npmBin = join(root, 'npm-bin');
    await mkdir(pkg, { recursive: true });
    await mkdir(npmBin);
    await writeFile(join(pkg, 'cli.js'), '');
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.12' }),
    );
    await symlink(join(pkg, 'cli.js'), join(npmBin, 'claude'));
    expect(await version({ PATH: npmBin })).toBe(await h('claude-code@2.1.12'));
  });

  describe('through the hooks', () => {
    beforeEach(() => {
      vi.stubEnv('CLAUDE_CODE_EXECPATH', EXEC);
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
      vi.stubEnv('ANTHROPIC_MODEL', '');
    });

    const hook = (
      event: string,
      _session: string,
      model: string | null = null,
    ) =>
      handleHook(
        { event, cwd: project, model },
        { fetch: (async () => Response.json({})) as typeof fetch, paths: p },
      );

    // sync and run may run from any folder. Only the hook payload's cwd
    // picks the project.
    const refresh = async () => {
      const fp = await refreshFingerprint({ paths: p, env: {} });
      if (fp === null) throw new Error('nothing recorded');
      return fp;
    };

    it('changes only the tools part when .mcp.json changes', async () => {
      await hook('SessionStart', 's1');
      const before = await refresh();
      expect(before.parts.tools).toEqual({
        hash: await h('mcp:github\nmcp:linear\ntool:mcp__github__create_issue'),
      });
      expect(before.parts.model_set).toEqual({
        hash: await h('claude-sonnet-4-5'),
      });
      expect(before.parts.framework).toEqual({
        hash: await h('claude-code@2.1.283'),
      });

      // The same session again from a refresh does not change anything.
      expect((await refresh()).parts).toEqual(before.parts);

      await writeFile(
        join(project, '.mcp.json'),
        JSON.stringify({ mcpServers: { github: {}, linear: {}, sentry: {} } }),
      );
      // Nothing changes until a hook reads the project again.
      expect((await refresh()).parts).toEqual(before.parts);
      await hook('SessionStart', 's2');
      const after = await refresh();
      expect(after.parts.tools).toEqual({
        hash: await h(
          'mcp:github\nmcp:linear\nmcp:sentry\ntool:mcp__github__create_issue',
        ),
      });
      expect({ ...after.parts, tools: null }).toEqual({
        ...before.parts,
        tools: null,
      });
    });

    // VOU-451, VOU-627. The hooks are SessionStart and SessionEnd. A tool
    // event or Stop from an older install reads nothing.
    it('is captured by the two hooks install writes, and by no retired hook', async () => {
      expect(HOOK_EVENTS).toEqual(['SessionStart', 'SessionEnd']);
      for (const event of RETIRED_HOOK_EVENTS) await hook(event, 's1');
      await expect(readFile(p.fingerprintSources)).rejects.toThrow();

      await hook('SessionStart', 's1');
      const start = await refresh();
      expect(start.parts.tools).toEqual({
        hash: await h('mcp:github\nmcp:linear\ntool:mcp__github__create_issue'),
      });
      await writeFile(
        join(project, '.mcp.json'),
        JSON.stringify({ mcpServers: { sentry: {} } }),
      );
      await hook('Stop', 's1');
      expect((await refresh()).parts).toEqual(start.parts);
      await hook('SessionEnd', 's1');
      expect((await refresh()).parts.tools).toEqual({
        hash: await h('mcp:sentry\ntool:mcp__github__create_issue'),
      });
    });

    // VOU-566. The one model id goes as text, the model name sync
    // declares. Everything else stays a hash.
    it('keeps hashes and the model name only in the sources file', async () => {
      await hook('SessionStart', 's1');
      const text = await readFile(p.fingerprintSources, 'utf8');
      for (const secret of ['github', '2.1.283', 'secret']) {
        expect(text).not.toContain(secret);
      }
      const source = JSON.parse(text)['claude-code'];
      expect(source.model_name).toBe('claude-sonnet-4-5');
      expect(text.split('claude-sonnet-4-5')).toHaveLength(2);
    });

    // VOU-614. SessionStart names the model Claude Code runs. It wins over
    // the settings, SessionEnd and a SessionStart that name none keep it,
    // and the last one named wins.
    it('declares the model SessionStart names over the settings, and keeps it', async () => {
      const declared = async () =>
        (await declaredModel({ paths: p, env: {} }))?.name;
      await hook('SessionStart', 's1', 'claude-opus-5');
      const start = await refresh();
      expect(start.parts.model_set).toEqual({ hash: await h('claude-opus-5') });
      expect(await declared()).toBe('claude-opus-5');

      await hook('SessionEnd', 's1');
      expect((await refresh()).parts.model_set).toEqual(start.parts.model_set);
      await hook('SessionStart', 's2');
      expect(await declared()).toBe('claude-opus-5');

      // A second session on another model, the last one seen wins.
      await hook('SessionStart', 's3', 'claude-haiku-4-5');
      expect(await declared()).toBe('claude-haiku-4-5');
      expect((await refresh()).parts.model_set).toEqual({
        hash: await h('claude-haiku-4-5'),
      });

      // A name that is not a model name drops, the id is still hashed.
      await hook('SessionStart', 's4', 'sealkeeper-verified');
      expect(await declared()).toBeUndefined();
    });

    it('reads the settings when no model was ever reported', async () => {
      await hook('SessionStart', 's1', '');
      await hook('SessionEnd', 's1');
      expect((await refresh()).parts.model_set).toEqual({
        hash: await h('claude-sonnet-4-5'),
      });
    });
  });
});

describe('choosing a source', () => {
  const at = (days: number) => NOW - days * 24 * 60 * 60;
  const capture = (env: NodeJS.ProcessEnv = {}) =>
    captureParts({ paths: p, env, now: () => NOW * 1000 });

  beforeEach(async () => {
    await replaceSource('claude-code', { tools: await h('cc') }, p, at(2));
    await observeParts('mastra', { tools: await h('mastra') }, p, at(1));
  });

  it('takes the newest fresh source when no runtime is declared', async () => {
    expect((await capture()).tools).toBe(await h('mastra'));
  });

  it('takes the source of the declared runtime over a newer one', async () => {
    expect((await capture({ CLAUDECODE: '1' })).tools).toBe(await h('cc'));
    const config = JSON.parse(await readFile(p.config, 'utf8'));
    await writeFile(
      p.config,
      JSON.stringify({ ...config, runtime: 'claude-code' }),
    );
    expect((await capture()).tools).toBe(await h('cc'));
  });

  it('ignores a source older than 7 days, even the declared one', async () => {
    await replaceSource(
      'claude-code',
      { tools: await h('cc') },
      p,
      NOW - SOURCE_MAX_AGE_SECONDS - 1,
    );
    expect((await capture({ CLAUDECODE: '1' })).tools).toBe(await h('mastra'));
    await observeParts('mastra', {}, p, at(8));
    expect(await capture({ CLAUDECODE: '1' })).toEqual(NOTHING_DECLARED);
  });

  it('keeps the parts an adapter did not give, and a Claude Code capture replaces all', async () => {
    await observeParts('mastra', { framework: await h('f') }, p, at(0));
    expect(await capture()).toEqual({
      ...NOTHING_DECLARED,
      tools: await h('mastra'),
      framework: await h('f'),
    });
    await replaceSource('claude-code', { model_set: await h('m') }, p, at(0));
    expect(await capture({ CLAUDECODE: '1' })).toEqual({
      ...NOTHING_DECLARED,
      model_set: await h('m'),
    });
  });

  it('writes nothing into a home without a config', async () => {
    const gone = paths(join(root, 'gone'));
    await observeParts('mastra', { tools: await h('t') }, gone);
    await replaceSource('claude-code', { tools: await h('t') }, gone);
    await expect(readFile(gone.fingerprintSources)).rejects.toThrow();
  });
});

describe('the Mastra adapter', () => {
  beforeEach(() => {
    vi.stubEnv('SEALKEEPER_HOME', p.home);
  });

  const sources = async () =>
    JSON.parse(await readFile(p.fingerprintSources, 'utf8')).mastra;

  it('hashes the names and schemas of the tools passed in and the model ids of steps', async () => {
    const add = {
      id: 'add',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async () => 1,
    };
    const lookup = { id: 'lookup', execute: async () => 2 };
    withSealKeeper({ add, lookup });
    const tools = await h(
      [toolLine('add', add), toolLine('lookup', lookup)].sort().join('\n'),
    );
    await vi.waitFor(async () => expect((await sources())?.tools).toBe(tools));

    const session = sealKeeperSession('s1');
    await session.onStepFinish({ response: { modelId: 'gpt-alice' } });
    await vi.waitFor(async () =>
      expect((await sources())?.model_set).toBe(await h('gpt-alice')),
    );
    await session.end();
    const text = await readFile(p.fingerprintSources, 'utf8');
    // The model id as the model name, as text (VOU-566), and nothing else.
    expect((await sources())?.model_name).toBe('gpt-alice');
    expect(text.split('gpt-alice')).toHaveLength(2);
    expect(text).not.toContain('lookup');
  });

  it('writes a schema the same whatever its key order', () => {
    const a = {
      id: 'x',
      inputSchema: { type: 'object', properties: { b: {}, a: {} } },
    };
    const b = {
      id: 'x',
      inputSchema: { properties: { a: {}, b: {} }, type: 'object' },
    };
    expect(toolLine('x', a)).toBe(toolLine('x', b));
    expect(toolLine('x', a)).toBe(
      `x\t${stableJson({ input: { properties: { a: {}, b: {} }, type: 'object' }, output: null })}`,
    );
  });

  it('finds the @mastra/core version from the agent folder', async () => {
    const app = join(root, 'app');
    const core = join(app, 'node_modules', '@mastra', 'core');
    await mkdir(core, { recursive: true });
    await writeFile(
      join(core, 'package.json'),
      JSON.stringify({ name: '@mastra/core', version: '0.21.1' }),
    );
    await mkdir(join(app, 'src'));
    expect(await mastraVersion([join(app, 'src')])).toBe('0.21.1');
    expect(await mastraVersion([join(root, 'empty-nowhere')])).toBeNull();
  });
});

describe('the OpenClaw adapter', () => {
  it('finds the version of the Gateway that runs the plugin', async () => {
    const pkg = join(root, 'openclaw');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'openclaw', version: '2026.9.6' }),
    );
    await writeFile(join(pkg, 'dist', 'index.js'), '');
    expect(await openClawVersion(join(pkg, 'dist', 'index.js'))).toBe(
      '2026.9.6',
    );
    expect(await openClawVersion(join(root, 'other.js'))).toBeNull();
    expect(await openClawVersion('')).toBeNull();
  });

  it('hashes the model llm_output reports, and declares no tools', async () => {
    vi.stubEnv('SEALKEEPER_HOME', p.home);
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    sealKeeperPlugin().register({
      on: (name, handler) => {
        handlers.set(
          name,
          handler as (event: unknown, ctx: unknown) => unknown,
        );
      },
    });
    await handlers.get('llm_output')?.({ model: 'alice-llm', runId: 'r1' }, {});
    await vi.waitFor(async () => {
      const file = JSON.parse(await readFile(p.fingerprintSources, 'utf8'));
      expect(file.openclaw.model_set).toBe(await h('alice-llm'));
      expect(file.openclaw.model_name).toBe('alice-llm');
      expect(file.openclaw.tools).toBeUndefined();
    });
  });
});

describe('recompute at sync', () => {
  it('the automatic sync writes fingerprint.json', async () => {
    resetBackgroundSyncThrottle();
    await backgroundSync({
      paths: p,
      fetch: (async () => Response.json({})) as typeof fetch,
    });
    expect(await currentFingerprint(p)).not.toBeNull();
  });
});
