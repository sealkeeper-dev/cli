// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Paths, paths } from './config.js';
import { appendRoutine, type RoutineEntry } from './routine.js';
import {
  elapsed,
  eventLine,
  RunEvents,
  Spinner,
  startDetached,
  watchRun,
} from './routine-watch.js';
import { asciiGlyphs } from './style.js';

const AT = '2026-09-28T10:00:00.000Z';
const RUN = '0b6c7c3e-1b1e-4c55-8a7e-6c1f3d7a9e10';

const step = (
  n: number,
  action: string,
  over: Partial<Extract<RoutineEntry, { kind: 'step' }>> = {},
): RoutineEntry => ({
  kind: 'step',
  at: AT,
  runId: RUN,
  step: n,
  action,
  ...over,
});

describe('event lines (RS-9)', () => {
  it('has one line per task, judged submission, note of the API, submit, failed submit, verdict and answer not given', () => {
    const lines = (
      [
        step(0, 'task', {
          taskId: 'a',
          taskType: 'code_review',
          taskKind: 'addressed',
        }),
        step(1, 'judge', { taskId: 'e', taskType: 'summarise' }),
        step(2, 'post', {
          taskId: 'c',
          label: 'Posted a task for other agents, which SealKeeper checks.',
        }),
        // A retried task step whose task is no longer held hands nothing.
        step(3, 'task', { taskId: 'z' }),
        step(4, 'done'),
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
          kind: 'unanswered',
          at: AT,
          runId: RUN,
          taskId: 'g',
          taskType: 'text_dedupe',
          reason: 'the agent gave no answer',
          released: true,
        },
        {
          kind: 'limit',
          at: AT,
          runId: RUN,
          limit: 'tokensPerRun',
          used: 10,
          cap: 10,
        },
      ] satisfies RoutineEntry[]
    ).map(eventLine);
    expect(lines).toEqual([
      'Solving code_review',
      'Judging summarise',
      'Posted a task for other agents, which SealKeeper checks.',
      null,
      null,
      'Submitted code_review, its poster confirms it',
      'Submit failed line_sort, hash_mismatch',
      'Confirmed code_review',
      'Reported failure for summarise',
      'No answer for text_dedupe, the agent gave no answer, released',
      null,
    ]);
  });

  it('says each line once', () => {
    const events = new RunEvents();
    const first = step(0, 'task', {
      taskId: 'a',
      taskType: 'json_extract',
      taskKind: 'seed',
    });
    expect(events.next([first])).toEqual(['Solving json_extract']);
    expect(events.next([first, step(1, 'done')])).toEqual([]);
  });
});

describe('the spinner (RS-9)', () => {
  it('rewrites one line with the elapsed time, ASCII in a Windows console on code page 437', () => {
    let written = '';
    const stream = { write: (text: string) => (written += text) };
    let now = 0;
    const spinner = new Spinner(
      stream,
      '  ',
      asciiGlyphs({ platform: 'win32', codePage: () => 437 }),
      0,
      () => now,
    );
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
    const unicode = new Spinner(
      stream,
      '',
      asciiGlyphs({ platform: 'darwin' }),
      0,
      () => 7_000,
    );
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

  it('prints each event and returns the run line', async () => {
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
      {
        kind: 'step',
        runId: RUN,
        step: 0,
        action: 'task',
        taskId: 'a',
        taskType: 'json_extract',
        taskKind: 'seed',
      },
      p,
    );
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
    end(null);
    const result = await watching;
    expect(lines).toEqual(['Solving json_extract', 'Verified json_extract']);
    expect(result).toMatchObject({
      kind: 'done',
      entry: { runId: RUN, outcome: 'failed' },
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
