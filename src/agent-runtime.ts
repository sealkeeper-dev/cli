// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import {
  type AgentResponse,
  RUNTIME_LABELS,
  RUNTIMES,
  type Runtime,
  UpdateAgentRequest,
} from '@sealkeeper/schema';
import { z } from 'zod';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from './api.js';
import { cleanAnswer, type Input, readYesNo } from './ask.js';
import { claudeCodeHooksIn } from './claude-code-settings.js';
import {
  type Config,
  ensureHome,
  type Paths,
  paths,
  writeFileAtomic,
} from './config.js';
import { readEnv } from './env.js';
import { KeyError, loadSigner, type Signer } from './identity.js';
import { cli } from './invocation.js';
import { promptStyled, stderrStyled } from './output.js';
import { refusal } from './refusal.js';
import { createStyle, type Styled } from './style.js';

// What an agent runs in, as the operator declares it (VOU-176). init
// detects a likely runtime from the environment and the installed Claude
// Code hooks, and the operator confirms it or picks one. --runtime sets it
// without a question. An agent the API has as unknown, registered before
// runtimes or without a terminal, gets the question once on its next
// interactive run, and the answer goes out as the signed PATCH.

// What the operator can pick. unknown is what not answering leaves.
export const RUNTIME_CHOICES: readonly Runtime[] = RUNTIMES.filter(
  (r) => r !== 'unknown',
);

// A runtime detected on this machine and what gave it away, for the
// question. Only a hint, the operator confirms it.
export type DetectedRuntime = { runtime: Runtime; from: string };

// Variables the runtimes set in the shells they spawn, each read in the
// source or official docs of the named release (VOU-189, 26 September 2026).
// Checked in this order, the first one set wins. CLAUDECODE comes last.
// The Claude Code IDE extensions set it in every integrated terminal, so a
// Codex, Cursor or Gemini agent started from one inherits it. Its own
// variable, set only in the shells it runs, says more, and wins.
//
// Codex CLI rust-v0.157.1 sets CODEX_THREAD_ID for every command the model
// runs (unified exec) and every command the user runs with !, sandboxed or
// not. CODEX_SANDBOX=seatbelt is set only under the macOS Seatbelt sandbox
// and CODEX_SANDBOX_NETWORK_DISABLED=1 only when network is restricted.
// Both stay as backups for a Codex shell without CODEX_THREAD_ID.
// https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/unified_exec/process_manager.rs
// https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/tasks/user_shell.rs
// https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/sandboxing/mod.rs
//
// Cursor Agent CLI 2026.09.26-dd393fe sets CURSOR_AGENT=1 for the shell
// commands it runs (read in its bundled index.js, the CLI is closed
// source). The Cursor editor's agent sets it too, which is still Cursor.
// https://cursor.com/docs/agent/tools/terminal
// https://downloads.cursor.com/lab/2026.09.26-dd393fe/darwin/arm64/agent-cli-package.tar.gz
//
// Gemini CLI v0.61.0 sets GEMINI_CLI=1 for run_shell_command.
// https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/services/shellExecutionService.ts
// https://github.com/google-gemini/gemini-cli/blob/v0.61.0/docs/tools/shell.md
//
// Claude Code 2.1.283 sets CLAUDECODE=1 for its Bash and PowerShell tools,
// hooks, status line and stdio MCP servers, and its IDE extensions set it
// in their integrated terminals.
// https://code.claude.com/docs/en/env-vars
export const RUNTIME_ENV: readonly (readonly [string, Runtime])[] = [
  ['CODEX_THREAD_ID', 'codex'],
  ['CODEX_SANDBOX', 'codex'],
  ['CODEX_SANDBOX_NETWORK_DISABLED', 'codex'],
  ['CURSOR_AGENT', 'cursor'],
  ['GEMINI_CLI', 'gemini-cli'],
  ['CLAUDECODE', 'claude-code'],
];

