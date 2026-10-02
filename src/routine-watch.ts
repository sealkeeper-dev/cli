// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import type { Paths } from './config.js';
import { type RoutineEntry, type RunEntry, readRoutine } from './routine.js';
import { asciiGlyphs } from './style.js';

// Watching a routine run as it works (RS-9). The first run that init and
// the routine setup start runs detached, as the scheduler runs it, and the
// command that started it reads routine.jsonl for that run's lines, prints
// one line per event and a spinner with the elapsed time between them.
// routine run by hand in a terminal prints the same lines. The lines come
// from the log alone, so what the watcher says is what the run recorded.

// A run started for watching. ended settles when its process ends, with
// null, or with why it could not start.
export type StartedRun = { ended: Promise<string | null> };

export type StartSpec = {
  runId: string;
  // The command the scheduler runs, node, the copy and routine run.
  program: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  // Where its stdout and stderr go.
  outFile: string;
};

// Starts program in a process group of its own with its output to outFile,
// so it keeps going when the terminal that started it sends Ctrl-C or
// closes. On Windows detached gives it a console of its own, which
// windowsHide keeps out of sight.
export function startDetached(spec: StartSpec): StartedRun {
  const [file, ...args] = spec.program;
  if (file === undefined) return { ended: Promise.resolve('no program') };
  let fd: number | undefined;
  try {
    fd = openSync(spec.outFile, 'a', 0o600);
    const child = spawn(file, args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    child.unref();
    const ended = new Promise<string | null>((resolve) => {
      child.once('error', (error) => resolve(error.message));
      child.once('exit', () => resolve(null));
    });
    return { ended };
  } catch (error) {
    return { ended: Promise.resolve((error as Error).message) };
  } finally {
    // The child has its own copy of the descriptor by now.
    if (fd !== undefined) closeSync(fd);
  }
}

// Turns the lines of one run into what the watcher prints, in order.
export class RunEvents {
  private seen = 0;

  // Every line of the run so far, in order. Returns the lines to print for
  // the ones not seen before.
  next(entries: RoutineEntry[]): string[] {
    const fresh = entries.slice(this.seen);
    this.seen = entries.length;
    return fresh.flatMap((e) => {
      const line = eventLine(e);
      return line === null ? [] : [line];
    });
  }
}

// One event of a run as a line, or null for a line the watcher does not
// show, a step with nothing to say, a limit or the run line itself. A step
// that did something on the server says what the API said it did.
export function eventLine(e: RoutineEntry): string | null {
  switch (e.kind) {
    case 'step':
      if (e.action === 'task') {
        return e.taskKind === undefined ? null : `Solving ${e.taskType}`;
      }
      if (e.action === 'judge') return `Judging ${e.taskType ?? 'a task'}`;
      return e.label ?? null;
    case 'submit': {
      const type = e.taskType ?? 'a task';
      if (e.state === undefined || e.state === 'verified') {
        return `Verified ${type}`;
      }
      return `Submitted ${type}, its poster confirms it`;
    }
    case 'submit_failed':
      return `Submit failed ${e.taskType ?? 'a task'}, ${e.reason}`;
    case 'confirm':
      return `${e.outcome === 'failure' ? 'Reported failure for' : 'Confirmed'} ${e.taskType ?? 'a task'}`;
    case 'unanswered':
      return `No answer for ${e.taskType ?? 'a task'}, ${e.reason}${e.released ? ', released' : ''}`;
    default:
      return null;
  }
}

// The lines of one run, in the order written.
export async function runEntries(
  runId: string,
  p: Paths,
): Promise<RoutineEntry[]> {
  return (await readRoutine(p)).filter(
    (e) => 'runId' in e && e.runId === runId,
  );
}

export type SpinnerStream = { write(text: string): unknown };

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];

// The elapsed time as 0:07 or 12:05.
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

// One line rewritten in place, a frame and the time since start. ASCII when
// asciiGlyphs in style.ts says so, as in a Windows console whose code page
// is not UTF-8.
export class Spinner {
  private frame = 0;
  private shown = false;
  private readonly frames: string[];

