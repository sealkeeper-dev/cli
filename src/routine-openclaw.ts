// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProblem,
  type AgentResult,
  type AgentRuntime,
  runAgent,
  type Spawner,
  type StdoutReader,
  spawnAgent,
  type Transcript,
} from './routine-agent.js';

// OpenClaw as a routine runtime (VOU-601). Each question is one
// openclaw agent exec, which runs one embedded agent turn with no Gateway,
// reads the question on stdin and prints one JSON envelope on stdout.
// https://docs.openclaw.ai/cli/agent
//
// Every question gets a fresh temp folder, removed after, which holds the
// config below and an empty work folder. --cwd is that work folder, and
// OpenClaw keeps its filesystem tools inside --cwd.
//
// No tools. Left to itself agent exec picks the coding tool profile, which
// has a shell, and an operator's own config may pick more. So the run
// never reads the operator's OpenClaw config. --config pins it to the file
// below, whose tools.deny of * denies every tool, deny winning over any
// allow, and --code-mode direct keeps code mode off. --isolated is not
// used, it runs on the exec defaults and so with the coding profile.
// OpenClaw uses its stored provider credentials with a pinned config, as
// with its own, which openclaw models auth paste-api-key stores.
//
// What the CLI cannot see is whether OpenClaw honours the config, since
// OpenClaw runs the model. The envelope reports tool calls, and an answer
// from a run that reports any is dropped and fails the run.

// The config every question runs on.
export const OPENCLAW_CONFIG = {
  tools: { profile: 'minimal', deny: ['*'] },
} as const;

// The arguments of one question. The question goes on stdin.
export function openclawArgs(o: {
  cwd: string;
  config: string;
  timeoutMs: number;
}): string[] {
  return [
    'agent',
    'exec',
    '--message-file',
    '-',
    '--cwd',
    o.cwd,
    '--config',
    o.config,
    '--code-mode',
    'direct',
    '--json',
    // OpenClaw stops itself at the run's wall clock, and the run kills it
    // there in any case. 0 would turn its timeout off.
    '--timeout',
    String(Math.max(1, Math.floor(o.timeoutMs / 1000))),
  ];
}