// The runtime this machine points at. The environment first, since it says
// what is running init right now, then SealKeeper hooks in the Claude Code
// settings. null when nothing points anywhere.
export async function detectRuntime(
  options: {
    env?: NodeJS.ProcessEnv;
    claudeDir?: () => string;
    cwd?: () => string;
  } = {},
): Promise<DetectedRuntime | null> {
  const env = options.env ?? process.env;
  for (const [name, runtime] of RUNTIME_ENV) {
    if (readEnv(name, env) !== undefined) return { runtime, from: name };
  }
  const hooks = await claudeCodeHooksIn({
    claudeDir: options.claudeDir,
    cwd: options.cwd,
  }).catch(() => false);
  return hooks
    ? { runtime: 'claude-code', from: 'the Claude Code hooks' }
    : null;
}

// A runtime from --runtime or agent runtime. The id, as in claude-code.
export function parseRuntime(value: string): Runtime | null {
  const runtime = value.trim().toLowerCase();
  return (RUNTIMES as readonly string[]).includes(runtime)
    ? (runtime as Runtime)
    : null;
}

export const RUNTIME_RULES = `use one of ${RUNTIMES.join(', ')}`;

// Asked again after an answer that is not clear, up to this many questions
// in all, then the runtime stays unknown.
export const RUNTIME_MAX_ASKS = 3;

export const runtimeConfirmQuestion = (detected: DetectedRuntime): string =>
  `This agent runs in ${RUNTIME_LABELS[detected.runtime]}, from ${detected.from}. Right?`;
export const RUNTIME_PICK_INTRO = 'What does this agent run in?';
export const RUNTIME_PICK_QUESTION = 'Number or name, Enter to skip';

// The numbered list, on one line, as in 1 Claude Code  2 Codex.
export function runtimeMenu(): string {
  return RUNTIME_CHOICES.map((r, i) => `${i + 1} ${RUNTIME_LABELS[r]}`).join(
    '  ',
  );
}

// An answer to the pick question. A number from the menu, an id such as
// gemini-cli or a label such as Gemini CLI, in any case. Empty is skip,
// null. Anything else is unclear.
export function readRuntimeAnswer(answer: string): Runtime | null | 'unclear' {
  const clean = cleanAnswer(answer).toLowerCase();
  if (clean === '') return null;
  if (/^\d+$/.test(clean)) {
    return RUNTIME_CHOICES[Number(clean) - 1] ?? 'unclear';
  }
  const found = RUNTIME_CHOICES.find(
    (r) => r === clean || RUNTIME_LABELS[r].toLowerCase() === clean,
  );
  return found ?? 'unclear';
}

// The runtime question on stderr. With a detected runtime, a yes takes it
// and a no goes on to the list. null when the operator skips or the input
// closes, so the runtime stays unknown. layout lets init indent the lines
// like its other questions.
export async function askRuntime(
  input: Input,
  detected: DetectedRuntime | null,
  layout: (line: Styled) => Styled = (line) => line,
): Promise<Runtime | null> {
  const e = createStyle(process.stderr);
  if (detected !== null) {
    const question = runtimeConfirmQuestion(detected);
    let answer: 'yes' | 'no' | 'unclear' = 'unclear';
    for (let asked = 0; asked < RUNTIME_MAX_ASKS; asked++) {
      const again = asked === 0 ? '' : 'Please answer y or n. ';
      promptStyled(layout(e.line`${again}${question} ${e.dim('[Y/n]')} `));
      const line = await input.readLine();
      if (line === null) return null;
      answer = readYesNo(line, 'yes');
      if (answer !== 'unclear') break;
    }
    if (answer === 'yes') return detected.runtime;
    if (answer === 'unclear') return null;
  }
  stderrStyled(layout(e.line`${RUNTIME_PICK_INTRO}`));
  stderrStyled(layout(e.line`${e.dim(runtimeMenu())}`));
  for (let asked = 0; asked < RUNTIME_MAX_ASKS; asked++) {
    const again =
      asked === 0
        ? ''
        : `Please answer with a number from 1 to ${RUNTIME_CHOICES.length}. `;
    promptStyled(layout(e.line`${again}${RUNTIME_PICK_QUESTION} `));
    const line = await input.readLine();
    if (line === null) return null;
    const answer = readRuntimeAnswer(line);
    if (answer !== 'unclear') return answer;
  }
  return null;
}

