// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentId } from '@sealkeeper/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  handleOf,
  paths,
  profileUrl,
  readConfig,
  writeConfig,
} from './config.js';
import {
  currentOperatorSlug,
  readOperatorSlug,
  refreshOperatorSlug,
  saveOperatorSlug,
  slugOfAnswer,
} from './operator-slug.js';

const AGENT_ID = 'A'.repeat(43);
const OTHER_ID = 'B'.repeat(43);
const API_URL = 'https://api.test';
const CONFIG = {
  agentId: AGENT_ID,
  operatorLogin: 'alice',
  name: 'scout',
  version: '1.0.0',
  apiUrl: API_URL,
  registeredAt: '2026-09-23T08:00:00Z',
};

// config.json as CLI 0.4.4 reads it, strictly. Any key outside these fails
// every command of a copy pinned to 0.4.4, the adapters too.
const Config044 = z.strictObject({
  agentId: AgentId,
  operatorLogin: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  apiUrl: z.url().default('https://api.sealkeeper.run'),
  registeredAt: z.iso.datetime({ offset: true }),
  autoSync: z.boolean().optional(),
});

const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

function answering(body: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    expect(String(input)).toBe(`${API_URL}/v1/agents/${AGENT_ID}`);
    return Response.json(body);
  }) as typeof fetch;
}

describe('operator slug', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-slug-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is null until one is saved, then the saved one', async () => {
    const p = paths(home);
    expect(await readOperatorSlug(AGENT_ID, p)).toBeNull();
    await saveOperatorSlug(AGENT_ID, 'alice-2', new Date(), p);
    expect(await readOperatorSlug(AGENT_ID, p)).toBe('alice-2');
    const file = JSON.parse(await readFile(p.operatorSlug, 'utf8'));
    expect(file).toMatchObject({ v: 1, agentId: AGENT_ID, slug: 'alice-2' });
  });

  it('never gives one agent the slug stored for another', async () => {
    const p = paths(home);
    await saveOperatorSlug(OTHER_ID, 'bob', new Date(), p);
    expect(await readOperatorSlug(AGENT_ID, p)).toBeNull();
  });

  it('reads a broken file or a bad slug as none, and never saves a bad slug', async () => {
    const p = paths(home);
    await writeFile(p.operatorSlug, 'not json');
    expect(await readOperatorSlug(AGENT_ID, p)).toBeNull();
    await writeFile(
      p.operatorSlug,
      JSON.stringify({
        v: 1,
        agentId: AGENT_ID,
        slug: 'Not/A/Slug',
        seenAt: '2026-09-26T00:00:00Z',
      }),
    );
    expect(await readOperatorSlug(AGENT_ID, p)).toBeNull();
    await saveOperatorSlug(AGENT_ID, '../evil', new Date(), p);
    expect(await readOperatorSlug(AGENT_ID, p)).toBeNull();
  });

  it('takes the slug from operator.slug, else from the handle', () => {
    expect(
      slugOfAnswer({
        operator: { slug: 'alice-2' },
        handle: 'alice/scout',
      }),
    ).toBe('alice-2');
    expect(slugOfAnswer({ handle: 'alice-2/scout' })).toBe('alice-2');
    expect(slugOfAnswer({ operator: {} })).toBeUndefined();
    expect(slugOfAnswer({ handle: 'Bad Slug/scout' })).toBeUndefined();
  });

  it('refreshes from an answer and keeps the stored slug without one', async () => {
    const p = paths(home);
    expect(await refreshOperatorSlug(AGENT_ID, null, p)).toBeNull();
    expect(
      await refreshOperatorSlug(AGENT_ID, { operator: { slug: 'alice-2' } }, p),
    ).toBe('alice-2');
    // Changed on the web, then offline.
    expect(
      await refreshOperatorSlug(AGENT_ID, { handle: 'wonderland/scout' }, p),
    ).toBe('wonderland');
    expect(await refreshOperatorSlug(AGENT_ID, null, p)).toBe('wonderland');
    // An API from before slugs sends neither.
    expect(await refreshOperatorSlug(AGENT_ID, { operator: {} }, p)).toBe(
      'wonderland',
    );
  });

  it('reads the agent when online and the stored slug offline', async () => {
    const p = paths(home);
    const online = await currentOperatorSlug(
      CONFIG,
      answering({
        operator: { login: 'alice', slug: 'alice-2' },
        handle: 'alice-2/scout',
      }),
      p,
    );
    expect(online.slug).toBe('alice-2');
    expect(online.live?.handle).toBe('alice-2/scout');
    const off = await currentOperatorSlug(CONFIG, offline, p);
    expect(off).toEqual({ slug: 'alice-2', live: null });
  });

  it('builds the handle and profile from the slug, the login without one', () => {
    expect(handleOf(CONFIG, 'alice-2')).toBe('alice-2/scout');
    expect(profileUrl(CONFIG, 'alice-2')).toBe(
      'https://sealkeeper.run/agents/alice-2/scout',
    );
    expect(handleOf(CONFIG, null)).toBe('alice/scout');
    expect(handleOf(CONFIG)).toBe('alice/scout');
  });

  it('leaves config.json readable by CLI 0.4.4', async () => {
    const p = paths(home);
    await writeConfig(CONFIG, p);
    await currentOperatorSlug(
      CONFIG,
      answering({ operator: { login: 'alice', slug: 'alice-2' } }),
      p,
    );
    // A config read and written again, as a command that changes it does.
    const read = await readConfig(p);
    if (read === null) throw new Error('no config');
    await writeConfig({ ...read, autoSync: true }, p);

    const raw = JSON.parse(await readFile(p.config, 'utf8'));
    expect(Config044.safeParse(raw).success).toBe(true);
    expect(raw).not.toHaveProperty('slug');
    expect(raw).not.toHaveProperty('operatorSlug');
    expect(await readdir(home)).toContain('operator-slug.json');
    expect(await readOperatorSlug(AGENT_ID, p)).toBe('alice-2');
  });
});
