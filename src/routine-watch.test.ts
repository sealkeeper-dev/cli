// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Paths, paths } from './config.js';
import { appendRoutine, type RoutineEntry } from './routine.js';
import {
  claimedLine,
  elapsed,
  eventLine,
  RunEvents,
  Spinner,
  startDetached,
  watchRun,
} from './routine-watch.js';

const AT = '2026-09-28T10:00:00.000Z';
const RUN = '0b6c7c3e-1b1e-4c55-8a7e-6c1f3d7a9e10';

const claim = (taskId: string): RoutineEntry => ({
  kind: 'claim',
  at: AT,
  runId: RUN,
  taskId,
  taskType: 'json_extract',
});

describe('event lines (RS-9)', () => {
  it('says the claims of a prove once they are in', () => {
    const events = new RunEvents();
    expect(events.next([claim('a'), claim('b')])).toEqual([]);
    expect(
      events.next([
        claim('a'),
        claim('b'),
        { kind: 'prove', at: AT, runId: RUN, claimed: 2, tasks: 3 },
      ]),
    ).toEqual(['Claimed 2 tasks, 1 more held from before']);
  });

  it('says claims before the next event when no prove line came', () => {
    const events = new RunEvents();
    expect(
      events.next([
        claim('a'),
        {
          kind: 'submit',
          at: AT,
          runId: RUN,
          taskId: 'a',
          taskType: 'json_extract',
          state: 'verified',
        },
      ]),
    ).toEqual(['Claimed 1 task', 'Verified json_extract']);
    expect(events.flush()).toEqual([]);
  });

  it('has one line per submit, failed submit, post, adoption and confirmation', () => {
    const lines = (
      [
        {
          kind: 'submit',
          at: AT,
          runId: RUN,
          taskId: 'a',
          taskType: 'code_review',
          state: 'submitted',
        },
        {
          kind: 'submit_failed',
          at: AT,
          runId: RUN,
          taskId: 'b',
          taskType: 'line_sort',
          reason: 'hash_mismatch',
        },
        {
          kind: 'post',
          at: AT,
          runId: RUN,
          taskId: 'c',
          taskType: 'text_dedupe',
        },
        {
          kind: 'post',
          at: AT,
          runId: RUN,
          taskId: 'd',
          taskType: 'json_extract',
          adopted: true,
          category: 'data',
        },
        {
          kind: 'confirm',
          at: AT,
          runId: RUN,
          taskId: 'e',
          taskType: 'code_review',
          outcome: 'success',
        },
        {
          kind: 'confirm',
          at: AT,
          runId: RUN,
          taskId: 'f',
          taskType: 'summarise',
          outcome: 'failure',
        },
        {
          kind: 'limit',
          at: AT,
          runId: RUN,
          limit: 'claimsPerDay',
          used: 10,
          cap: 10,
        },
      ] satisfies RoutineEntry[]
    ).map(eventLine);
    expect(lines).toEqual([
      'Submitted code_review, its poster confirms it',
      'Submit failed line_sort, hash_mismatch',
      'Posted text_dedupe',
      'Adopted a task in data',
      'Confirmed code_review',
      'Reported failure for summarise',
      null,
    ]);
  });

  it('counts no tasks and one task in words', () => {
    expect(claimedLine(0, 0)).toBe('Claimed no tasks');
    expect(claimedLine(1, 1)).toBe('Claimed 1 task');
    expect(claimedLine(0, 2)).toBe('Claimed no tasks, 2 more held from before');
  });
});

describe('the spinner (RS-9)', () => {
  it('rewrites one line with the elapsed time, ASCII on Windows', () => {
    let written = '';
    const stream = { write: (text: string) => (written += text) };
    let now = 0;
    const spinner = new Spinner(stream, '  ', 'win32', 0, () => now);
    now = 65_000;
    spinner.draw();
    expect(written).toBe('\r\u001b[2K  | Running 1:05');
    spinner.draw();
    expect(written.endsWith('  / Running 1:05')).toBe(true);
    written = '';
    spinner.clear();
    expect(written).toBe('\r\u001b[2K');
    written = '';
    spinner.clear();
    expect(written).toBe('');
    const unicode = new Spinner(stream, '', 'darwin', 0, () => 7_000);
    unicode.draw();
    expect(written).toBe('\r\u001b[2K⠋ Running 0:07');
    expect(elapsed(12 * 60_000 + 5_000)).toBe('12:05');
  });
});

