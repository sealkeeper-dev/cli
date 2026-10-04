// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { spawn } from 'node:child_process';
import { closeSync, fchmodSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ScheduledAgent } from './config.js';

// The agent of a routine run (VOU-136, VOU-599, VOU-601). The routine puts
// one question to one agent and takes its answer back as text, a task's
// spec to solve or a submission to judge, see routine-prompt.ts. The agent
// has no tools, so whatever a spec written by another operator says, it
// can run nothing, read nothing and write nothing. The CLI writes and
// submits the text it answers.
//
// AgentRuntime is that one question, the one seam every runtime fills. It
// holds no routine rules, the API decides every step (routine-run.ts).
// For Claude Code it is claude -p with the question on stdin, no tools and
// stream-json output, so the run can count tokens as they are reported and
// stop the agent at the token cap or the wall clock, whichever comes
// first. None of the operator's own Claude Code settings apply, see
// claudeArgs. OpenClaw is in routine-openclaw.ts and Mastra, which runs in
// the operator's own process, in routine-mastra.ts.

// One question. timeoutMs and tokenCap are what the run has left.
export type AgentQuestion = {
  prompt: string;
  timeoutMs: number;
  tokenCap: number;
};

// The runtimes a routine run can put its questions to, by the name its run
// line keeps. The CLI's own job starts one of SCHEDULED_AGENTS (config.ts),
// and a Mastra routine runs in the operator's own process.
export type RoutineRuntimeName = ScheduledAgent | 'mastra';

export type AgentRuntime = {
  name: RoutineRuntimeName;
  ask(question: AgentQuestion): Promise<AgentResult>;
};

// Claude Code as a routine runtime, claude -p at command with claudeArgs,
// started in cwd, an empty folder outside the CLI home. Every question of
// a run goes to the one transcript, when there is one.
export function claudeCodeRuntime(o: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawner?: Spawner;
  transcript?: Transcript | null;
}): AgentRuntime {
  return {
    name: 'claude-code',
    ask: (question) =>
      runAgent(
        {
          command: o.command,
          args: claudeArgs(),
          input: question.prompt,
          cwd: o.cwd,
          env: o.env,
          timeoutMs: question.timeoutMs,
          tokenCap: question.tokenCap,
          transcript: o.transcript ?? null,
          reader: new UsageCounter(),
        },
        o.spawner ?? spawnAgent,
      ),
  };
}

export type AgentSpec = {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  tokenCap: number;
  // Where the agent's output goes as received (RS-10). Never printed.
  transcript?: Transcript | null;
  // Reads what the agent prints on stdout. Claude Code's stream-json when
  // not given.
  reader?: StdoutReader;
};

// What a runtime reads from the agent's stdout, the answer, the tokens and
// the cost it reported, the model it named, whether it says it ran out of
// time, and a problem that fails the run. end is called once, with the
// exit code.
export type StdoutReader = {
  write(chunk: string): void;
  end(code: number | null): void;
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly text: string | null;
  readonly model?: string | null;
  readonly timedOut?: boolean;
  readonly problem?: AgentProblem;
};

// Why an agent that ran gave no usable answer, in one line that holds no
// spec, answer or credential. auth is a provider credential missing or
// refused, tools a tool call the routine never allows, failed anything
// else.
export type AgentProblem = {
  kind: 'auth' | 'tools' | 'failed';
  reason: string;
};

export type AgentResult = {
  // The agent's answer, the text of its result, null when it gave none.
  text: string | null;
  // null when the agent was stopped or never started.
  exitCode: number | null;
  stoppedFor: 'minutesPerRun' | 'tokensPerRun' | null;
  // Input, output and cache write tokens as the agent reported them. Cache
  // reads are not counted. null when it reported none.
  tokens: number | null;
  costUsd: number | null;
  // The model id the runtime reported for the answer, as it came, when it
  // reported one (VOU-614). What the agent says about itself, which the
  // routine records for the fingerprint source and sync declares.
  model?: string;
  // Why it could not start.
  error?: string;
  // Why it ran but gave no usable answer, which fails the run.
  problem?: AgentProblem;
};

// The parts of a child process the run uses, so tests can pass their own.
export type AgentProcess = {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

export type Spawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => AgentProcess;

export const spawnAgent: Spawner = (command, args, options) => {
  const call = spawnCall(command, args);
  return spawn(call.file, call.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsVerbatimArguments: call.verbatim,
  });
};