  constructor(
    private readonly stream: SpinnerStream,
    private readonly indent: string,
    ascii: boolean,
    private readonly start: number,
    private readonly now: () => number = Date.now,
  ) {
    this.frames = ascii ? ASCII_FRAMES : FRAMES;
  }

  draw(): void {
    const frame = this.frames[this.frame % this.frames.length] ?? '';
    this.frame += 1;
    this.stream.write(
      `\r\u001b[2K${this.indent}${frame} Running ${elapsed(this.now() - this.start)}`,
    );
    this.shown = true;
  }

  clear(): void {
    if (!this.shown) return;
    this.stream.write('\r\u001b[2K');
    this.shown = false;
  }
}

// How often the watcher reads the log and redraws the spinner.
const POLL_MS = 500;
const FRAME_MS = 100;
// After the run line, how long the watcher waits for the process to end.
const END_GRACE_MS = 5_000;

export type WatchResult =
  | { kind: 'done'; entry: RunEntry }
  // Ctrl-C ended the watching. The run goes on.
  | { kind: 'detached' }
  // The process ended with no run line, error says why when it did not
  // start.
  | { kind: 'lost'; error: string | null };

export type WatchOptions = {
  runId: string;
  p: Paths;
  ended: Promise<string | null>;
  // Prints one event line.
  line: (text: string) => void;
  // Where the spinner goes, null for none, as when stdout is not a
  // terminal.
  spinner: SpinnerStream | null;
  indent?: string;
  // ASCII frames, asciiGlyphs() when left out.
  ascii?: boolean;
  // Calls stop on Ctrl-C and returns what undoes that, null when Ctrl-C
  // should not end the watching.
  interrupt: ((stop: () => void) => () => void) | null;
  pollMs?: number;
};

// Ctrl-C through SIGINT, for as long as the watching lasts.
export const onSigint = (stop: () => void): (() => void) => {
  process.once('SIGINT', stop);
  return () => {
    process.removeListener('SIGINT', stop);
  };
};

// Prints the run's events until its run line comes and its process ends,
// the process ends without one, or Ctrl-C.
export async function watchRun(o: WatchOptions): Promise<WatchResult> {
  const events = new RunEvents();
  const spinner =
    o.spinner === null
      ? null
      : new Spinner(
          o.spinner,
          o.indent ?? '',
          o.ascii ?? asciiGlyphs(),
          Date.now(),
        );
  let interrupted = false;
  let wake: () => void = () => undefined;
  const undo = o.interrupt?.(() => {
    interrupted = true;
    wake();
  });
  let ended: string | null | undefined;
  void o.ended.then((value) => {
    ended = value;
    wake();
  });
  const frames =
    spinner === null ? null : setInterval(() => spinner.draw(), FRAME_MS);
  spinner?.draw();
  const print = (lines: string[]) => {
    if (lines.length === 0) return;
    spinner?.clear();
    for (const text of lines) o.line(text);
    spinner?.draw();
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  try {
    for (;;) {
      if (interrupted) return { kind: 'detached' };
      const entries = await runEntries(o.runId, o.p);
      const run = entries.find((e): e is RunEntry => e.kind === 'run');
      print(events.next(entries.filter((e) => e.kind !== 'run')));
      if (run !== undefined) {
        if (ended === undefined) await sleep(END_GRACE_MS);
        return { kind: 'done', entry: run };
      }
      if (ended !== undefined) {
        // One last read, the run line may have come as the process ended.
        const last = await runEntries(o.runId, o.p);
        const late = last.find((e): e is RunEntry => e.kind === 'run');
        print(events.next(last.filter((e) => e.kind !== 'run')));
        if (late !== undefined) return { kind: 'done', entry: late };
        return { kind: 'lost', error: ended };
      }
      await sleep(o.pollMs ?? POLL_MS);
    }
  } finally {
    if (frames !== null) clearInterval(frames);
    spinner?.clear();
    undo?.();
  }
}