describe('watchRun (RS-9)', () => {
  let home: string;
  let p: Paths;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sealkeeper-watch-'));
    p = paths(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prints each event and returns the run line with a pause after it', async () => {
    const lines: string[] = [];
    let end: (value: string | null) => void = () => undefined;
    const ended = new Promise<string | null>((resolve) => {
      end = resolve;
    });
    const watching = watchRun({
      runId: RUN,
      p,
      ended,
      line: (text) => lines.push(text),
      spinner: null,
      interrupt: null,
      pollMs: 5,
    });
    await appendRoutine(
      { kind: 'claim', runId: RUN, taskId: 'a', taskType: 'json_extract' },
      p,
    );
    await appendRoutine({ kind: 'prove', runId: RUN, claimed: 1, tasks: 1 }, p);
    await appendRoutine(
      { kind: 'submit', runId: RUN, taskId: 'a', taskType: 'json_extract' },
      p,
    );
    // Another run's line is never shown.
    await appendRoutine(
      { kind: 'submit', runId: 'other', taskId: 'x', taskType: 'line_sort' },
      p,
    );
    await appendRoutine(
      {
        kind: 'run',
        runId: RUN,
        outcome: 'failed',
        reason: 'the agent exited with 1',
        startedAt: AT,
        agentStarted: true,
        claimed: 1,
        submitted: 1,
        confirmed: 0,
        posted: 0,
        tokens: 10,
        costUsd: null,
      },
      p,
    );
    await appendRoutine({ kind: 'pause', reason: 'three failed runs' }, p);
    end(null);
    const result = await watching;
    expect(lines).toEqual(['Claimed 1 task', 'Verified json_extract']);
    expect(result).toMatchObject({
      kind: 'done',
      entry: { runId: RUN, outcome: 'failed' },
      paused: 'three failed runs',
    });
  });

  it('says a run that ended without its line was lost, with why it did not start', async () => {
    const base = {
      runId: RUN,
      p,
      line: () => undefined,
      spinner: null,
      interrupt: null,
      pollMs: 5,
    };
    expect(
      await watchRun({ ...base, ended: Promise.resolve('spawn ENOENT') }),
    ).toEqual({ kind: 'lost', error: 'spawn ENOENT' });
    expect(await watchRun({ ...base, ended: Promise.resolve(null) })).toEqual({
      kind: 'lost',
      error: null,
    });
  });

  it('stops on Ctrl-C and undoes its handler', async () => {
    let undone = false;
    const result = await watchRun({
      runId: RUN,
      p,
      ended: new Promise(() => undefined),
      line: () => undefined,
      spinner: { write: () => true },
      interrupt: (stop) => {
        const timer = setTimeout(stop, 10);
        return () => {
          clearTimeout(timer);
          undone = true;
        };
      },
      pollMs: 5,
    });
    expect(result).toEqual({ kind: 'detached' });
    expect(undone).toBe(true);
  });
});

describe('startDetached (RS-9)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sealkeeper-detached-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the program with its output to the file, mode 600', async () => {
    const outFile = join(dir, 'routine.out.log');
    const started = startDetached({
      runId: RUN,
      program: [
        process.execPath,
        '-e',
        'console.log(process.env.MARK); console.error("to stderr")',
      ],
      env: { ...process.env, MARK: 'detached run' },
      cwd: dir,
      outFile,
    });
    expect(await started.ended).toBeNull();
    const text = await readFile(outFile, 'utf8');
    expect(text).toContain('detached run\n');
    expect(text).toContain('to stderr\n');
    if (process.platform !== 'win32') {
      expect((await stat(outFile)).mode & 0o777).toBe(0o600);
    }
  });

  it('says why a program could not start', async () => {
    const started = startDetached({
      runId: RUN,
      program: [join(dir, 'no-such-node')],
      env: process.env,
      cwd: dir,
      outFile: join(dir, 'out.log'),
    });
    expect(await started.ended).toMatch(/ENOENT/);
  });
});
