// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Paths, paths } from './config.js';
import { handedFinalLineFeed, keepHanded, takeAskAgain } from './handed.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const LATER = '2026-10-05T12:00:00.000Z';
const ASKS = { output: 'End with exactly one line feed.' };
const NOT_ASKED = { output: 'Do not end with a line feed.' };

describe('the handed over game task specs (VOU-635)', () => {
  let home: string;
  let p: Paths;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-handed-'));
    p = paths(home);
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('keeps whether each spec asks for a final line feed, never the spec', async () => {
    const asks = randomUUID();
    const not = randomUUID();
    await keepHanded(
      [
        {
          id: asks,
          spec: { ...ASKS, input: 'secret input' },
          expiresAt: LATER,
        },
        { id: not, spec: NOT_ASKED, expiresAt: LATER },
      ],
      NOW,
      p,
    );
    expect(await handedFinalLineFeed(asks, p)).toBe(true);
    expect(await handedFinalLineFeed(not, p)).toBe(false);
    expect(await handedFinalLineFeed(randomUUID(), p)).toBeNull();
    const text = await readFile(p.handed, 'utf8');
    expect(text).not.toContain('secret input');
    expect(text).not.toContain('line feed');
  });

  it('drops expired tasks and keeps the newest 100', async () => {
    const old = randomUUID();
    await keepHanded(
      [{ id: old, spec: ASKS, expiresAt: '2026-10-04T11:00:00.000Z' }],
      new Date('2026-10-04T10:00:00.000Z'),
      p,
    );
    const ids = Array.from({ length: 101 }, () => randomUUID());
    for (const id of ids) {
      await keepHanded([{ id, spec: ASKS, expiresAt: LATER }], NOW, p);
    }
    expect(await handedFinalLineFeed(old, p)).toBeNull();
    expect(await handedFinalLineFeed(ids[0] ?? '', p)).toBeNull();
    expect(await handedFinalLineFeed(ids[100] ?? '', p)).toBe(true);
    const file = JSON.parse(await readFile(p.handed, 'utf8'));
    expect(file.tasks).toHaveLength(100);
  });

  it('reads a file that does not parse as nothing kept, and writes over it', async () => {
    await writeFile(p.handed, 'not json');
    const id = randomUUID();
    expect(await handedFinalLineFeed(id, p)).toBeNull();
    await keepHanded([{ id, spec: ASKS, expiresAt: LATER }], NOW, p);
    expect(await handedFinalLineFeed(id, p)).toBe(true);
  });

  it('takes the asks again of a task up to the cap, kept when the task is handed over again', async () => {
    const id = randomUUID();
    await keepHanded([{ id, spec: ASKS, expiresAt: LATER }], NOW, p);
    expect(await takeAskAgain(id, 2, p)).toBe(true);
    await keepHanded([{ id, spec: ASKS, expiresAt: LATER }], NOW, p);
    expect(await takeAskAgain(id, 2, p)).toBe(true);
    expect(await takeAskAgain(id, 2, p)).toBe(false);
    expect(await handedFinalLineFeed(id, p)).toBe(true);
    // A task not kept here is never asked again, since its asks cannot be
    // counted.
    expect(await takeAskAgain(randomUUID(), 2, p)).toBe(false);
  });
});
