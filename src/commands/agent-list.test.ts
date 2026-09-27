// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentsMapPath,
  bindFolder,
  namedHome,
  paths,
  writeConfig,
} from '../config.js';
import { saveOperatorSlug } from '../operator-slug.js';
import { createProgram } from '../program.js';

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
  } catch (e) {
    if (e instanceof CommanderError) return { code: e.exitCode, out, err };
    throw e;
  } finally {
    vi.mocked(process.stdout.write).mockRestore();
    vi.mocked(process.stderr.write).mockRestore();
  }
}

const APP_ID = 'A'.repeat(43);
const BILLING_ID = `${'B'.repeat(42)}A`;

const config = (agentId: string, name: string) => ({
  agentId,
  operatorLogin: 'alice',
  name,
  version: '1.0.0',
  registeredAt: '2026-09-23T10:00:00Z',
});

describe('sealkeeper agent list', () => {
  let dir: string;
  let root: string;
  let app: string;
  let billing: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'sealkeeper-list-')));
    root = join(dir, 'root');
    app = join(dir, 'app');
    billing = join(dir, 'billing');
    await mkdir(app);
    await mkdir(billing);
    vi.stubEnv('SEALKEEPER_HOME', '');
    vi.stubEnv('SEALKEEPER_ROOT', root);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('says to run init when there are no agents', async () => {
    const { code, out } = await run('agent', 'list');
    expect(code).toBe(0);
    expect(out).toBe('no agents on this machine, run npx sealkeeper init\n');
    expect(JSON.parse((await run('agent', 'list', '--json')).out)).toEqual({
      agents: [],
    });
  });

  it('lists each agent with its handle and folders, the default first', async () => {
    await writeConfig(config(APP_ID, 'app'), paths(root));
    const billingHome = namedHome('billing', root);
    await writeConfig(config(BILLING_ID, 'billing'), paths(billingHome));
    await saveOperatorSlug(
      BILLING_ID,
      'alice-2',
      new Date(),
      paths(billingHome),
    );
    await bindFolder(billing, billingHome, root);
    await bindFolder(app, root, root);
    // Bound, but init never finished there.
    const ghost = join(dir, 'ghost');
    await mkdir(ghost);
    await bindFolder(ghost, namedHome('ghost', root), root);
    await mkdir(namedHome('ghost', root));

    const { code, out } = await run('agent', 'list');
    expect(code).toBe(0);
    expect(out).toBe(
      [
        'alice/app  default',
        `  ${app}`,
        '',
        'alice-2/billing',
        `  ${billing}`,
        '',
        `no config in ${namedHome('ghost', root)}`,
        `  ${ghost}`,
        '',
      ].join('\n'),
    );

    const json = JSON.parse((await run('agent', 'list', '--json')).out);
    expect(json).toEqual({
      agents: [
        {
          home: root,
          name: 'app',
          agentId: APP_ID,
          handle: 'alice/app',
          isDefault: true,
          folders: [app],
        },
        {
          home: billingHome,
          name: 'billing',
          agentId: BILLING_ID,
          handle: 'alice-2/billing',
          isDefault: false,
          folders: [billing],
        },
        {
          home: namedHome('ghost', root),
          name: null,
          agentId: null,
          handle: null,
          isDefault: false,
          folders: [ghost],
        },
      ],
    });
  });

  it('shows a named home no folder uses any more', async () => {
    await writeConfig(
      config(BILLING_ID, 'billing'),
      paths(namedHome('billing', root)),
    );
    const { code, out } = await run('agent', 'list');
    expect(code).toBe(0);
    expect(out).toBe('alice/billing\n  no folder uses it\n');
  });

  it('says what is wrong with a broken folder map', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(agentsMapPath(root), '{ nope');
    const { code, err } = await run('agent', 'list');
    expect(code).toBe(1);
    expect(err).toContain(`Invalid agent folders at ${agentsMapPath(root)}`);
  });
});