export function openclawRuntime(o: {
  command: string;
  env: NodeJS.ProcessEnv;
  spawner?: Spawner;
  transcript?: Transcript | null;
  // Where the temp folders go, the system's temp folder by default.
  tmp?: string;
}): AgentRuntime {
  return {
    name: 'openclaw',
    async ask(question): Promise<AgentResult> {
      let dir: string;
      try {
        dir = await mkdtemp(join(o.tmp ?? tmpdir(), 'sealkeeper-openclaw-'));
      } catch (error) {
        return noFolder(error);
      }
      try {
        const cwd = join(dir, 'work');
        const config = join(dir, 'openclaw.json');
        await mkdir(cwd, { mode: 0o700 });
        await writeFile(config, `${JSON.stringify(OPENCLAW_CONFIG)}\n`, {
          mode: 0o600,
        });
        return await runAgent(
          {
            command: o.command,
            args: openclawArgs({
              cwd,
              config,
              timeoutMs: question.timeoutMs,
            }),
            input: question.prompt,
            cwd,
            env: o.env,
            timeoutMs: question.timeoutMs,
            tokenCap: question.tokenCap,
            transcript: o.transcript ?? null,
            reader: new EnvelopeReader(),
          },
          o.spawner ?? spawnAgent,
        );
      } catch (error) {
        return noFolder(error);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

// A temp folder that could not be made or written fails the run. runAgent
// itself never throws.
const noFolder = (error: unknown): AgentResult => ({
  text: null,
  exitCode: null,
  stoppedFor: null,
  tokens: null,
  costUsd: null,
  problem: {
    kind: 'failed',
    reason: `no temp folder for OpenClaw: ${(error as Error).message}`,
  },
});

// The most stdout an envelope may take. Past it the answer is dropped.
export const ENVELOPE_CAP = 4 * 1024 * 1024;

// A provider credential that is missing or refused, by the error's kind or
// message. Read loosely, since the live wording is not checked yet. The
// message is only matched, never kept, as it may name the key.
const AUTH =
  /auth|credential|api[ _-]?key|unauthori[sz]ed|forbidden|\b40[13]\b/i;

// An error kind short and plain enough to say in the run line.
const PLAIN_KIND = /^[a-z][a-z0-9_.-]{0,39}$/i;

// Reads the one JSON envelope agent exec --json prints, loosely, so a
// field a newer OpenClaw adds or leaves out never breaks the run. ok and
// status say whether the turn worked, final is the answer, payloads the
// answer in parts, usage the tokens, costUsd the cost, error.kind and
// error.message what failed, and toolSummary and bridgeCalls the tool
// calls. Exit 2, or status timeout, is OpenClaw's own timeout.
export class EnvelopeReader implements StdoutReader {
  private out = '';
  private over = false;
  tokens: number | null = null;
  costUsd: number | null = null;
  text: string | null = null;
  timedOut = false;
  problem?: AgentProblem;

  write(chunk: string): void {
    if (this.over) return;
    this.out += chunk;
    if (this.out.length > ENVELOPE_CAP) {
      this.over = true;
      this.out = '';
    }
  }

  end(code: number | null): void {
    const envelope = this.over ? null : envelopeOf(this.out);
    this.out = '';
    if (envelope !== null) this.readUsage(envelope);
    if (code === 2 || envelope?.status === 'timeout') {
      this.timedOut = true;
      return;
    }
    if (envelope === null) {
      this.problem = {
        kind: 'failed',
        reason: this.over
          ? 'OpenClaw printed more than 4 MB, its answer was dropped'
          : `OpenClaw printed no JSON envelope${code === null ? '' : `, exit ${code}`}`,
      };
      return;
    }
    if (toolCalls(envelope) > 0) {
      this.problem = {
        kind: 'tools',
        reason:
          'OpenClaw reported a tool call, which the routine never allows, so its answer was dropped',
      };
      return;
    }
    if (envelope.ok === false || envelope.status === 'error' || code !== 0) {
      this.problem = failureOf(envelope.error, code);
      return;
    }
    this.text = answerOf(envelope);
  }

  private readUsage(envelope: Envelope): void {
    const usage = record(envelope.usage);
    const total = num(usage?.total);
    const input = num(usage?.input);
    const output = num(usage?.output);
    this.tokens =
      total ??
      (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
    this.costUsd = num(envelope.costUsd);
  }
}

type Envelope = Record<string, unknown>;

// The envelope, the whole of stdout as one JSON object, else its last line
// that is one. null when there is none.
export function envelopeOf(out: string): Envelope | null {
  const whole = parseObject(out.trim());
  if (whole !== null) return whole;
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    const found = parseObject(line);
    if (found !== null) return found;
  }
  return null;
}

function parseObject(text: string): Envelope | null {
  if (text === '') return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;

// The tool calls the envelope reports, the model's own and those through
// the code mode bridge.
function toolCalls(envelope: Envelope): number {
  const summary = record(envelope.toolSummary);
  const tools = Array.isArray(summary?.tools) ? summary.tools.length : 0;
  return (
    (num(summary?.calls) ?? 0) +
    tools +
    (num(record(envelope.bridgeCalls)?.call) ?? 0)
  );
}

// final, else the text of the payloads. null when both are empty.
function answerOf(envelope: Envelope): string | null {
  if (typeof envelope.final === 'string' && envelope.final.trim() !== '') {
    return envelope.final;
  }
  const parts = Array.isArray(envelope.payloads)
    ? envelope.payloads
        .map((p) => record(p)?.text)
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : [];
  return parts.length > 0 ? parts.join('\n') : null;
}

function failureOf(error: unknown, code: number | null): AgentProblem {
  const e = record(error);
  const kind = typeof e?.kind === 'string' ? e.kind : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  if (AUTH.test(kind) || AUTH.test(message)) {
    return {
      kind: 'auth',
      reason: 'OpenClaw has no provider credential it can use',
    };
  }
  const said = PLAIN_KIND.test(kind) ? `, ${kind}` : '';
  const exit = code === null || code === 0 ? '' : `, exit ${code}`;
  return { kind: 'failed', reason: `OpenClaw failed${said}${exit}` };
}