// How to start command with args. Node starts a .cmd or .bat file on
// Windows only through cmd.exe, which parses the line again, so there it
// goes through cmd.exe /d /s /c with every part quoted for both cmd.exe and
// the program, as cross-spawn does. An npm .cmd shim passes its arguments
// through cmd.exe once more, so they are escaped twice. Anything else is
// started directly.
export function spawnCall(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.ComSpec ?? process.env.COMSPEC,
): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { file: command, args, verbatim: false };
  }
  const line = [
    escapeCmdCommand(command),
    ...args.map((arg) => escapeCmdArgument(arg, true)),
  ].join(' ');
  return {
    file: comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// The program path, with cmd.exe's special characters escaped.
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

// One argument, quoted for the program's own parser (backslashes before a
// quote doubled, the quote escaped), then with cmd.exe's special characters
// escaped, twice for a .cmd shim.
export function escapeCmdArgument(arg: string, twice: boolean): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  out = `"${out}"`.replace(CMD_META, '^$1');
  return twice ? out.replace(CMD_META, '^$1') : out;
}

// After a stop, how long the agent gets before it is killed outright.
const KILL_GRACE_MS = 10_000;

export function runAgent(
  spec: AgentSpec,
  spawner: Spawner = spawnAgent,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    let child: AgentProcess;
    try {
      child = spawner(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
      });
    } catch (error) {
      resolve(notStarted((error as Error).message));
      return;
    }
    const reader: StdoutReader = spec.reader ?? new UsageCounter();
    const transcript = spec.transcript ?? null;
    let stoppedFor: AgentResult['stoppedFor'] = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = (reason: NonNullable<AgentResult['stoppedFor']>) => {
      if (stoppedFor !== null) return;
      stoppedFor = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const clock = setTimeout(() => stop('minutesPerRun'), spec.timeoutMs);

    // A character whose bytes come in two chunks is decoded whole, so a
    // long answer is never cut inside one.
    const decoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer | string) => {
      transcript?.write(chunk);
      reader.write(typeof chunk === 'string' ? chunk : decoder.write(chunk));
      if (reader.tokens !== null && reader.tokens > spec.tokenCap) {
        stop('tokensPerRun');
      }
    });

    const finish = (result: AgentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    child.on('error', (error) => finish(notStarted(error.message)));
    child.on('close', (code) => {
      const rest = decoder.end();
      if (rest !== '') reader.write(rest);
      reader.end(code);
      // An agent that says it ran out of time stopped at the wall clock,
      // the same as one this run stopped.
      const stopped = stoppedFor ?? (reader.timedOut ? 'minutesPerRun' : null);
      const problem = stopped === null ? reader.problem : undefined;
      finish({
        text: stopped === null && code === 0 ? reader.text : null,
        exitCode: stopped === null ? code : null,
        stoppedFor: stopped,
        tokens: reader.tokens,
        costUsd: reader.costUsd,
        ...(typeof reader.model === 'string' ? { model: reader.model } : {}),
        ...(problem === undefined ? {} : { problem }),
      });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.input);
  });
}

// The size a transcript is cut at, the cut line included.
export const TRANSCRIPT_CAP_BYTES = 8 * 1024 * 1024;

// The last line of a transcript that was cut, one JSON object like the
// lines before it.
export const TRANSCRIPT_CUT_LINE = JSON.stringify({
  type: 'sealkeeper',
  note: 'The transcript was cut at 8 MB. The rest of the run is not in it.',
});

// The last run's stream-json, every question of it, written as it arrives
// to a file of mode 600 that each run replaces (RS-10). Once the next chunk would pass the cap, it
// writes that chunk up to its last whole line that fits and the cut line,
// then nothing more. A file that cannot be opened or written leaves the run
// without a transcript, never stops it.
export class Transcript {
  private fd: number | null;
  private written = 0;
  private lastByte = 10;

  private constructor(
    fd: number,
    private readonly cap: number,
  ) {
    this.fd = fd;
  }

