// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedTools,
  claudeArgs,
  findOnPath,
  routinePrompt,
  runAgent,
  spawnAgent,
} from './routine-agent.js';

// The routine's headless Claude Code, for real (RS-11). It starts claude
// with claudeArgs, the exact flags and allow rules a routine run passes, in
// a temp folder, and asks it to write one answer file, run one allowed
// command and two commands outside the rules. It passes when the file is
// there, the allowed command ran and the others were refused. No other test
// runs a real headless Claude, which is how a run that wrote no answer
// file shipped.
//
// It spends real tokens on your Claude Code login, a few cents a run, so it
// is off unless you ask for it.
//
//   SEALKEEPER_ROUTINE_SMOKE=1 pnpm --filter sealkeeper exec vitest run src/routine-smoke.test.ts
//
// Without SEALKEEPER_ROUTINE_SMOKE=1, or without claude on PATH, it is
// skipped.
//
// The game section (GAME-14) runs against a local stack too, when
// SEALKEEPER_ROUTINE_SMOKE_HOME also names the CLI home of an agent
// registered on a local API with the game on, its apiUrl in config.json,
// and the CLI is built (pnpm --filter sealkeeper build). It starts claude
// with the built CLI as the invocation, the game rules and the routine
// prompt with the game section alone, as a run with no task work, and
// passes when the game status read ran and no command of the section was
// refused by the rules. A command SealKeeper refuses, such as one past the
// game cap, still counts as allowed.
//
//   SEALKEEPER_ROUTINE_SMOKE=1 SEALKEEPER_ROUTINE_SMOKE_HOME=~/.sealkeeper/agents/smoke pnpm --filter sealkeeper exec vitest run src/routine-smoke.test.ts

const enabled = process.env.SEALKEEPER_ROUTINE_SMOKE === '1';
const claude = enabled ? await findOnPath('claude') : null;
const smokeHome = process.env.SEALKEEPER_ROUTINE_SMOKE_HOME ?? '';
const built = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'index.js',
);

// Stands in for the CLI's invocation in the Bash rules. echo only prints.
const INVOCATION = 'echo sealkeeper-smoke';
const ANSWER = 'routine smoke ok';

const PROMPT = `You are running a test of your own tool permissions. Do exactly these steps, in order, and nothing else.

1. Use the Write tool to write the text \`${ANSWER}\` to the file \`.sealkeeper-answers/smoke.txt\` in the current directory.
2. Run the Bash command \`${INVOCATION} status\`.
3. Run the Bash command \`curl -sI https://example.com\`. It may be refused. Do not try it any other way.
4. Run the Bash command \`cat /etc/hosts\`. It may be refused. Do not try it any other way.
5. Stop.
`;

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: { command?: string };
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

// The environment claude starts with, as the scheduler starts it, with the
// real home, where the Claude Code login lives, rather than the empty one
// the tests get, and not as a session of the Claude Code this test may run
// under.
function agentEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_'),
      ),
    ),
    HOME: userInfo().homedir,
  };
}

// The Bash calls in a stream-json transcript, each with its result.
function bashCalls(
  transcript: string,
): { command: string; error: boolean; result: string }[] {
  const uses = new Map<string, string>();
  const results = new Map<string, { error: boolean; result: string }>();
  for (const line of transcript.split('\n')) {
    let event: { message?: { content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (block.type === 'tool_use' && block.name === 'Bash' && block.id) {
        uses.set(block.id, block.input?.command ?? '');
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, {
          error: block.is_error === true,
          result: JSON.stringify(block.content ?? ''),
        });
      }
    }
  }
  return [...uses].map(([id, command]) => ({
    command,
    ...(results.get(id) ?? { error: true, result: 'no result' }),
  }));
}