// Whether this agent was asked already, kept in runtime-question.json with
// the agent id, so a new agent on the same machine is asked again. A file
// that is missing or does not parse counts as never asked.
const RuntimeQuestionState = z.strictObject({
  v: z.literal(1),
  agentId: z.string().min(1),
  askedAt: z.iso.datetime({ offset: true }),
});

export async function wasAskedRuntime(
  agentId: string,
  p: Paths = paths(),
): Promise<boolean> {
  try {
    const state = RuntimeQuestionState.safeParse(
      JSON.parse(await readFile(p.runtimeQuestion, 'utf8')),
    );
    return state.success && state.data.agentId === agentId;
  } catch {
    return false;
  }
}

// A failure to write is ignored, the worst case is being asked again.
export async function recordRuntimeAsked(
  agentId: string,
  now: Date = new Date(),
  p: Paths = paths(),
): Promise<void> {
  try {
    await ensureHome(p);
    await writeFileAtomic(
      p.runtimeQuestion,
      `${JSON.stringify({ v: 1, agentId, askedAt: now.toISOString() })}\n`,
    );
  } catch {
    // Asked again next time.
  }
}

// Sends the runtime as the signed PATCH /v1/agents/:id. issuedAt is signed
// with it, so the API can refuse an old envelope sent again.
export async function changeRuntime(options: {
  api: ApiClient;
  signer: Signer;
  agentId: string;
  runtime: Runtime;
}): Promise<AgentResponse> {
  const request = UpdateAgentRequest.parse({
    runtime: options.runtime,
    issuedAt: new Date().toISOString(),
  });
  return options.api.patchAgent(
    options.agentId,
    await options.signer.sign(request, 'agent.update'),
  );
}

// What offerRuntime says. ok for the line that confirms the change, info
// for everything else. init styles them, status prints them plain.
export type RuntimeReport = {
  ok(text: string): void;
  info(text: string): void;
};

export const RUNTIME_UNKNOWN_INTRO =
  'SealKeeper does not know what this agent runs in yet. You are asked once.';
export const RUNTIME_LATER = `Runtime left unknown. Run ${cli('agent runtime <runtime>')} to set it later.`;

// The one time question for an agent the API has as unknown, on an
// interactive run of init or status. readRuntime gives what the API
// answered, undefined when it did not say, which asks nothing. It is read
// only after the cheap checks, so a run that will not ask sends nothing.
// The question is recorded as asked whatever the answer, so it never comes
// back. A refusal or a missing key ends only this, the command goes on.
export async function offerRuntime(options: {
  config: Pick<Config, 'agentId' | 'apiUrl'>;
  readRuntime: () => Promise<string | undefined>;
  input: Input | undefined;
  fetch: typeof fetch;
  report: RuntimeReport;
  layout?: (line: Styled) => Styled;
  claudeDir?: () => string;
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  paths?: Paths;
}): Promise<void> {
  const { config, input, report } = options;
  const p = options.paths ?? paths();
  if (input === undefined || !input.isTTY) return;
  if (await wasAskedRuntime(config.agentId, p)) return;
  const current = await options.readRuntime();
  if (current !== 'unknown') {
    // An agent that already says what it runs in never needs the
    // question, so recording that spares every later run the agent read.
    // No answer from the API asks next time.
    if (current !== undefined) {
      await recordRuntimeAsked(config.agentId, new Date(), p);
    }
    return;
  }
  report.info(RUNTIME_UNKNOWN_INTRO);
  const detected = await detectRuntime({
    env: options.env,
    claudeDir: options.claudeDir,
    cwd: options.cwd,
  });
  const runtime = await askRuntime(input, detected, options.layout);
  await recordRuntimeAsked(config.agentId, new Date(), p);
  if (runtime === null) {
    report.info(RUNTIME_LATER);
    return;
  }
  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: options.fetch,
  });
  try {
    await changeRuntime({
      api,
      signer: await loadSigner(api.apiUrl, p),
      agentId: config.agentId,
      runtime,
    });
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof KeyError)) {
      throw error;
    }
    const reason = error instanceof ApiError ? refusal(error) : error.message;
    report.info(
      `runtime not set, ${reason}. Run ${cli(`agent runtime ${runtime}`)} to try again.`,
    );
    return;
  }
  report.ok(`Runtime set to ${RUNTIME_LABELS[runtime]}`);
}