  static open(
    path: string,
    cap: number = TRANSCRIPT_CAP_BYTES,
  ): Transcript | null {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, 'w', 0o600);
      // A file left by an earlier run keeps its mode through the truncate.
      fchmodSync(fd, 0o600);
      return new Transcript(fd, cap);
    } catch {
      return null;
    }
  }

  write(chunk: Buffer | string): void {
    if (this.fd === null) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const room = this.cap - this.written - TRANSCRIPT_CUT_LINE.length - 2;
    try {
      if (bytes.length <= room) {
        this.put(bytes);
        return;
      }
      const end = bytes.subarray(0, Math.max(0, room)).lastIndexOf(10);
      if (end >= 0) this.put(bytes.subarray(0, end + 1));
      this.put(
        Buffer.from(
          `${this.lastByte === 10 ? '' : '\n'}${TRANSCRIPT_CUT_LINE}\n`,
        ),
      );
    } catch {
      // Nothing more is kept.
    }
    this.close();
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Closed already.
    }
    this.fd = null;
  }

  private put(bytes: Buffer): void {
    if (this.fd === null || bytes.length === 0) return;
    writeSync(this.fd, bytes);
    this.written += bytes.length;
    this.lastByte = bytes[bytes.length - 1] ?? this.lastByte;
  }
}

const notStarted = (error: string): AgentResult => ({
  text: null,
  exitCode: null,
  stoppedFor: null,
  tokens: null,
  costUsd: null,
  error,
});

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
};

// Reads Claude Code's stream-json lines. The system init line names the
// model, each assistant message reports its usage, once per message id, and
// the result line has the answer, the total cost and the final usage, which
// wins when present. A result line that says it is an error gives no
// answer.
export class UsageCounter implements StdoutReader {
  private readonly seen = new Map<string, number>();
  private buffer = '';
  private final: number | null = null;
  costUsd: number | null = null;
  text: string | null = null;
  model: string | null = null;

  get tokens(): number | null {
    if (this.final !== null) return this.final;
    if (this.seen.size === 0) return null;
    let sum = 0;
    for (const n of this.seen.values()) sum += n;
    return sum;
  }

  // A chunk of stdout, read a whole line at a time.
  write(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      this.read(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
    }
  }

  end(): void {
    if (this.buffer !== '') this.read(this.buffer);
    this.buffer = '';
  }

  read(line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof json !== 'object' || json === null) return;
    const event = json as {
      type?: unknown;
      subtype?: unknown;
      model?: unknown;
      message?: { id?: unknown; usage?: Usage };
      usage?: Usage;
      total_cost_usd?: unknown;
      result?: unknown;
      is_error?: unknown;
    };
    if (
      event.type === 'system' &&
      event.subtype === 'init' &&
      typeof event.model === 'string'
    ) {
      this.model = event.model;
    }
    if (event.type === 'assistant' && event.message?.usage) {
      const id =
        typeof event.message.id === 'string'
          ? event.message.id
          : `n${this.seen.size}`;
      this.seen.set(id, count(event.message.usage));
    }
    if (event.type === 'result') {
      if (event.usage) this.final = count(event.usage);
      if (typeof event.total_cost_usd === 'number') {
        this.costUsd = event.total_cost_usd;
      }
      if (typeof event.result === 'string' && event.is_error !== true) {
        this.text = event.result;
      }
    }
  }
}

const count = (usage: Usage): number =>
  num(usage.input_tokens) +
  num(usage.output_tokens) +
  num(usage.cache_creation_input_tokens);

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

// The claude arguments. The question goes on stdin.
//
// --tools with an empty list leaves Claude no tool at all, no Bash, no
// Read, no Write and no web, so the answer can only be text, and a spec
// that asks it to run a command, read a file or open a URL has nothing to
// do it with. The CLI takes the text from the result line and submits it.
// The operator's own Claude Code settings never apply to an unattended
// run. --setting-sources with an empty list loads no user, project or
// local settings file, so no permission rule, hook or tool from them.
// --strict-mcp-config with no --mcp-config starts no MCP server. --tools
// takes a list, so it goes last. routine-smoke.test.ts checks this against
// a real claude.
export function claudeArgs(): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--tools',
    '',
  ];
}

// The absolute path of a program on PATH, or null. Checked on disk, never
// by running anything.
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : delimiter)
    .filter((dir) => dir.length > 0);
  const names =
    platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const path = join(dir, candidate);
      try {
        await access(
          path,
          platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        return path;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}