describe('routine smoke (RS-11)', () => {
  if (claude === null) {
    const why = `routine smoke skipped, ${enabled ? 'claude is not on PATH' : 'set SEALKEEPER_ROUTINE_SMOKE=1 to run it, it spends tokens'}`;
    process.stderr.write(`${why}\n`);
    it.skip(why, () => undefined);
    return;
  }

  let cwd = '';
  afterAll(async () => {
    if (cwd !== '') await rm(cwd, { recursive: true, force: true });
  });

  it(
    'writes the answer file, runs the allowed command and is refused the other',
    async () => {
      cwd = await realpath(await mkdtemp(join(tmpdir(), 'sealkeeper-smoke-')));
      const env = agentEnvironment();
      const transcriptPath = join(cwd, 'last-run.jsonl');
      const result = await runAgent(
        {
          command: claude,
          args: claudeArgs(INVOCATION),
          input: PROMPT,
          cwd,
          env,
          timeoutMs: 5 * 60_000,
          tokenCap: 300_000,
          transcript: { path: transcriptPath },
        },
        spawnAgent,
      );
      const transcript = await readFile(transcriptPath, 'utf8');
      const calls = bashCalls(transcript);
      // What it did, on stderr so a passing run shows it too.
      process.stderr.write(
        `${[
          `claude exited ${result.exitCode}, ${result.tokens ?? 0} tokens, $${(result.costUsd ?? 0).toFixed(4)}`,
          ...calls.map(
            (c) =>
              `Bash ${c.command} -> ${c.error ? 'refused' : 'ran'} ${c.result.slice(0, 160)}`,
          ),
        ].join('\n')}\n`,
      );
      expect(result.error).toBeUndefined();
      expect(result.stoppedFor).toBeNull();
      expect(result.exitCode).toBe(0);

      // The write is accepted in the working folder (RS-11).
      const answer = await readFile(
        join(cwd, '.sealkeeper-answers', 'smoke.txt'),
        'utf8',
      );
      expect(answer).toContain(ANSWER);

      // The command the rules name runs.
      const allowed = calls.find((c) =>
        c.command.startsWith(`${INVOCATION} status`),
      );
      expect(allowed?.error).toBe(false);
      expect(allowed?.result).toContain('sealkeeper-smoke status');

      // A command outside the rules is refused, with nobody to ask, a
      // network command and a read outside the working folder alike.
      // acceptEdits lets plain file commands run inside the folder, so
      // those are not what this checks, see claudeArgs.
      for (const outside of ['curl ', 'cat /etc/hosts']) {
        const tried = calls.filter((c) => c.command.startsWith(outside));
        expect(tried.length, outside).toBeGreaterThan(0);
        for (const call of tried) expect(call.error, call.command).toBe(true);
      }
    },
    6 * 60_000,
  );
});

describe('routine smoke, the game section against a local stack (GAME-14)', () => {
  if (claude === null || smokeHome === '' || !existsSync(built)) {
    const why = `routine game smoke skipped, ${claude === null ? 'set SEALKEEPER_ROUTINE_SMOKE=1 with claude on PATH' : smokeHome === '' ? 'set SEALKEEPER_ROUTINE_SMOKE_HOME to a home registered on a local API' : 'build the CLI first'}`;
    process.stderr.write(`${why}\n`);
    it.skip(why, () => undefined);
    return;
  }

  let cwd = '';
  afterAll(async () => {
    if (cwd !== '') await rm(cwd, { recursive: true, force: true });
  });

  it(
    'runs the game commands the section names, none refused by the rules',
    async () => {
      cwd = await realpath(
        await mkdtemp(join(tmpdir(), 'sealkeeper-game-smoke-')),
      );
      const invocation = `"${process.execPath}" "${built}"`;
      const transcriptPath = join(cwd, 'last-run.jsonl');
      const result = await runAgent(
        {
          command: claude,
          args: claudeArgs(invocation, null, true),
          input: routinePrompt(invocation, [], {
            post: null,
            run: false,
            game: true,
          }),
          cwd,
          // The routine rules, for the home named, as a run sets them.
          env: {
            ...agentEnvironment(),
            SEALKEEPER_HOME: smokeHome,
            SEALKEEPER_ROUTINE_RUN: randomUUID(),
            SEALKEEPER_INVOCATION: invocation,
          },
          timeoutMs: 10 * 60_000,
          tokenCap: 600_000,
          transcript: { path: transcriptPath },
        },
        spawnAgent,
      );
      const calls = bashCalls(await readFile(transcriptPath, 'utf8'));
      process.stderr.write(
        `${[
          `claude exited ${result.exitCode}, ${result.tokens ?? 0} tokens, $${(result.costUsd ?? 0).toFixed(4)}`,
          ...calls.map(
            (c) =>
              `Bash ${c.command} -> ${c.error ? 'error' : 'ran'} ${c.result.slice(0, 160)}`,
          ),
        ].join('\n')}\n`,
      );
      expect(result.error).toBeUndefined();
      expect(result.stoppedFor).toBeNull();
      expect(result.exitCode).toBe(0);

      // The section starts with the switch, read through its rule.
      const status = calls.find((c) =>
        c.command.startsWith(`${invocation} game status --json`),
      );
      expect(status?.error).toBe(false);
      // Every command of the CLI it ran is one the run's rules allow, a
      // submit of a game task included, and the rules refused none of
      // them. An answer SealKeeper refuses is an error of the command,
      // never a refusal by the rules. A rule ending :* matches its words
      // alone or with more after them.
      const rules = allowedTools(invocation, null, true).map((rule) =>
        rule.slice(`Bash(${invocation} `.length, -1),
      );
      const ours = calls.filter((c) => c.command.startsWith(invocation));
      expect(ours.length).toBeGreaterThan(0);
      for (const call of ours) {
        const rest = call.command.slice(invocation.length + 1);
        expect(
          rules.some((rule) =>
            rule.endsWith(':*')
              ? rest === rule.slice(0, -2) ||
                rest.startsWith(`${rule.slice(0, -2)} `)
              : rest === rule,
          ),
          call.command,
        ).toBe(true);
        expect(call.result, call.command).not.toMatch(
          /requested permissions|haven't granted/i,
        );
      }
    },
    11 * 60_000,
  );
});
