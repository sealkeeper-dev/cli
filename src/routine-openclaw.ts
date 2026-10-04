// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openclawModelOf } from './config.js';
import {
  type AgentProblem,
  type AgentProcess,
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
// with its own, which openclaw models auth paste-api-key stores, and a key
// in the environment, such as GEMINI_API_KEY.
//
// The pinned config also drops the operator's default model, and with no
// model named OpenClaw picks its own built-in default, an OpenAI model,
// whatever key is stored. So every question names the routine's model with
// --model (VOU-623), which routine.json keeps, see OpenClawModel in
// config.ts.
//
// The live check of 4 October 2026 (VOU-600, OpenClaw 2026.9.8) saw a
// model asked to write a file under this config fail its turn with no file
// made. The CLI still cannot see inside a turn, since OpenClaw runs the
// model. The envelope reports tool calls, and an answer from a run that
// reports any is dropped and fails the run.

// The config every question runs on.
export const OPENCLAW_CONFIG = {
  tools: { profile: 'minimal', deny: ['*'] },
} as const;

// Why an OpenClaw routine with no model cannot run, which fails the run
// before its first step.
export const NO_MODEL: AgentProblem = {
  kind: 'model',
  reason: 'no model is set for OpenClaw',
};

// The arguments of one question. The question goes on stdin. model is
// checked by OpenClawModel before it gets here and goes as its own
// argument.
export function openclawArgs(o: {
  cwd: string;
  config: string;
  model: string;
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
    '--model',
    o.model,
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
  model: string;
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
              model: o.model,
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
// message, read loosely. The live check saw "No route-compatible
// authentication source is configured for openai." and "No API key found
// for provider anthropic". A model the provider does not have, by the
// message the live check saw, or one OpenClaw's own catalog does not know,
// "Unknown model:", said before any provider is asked (OpenClaw 2026.9.8).
// A message is only matched, never kept, as it may name the key.
const AUTH =
  /auth|credential|api[ _-]?key|unauthori[sz]ed|forbidden|\b40[13]\b/i;
const MODEL_NOT_FOUND = /selected model was not found|\bunknown model\b/i;

// An error kind short and plain enough to say in the run line.
const PLAIN_KIND = /^[a-z][a-z0-9_.-]{0,39}$/i;

// Reads the one JSON envelope agent exec --json prints, loosely, so a
// field a newer OpenClaw adds or leaves out never breaks the run. As the
// live check saw it, ok and status say whether the turn worked, final is
// the answer and payloads the answer in parts, usage the tokens, input,
// output, cacheRead, cacheWrite and total, with the cost in usage.cost.total
// (costUsd is read when that is absent), model the model id that answered,
// error.kind and error.message what failed. toolSummary.tools lists the
// tools that were called, never the tools on offer, and bridgeCalls counts
// the code mode bridge's calls and may be there with all zeros. A turn that
// calls no tool has neither. Exit 2, with status timeout, is OpenClaw's own
// timeout and nothing else, a usage error is exit 1. The envelope also names
// the provider, which is not read, so the id is the one the live adapter
// reads from llm_output and both hash alike (VOU-614).
export class EnvelopeReader implements StdoutReader {
  private out = '';
  private over = false;
  tokens: number | null = null;
  costUsd: number | null = null;
  text: string | null = null;
  model: string | null = null;
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
    if (envelope !== null) this.readReport(envelope);
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

  // The tokens, the cost and the model the envelope reports, on any outcome.
  private readReport(envelope: Envelope): void {
    const usage = record(envelope.usage);
    const total = num(usage?.total);
    const input = num(usage?.input);
    const output = num(usage?.output);
    this.tokens =
      total ??
      (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
    this.costUsd = num(record(usage?.cost)?.total) ?? num(envelope.costUsd);
    this.model = typeof envelope.model === 'string' ? envelope.model : null;
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
  if (MODEL_NOT_FOUND.test(message)) {
    return {
      kind: 'model',
      reason: "OpenClaw or its provider did not find the routine's model",
    };
  }
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

// How long the setup waits for OpenClaw to say its default model.
const DEFAULT_MODEL_TIMEOUT_MS = 10_000;
// The most of its answer that is read.
const DEFAULT_MODEL_CAP = 64 * 1024;

// The operator's own default model, from openclaw config get
// agents.defaults.model --json, which prints the model ref as a JSON
// string, or an object whose primary is one, and exits 1 when the operator
// set none, as OpenClaw then falls back to a built-in default the operator
// may hold no key for. https://docs.openclaw.ai/cli/config
// Read loosely, with a timeout, and null on anything else, so the setup
// never fails on it.
export function openclawDefaultModel(o: {
  command: string;
  env: NodeJS.ProcessEnv;
  spawner?: Spawner;
  timeoutMs?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let child: AgentProcess;
    try {
      child = (o.spawner ?? spawnAgent)(
        o.command,
        ['config', 'get', 'agents.defaults.model', '--json'],
        { cwd: tmpdir(), env: o.env },
      );
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (model: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(model);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, o.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (out.length < DEFAULT_MODEL_CAP) out += String(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) =>
      finish(code === 0 ? defaultModelOf(out) : null),
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
}

// The model in what openclaw config get printed, a string or primary.
function defaultModelOf(out: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(out.trim());
  } catch {
    return null;
  }
  return openclawModelOf(
    typeof value === 'string' ? value : record(value)?.primary,
  );
}
