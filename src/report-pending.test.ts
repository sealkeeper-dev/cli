// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Paths, paths } from './config.js';
import {
  dropReport,
  dropUploads,
  fileKeyOf,
  keepUpload,
  keptUploads,
  reportIdFor,
} from './report-pending.js';

describe('the reports and uploads not filed yet', () => {
  let home: string;
  let other: string;
  let p: Paths;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-report-pending-'));
    other = await mkdtemp(join(tmpdir(), 'sealkeeper-report-pending-'));
    p = paths(home);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });

  it('keeps one random id for the same parts until it is dropped, and another for other parts', async () => {
    const parts = ['a', 1, ['b']];
    const { key, reportId } = await reportIdFor(parts, p);
    expect(z.uuid().safeParse(reportId).success).toBe(true);
    expect(reportId[14]).toBe('4');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await reportIdFor(parts, p)).toEqual({ key, reportId });
    const otherParts = await reportIdFor(['a', 1, ['c']], p);
    expect(otherParts.reportId).not.toBe(reportId);
    await dropReport(key, p);
    const next = await reportIdFor(parts, p);
    expect(next.key).toBe(key);
    expect(next.reportId).not.toBe(reportId);
  });

  it('keeps a report under a key made with the home secret, never its parts', async () => {
    const parts = ['a', 1, ['b']];
    const here = await reportIdFor(parts, p);
    const there = await reportIdFor(parts, paths(other));
    expect(there.key).not.toBe(here.key);
    expect(JSON.parse(await readFile(p.reportPending, 'utf8'))).toEqual({
      v: 1,
      reports: [{ key: here.key, reportId: here.reportId }],
      uploads: [],
    });
    expect(here.key).not.toBe(fileKeyOf(parts));
  });

  it('keeps the newest 100 reports', async () => {
    const ids = [];
    for (let i = 0; i < 101; i++) ids.push(await reportIdFor([i], p));
    const pending = JSON.parse(await readFile(p.reportPending, 'utf8'));
    expect(pending.reports).toHaveLength(100);
    expect((await reportIdFor([100], p)).reportId).toBe(ids[100]?.reportId);
    expect((await reportIdFor([0], p)).reportId).not.toBe(ids[0]?.reportId);
  });

  it('keeps a report run again as the newest', async () => {
    const first = await reportIdFor([0], p);
    const second = await reportIdFor([1], p);
    for (let i = 2; i < 100; i++) await reportIdFor([i], p);
    expect((await reportIdFor([0], p)).reportId).toBe(first.reportId);
    await reportIdFor([100], p);
    expect((await reportIdFor([0], p)).reportId).toBe(first.reportId);
    expect((await reportIdFor([1], p)).reportId).not.toBe(second.reportId);
  });

  it('keeps the reports and the uploads apart, and removes the file once both are dropped', async () => {
    const file = fileKeyOf(['one']);
    const id = randomUUID();
    await keepUpload(file, id, p);
    const { key } = await reportIdFor(['a'], p);
    await dropUploads([file], p);
    expect(await keptUploads([file], p)).toEqual([null]);
    expect(JSON.parse(await readFile(p.reportPending, 'utf8')).reports).toEqual(
      [{ key, reportId: expect.any(String) }],
    );
    await dropReport(key, p);
    await expect(stat(p.reportPending)).rejects.toThrow();
  });

  it('keeps each upload by its file until it is dropped', async () => {
    const [first, second] = [fileKeyOf(['one']), fileKeyOf(['two'])];
    expect(await keptUploads([first, second], p)).toEqual([null, null]);
    const id = randomUUID();
    await keepUpload(second, id, p);
    expect(await keptUploads([first, second], p)).toEqual([null, id]);
    // Any command that sends the same file finds it.
    expect(await keptUploads([second], p)).toEqual([id]);
    await dropUploads([first, second], p);
    await expect(stat(p.reportPending)).rejects.toThrow();
  });

  it('keeps the newest 100 files', async () => {
    const files = Array.from({ length: 101 }, (_, i) => fileKeyOf([i]));
    for (const file of files) await keepUpload(file, randomUUID(), p);
    expect(await keptUploads([files[0] as string], p)).toEqual([null]);
    expect(await keptUploads([files[100] as string], p)).not.toEqual([null]);
  });

  it('reads a file that does not parse as no record and writes over it', async () => {
    await writeFile(p.reportPending, 'not json');
    const file = fileKeyOf(['one']);
    expect(await keptUploads([file], p)).toEqual([null]);
    const id = randomUUID();
    await keepUpload(file, id, p);
    expect(await keptUploads([file], p)).toEqual([id]);
  });

  it('makes a random id each time and keeps none when the home secret does not read', async () => {
    await writeFile(p.promptSecret, 'nope\n');
    const parts = ['a'];
    const first = await reportIdFor(parts, p);
    expect(first.key).toBeNull();
    expect(z.uuid().safeParse(first.reportId).success).toBe(true);
    expect((await reportIdFor(parts, p)).reportId).not.toBe(first.reportId);
    await expect(stat(p.reportPending)).rejects.toThrow();
  });
});
