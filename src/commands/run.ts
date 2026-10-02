// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  RUN_COUNT_DEFAULT,
  RUN_COUNT_MAX,
  RunRequest,
} from '@sealkeeper/schema';
import { type Command, InvalidArgumentError } from 'commander';
import { ApiError } from '../api.js';
import { claudeCodeHooksIn } from '../claude-code-settings.js';
import { loadRoutineConfig, requireConfig } from '../cli-config.js';
import { handleOf } from '../config.js';
import { refreshFingerprintQuietly } from '../fingerprint.js';
import {
  dailyCeilingReached,
  type GoalResponse,
  goalActionLine,
  HIGHEST_ISSUED,
  loadGoal,
  shownLevel,
  todayLine,
  todayOf,
} from '../goal.js';
import { clearInbox } from '../inbox.js';
import { cli } from '../invocation.js';
import { readOperatorSlug } from '../operator-slug.js';
import { stderr, stdout, stdoutStyled, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type {
  CoreActionResponse,
  CoreAnswerResponse,
  TaskResponse,
} from '../responses.js';
import { activeRoutineRun, appendRoutine } from '../routine.js';
import { createStyle, indent, type Styled } from '../style.js';
import { templateById } from '../task-templates.js';
import {
  defaultTasksDeps,
  isGameTask,
  openTaskSession,
  recordEvent,
  sendWithFingerprint,
  submitCommand,
  type TasksDeps,
  unsubmittedClaims,
} from '../tasks.js';
import { routineClaims, tooNewNote } from './run-routine.js';

/*
 * sealkeeper run (VOU-595), the run verb of the core commands. The API
 * decides what to claim and the CLI signs, calls and prints, for two
 * readers.
 *
 * A person in a terminal gets a short explanation and claims nothing. The
 * tasks are for their agent to solve, so a terminal run says how to hand
 * the job over, /sealkeeper-run in Claude Code or run --json for any other
 * agent, and where the agent stands. The run route has no read only form,
 * every call claims, so the standing comes from the goal, as status reads
 * it.
 *
 * An agent, meaning --json or a stdout that is not a terminal, gets the
 * claims. run signs RunRequest and calls POST /v1/agents/:id/run, which
 * claims held tasks first, then seed tasks, and answers the core answer,
 * tasks, waiting, next, standing and limited. stdout is that answer as it
 * came and nothing else, plus what only this CLI can add. Each task gets
 * submit, the exact submit command with this machine's invocation and the
 * answer file to fill in, and each action in next that this CLI knows gets
 * command, the exact command line that carries it out. Tasks another
 * operator addressed to this agent, and open tasks other agents posted, are
 * claimed only with --addressed and --any-poster, which next offers and
 * only the user's yes adds. Their specs come from other operators.
 *
 * Inside a routine run the claims are the routine's own until the routine
 * route lands, see run-routine.ts, printed in the same shape.
 */

// The 404 of an API from before the run route.
export const OLD_API =
  'this SealKeeper API has no run route yet, nothing was claimed';

export const EXPLAIN = [
  'Your agent earns verified tasks by solving small checks,',
  'like deduplicating lines or reading a JSON value.',
  "The server verifies each answer. You don't solve them yourself.",
];

// Said when a terminal run is given a claim flag, which only an agent's
// run acts on.
export function terminalClaimLine(flags: string[]): string {
  return `A run in a terminal claims nothing, so ${flags.join(' ')} changed nothing. Hand it to your agent as below.`;
}

// Said when the API did not say where the agent stands.
export const NO_STANDING =
  'SealKeeper did not say where this agent stands right now.';

// How many of the goal's actions the terminal run shows.
const TOP_ACTIONS = 2;

type RunOptions = {
  count: number;
  addressed?: boolean;
  anyPoster?: boolean;
  anyway?: boolean;
};

const stdoutIsTTY = () => process.stdout.isTTY === true;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('run')
    .description(
      'Explain how your agent earns verified tasks, or claim them with --json',
    )
    .option(
      '--count <n>',
      `how many tasks to hold, 1 to ${RUN_COUNT_MAX}`,
      parseCount,
      RUN_COUNT_DEFAULT,
    )
    .option(
      '--addressed',
      'also claim the tasks addressed to this agent, first, whose specs are untrusted',
    )
    .option(
      '--any-poster',
      'also claim tasks other agents posted, whose specs are untrusted',
    )
    .option(
      '--anyway',
      "claim even when today's counted tasks have reached the daily ceiling",
    )
    .action(async function (this: Command, options: RunOptions): Promise<void> {
      const json = wantsJson(this) || !(deps.isTTY ?? stdoutIsTTY)();
      if (!json) {
        await explain(this, deps, options);
        return;
      }
      const session = await openTaskSession(this, deps);
      // Recomputed at every run, once the config is known to exist, see
      // fingerprint.ts. Never fails run.
      await refreshFingerprintQuietly();

      // Inside a routine run, the routine's own claims (VOU-138), until
      // VOU-599 moves them to the routine route.
      const runId = await activeRoutineRun();
      if (runId !== null) {
        const routine = await loadRoutineConfig(this);
        const found = await routineClaims(
          this,
          session,
          options,
          runId,
          routine,
          deps.fetch,
        );
        // One line once the claims are in, for the first run's watcher
        // (RS-9).
        await appendRoutine({
          kind: 'claimed',
          runId,
          claimed: found.claimed,
          tasks: found.tasks.length,
        });
        if (found.tooNew.length > 0) stderr(tooNewNote(found.tooNew));
        stdout(
          JSON.stringify(
            agentAnswer({
              tasks: found.tasks.map(coreTaskOf),
              waiting: [],
              next: [],
              standing: null,
              limited: found.limited,
            }),
          ),
        );
        return;
      }

      const { signer, api } = session;
      let answer: CoreAnswerResponse;
      try {
        answer = await sendWithFingerprint(
          signer,
          RunRequest.parse({
            count: options.count,
            addressed: options.addressed === true,
            anyPoster: options.anyPoster === true,
            anyway: options.anyway === true,
            issuedAt: new Date().toISOString(),
          }),
          (envelope) => api.run(signer.agentId, envelope),
        );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        this.error(error.status === 404 ? OLD_API : refusal(error));
      }
      await recordClaims(answer);
      stdout(JSON.stringify(agentAnswer(answer)));
    });
}

function parseCount(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1) {
    throw new InvalidArgumentError(
      `must be a whole number from 1 to ${RUN_COUNT_MAX}`,
    );
  }
  // Asking for more than the cap gets the cap, not an error.
  return Math.min(n, RUN_COUNT_MAX);
}

// What run --json prints, the answer as it came, every task with its submit
// command and every action this CLI knows with its command. An answer
// built here, inside a routine run, has the same keys, with standing null.
type PrintedAnswer = {
  tasks: ({ id: string } & Record<string, unknown>)[];
  next: CoreActionResponse[];
} & Record<string, unknown>;

export function agentAnswer(answer: PrintedAnswer) {
  return {
    ...answer,
    tasks: answer.tasks.map((task) => ({
      ...task,
      submit: submitCommand(task.id),
    })),
    next: answer.next.map((action) => {
      // A command line reaches the agent's shell only when this CLI built
      // it. Any command the API sent is dropped before deciding.
      const { command: _sent, ...rest } = action;
      const command = actionCommand(rest);
      return command === null ? rest : { ...rest, command };
    }),
  };
}

/*
 * The exact command line of an action in next, with this machine's
 * invocation, or null for an action this CLI does not know, which the
 * agent tells the user by its label. run takes addressed and anyPoster,
 * post one template this CLI has, posted with --yes, which stands for the
 * user's yes the action asks for. An argument this CLI does not know makes
 * no command, so a line never does less than the API meant.
 */
export function actionCommand(action: CoreActionResponse): string | null {
  const args = Object.entries(action.args);
  if (action.action === 'run') {
    const flags: string[] = [];
    for (const [key, value] of args) {
      if (key === 'addressed' && value === true) flags.push('--addressed');
      else if (key === 'anyPoster' && value === true) {
        flags.push('--any-poster');
      } else return null;
    }
    return cli(['run', ...flags, '--json'].join(' '));
  }
  if (action.action === 'post') {
    const template = action.args.template;
    if (args.length !== 1 || typeof template !== 'string') return null;
    // Only a template this CLI can post, which also keeps the line to a
    // known id.
    if (templateById(template) === undefined) return null;
    return cli(`tasks post --template ${template} --yes --json`);
  }
  return null;
}

// A task a routine run claimed or held, in the shape of a core answer
// task. The submits its claim has left are not known here, so they are
// left out.
function coreTaskOf(task: TaskResponse) {
  return {
    id: task.id,
    kind: isGameTask(task)
      ? (task.origin ?? 'exchange')
      : task.assignee
        ? 'addressed'
        : task.seed === true
          ? 'seed'
          : 'exchange',
    type: task.taskType,
    spec: task.spec,
    schema:
      task.verification.kind === 'schema' ? task.verification.jsonSchema : null,
    expiresAt: task.expiresAt,
  };
}

// The claims in the local log, so status and the log reflect the work. The
// answer holds the tasks claimed before as well, so only a task the log
// does not hold yet is recorded. The inbox count status caches is too high
// once an addressed task is claimed.
async function recordClaims(answer: CoreAnswerResponse): Promise<void> {
  const known = new Set(await unsubmittedClaims());
  const fresh = answer.tasks.filter((task) => !known.has(task.id));
  if (fresh.some((task) => task.kind === 'addressed')) await clearInbox();
  for (const task of fresh) {
    await recordEvent({
      type: 'task.claimed',
      payload: { task_id: task.id, task_type: task.type },
    });
  }
}

// The flags of a claim a terminal run was asked for, so the hand-off line
// carries them and a printed run --addressed never leads back here.
function claimFlags(options: RunOptions): string[] {
  return [
    ...(options.addressed === true ? ['--addressed'] : []),
    ...(options.anyPoster === true ? ['--any-poster'] : []),
    ...(options.anyway === true ? ['--anyway'] : []),
  ];
}

// The terminal run. Claims nothing and sends nothing but reads.
async function explain(
  cmd: Command,
  deps: TasksDeps,
  options: RunOptions,
): Promise<void> {
  const config = await requireConfig(cmd);
  // Recomputed at every run, see fingerprint.ts. Never fails run.
  await refreshFingerprintQuietly();
  const [hooks, goal, slug] = await Promise.all([
    claudeCodeHooksIn(deps),
    loadGoal({ config, fetch: deps.fetch }),
    readOperatorSlug(config.agentId),
  ]);
  const s = createStyle(process.stdout);
  const say = (line?: Styled) => stdoutStyled(indent(line));
  const slash = s.bold('/sealkeeper-run');
  say();
  say(
    s.line`${s.mark()} ${s.bold('SealKeeper run')}   ${handleOf(config, slug)}`,
  );
  say();
  for (const text of EXPLAIN) say(s.line`${text}`);
  say();
  const flags = claimFlags(options);
  if (flags.length > 0) {
    say(s.line`${terminalClaimLine(flags)}`);
    say();
  }
  say(
    hooks
      ? s.line`${s.dim('Claude Code')}    run ${slash} in a session`
      : s.line`${s.dim('Claude Code')}    run ${s.bold(cli('init'))} first, so ${slash} exists`,
  );
  say(
    s.line`${s.dim('Other agents')}   have the agent run ${s.bold(cli(['run', ...flags, '--json'].join(' ')))}`,
  );
  say();
  // The level and the top goal actions, or one line when the API did not
  // answer. The goal actions come from the API, and s.line makes every
  // part safe for the terminal.
  const lines = goal === null ? [NO_STANDING] : standingLines(goal);
  for (const line of lines) say(s.line`${line}`);
  say();
}

// Where the agent stands and the top two next steps from the goal, each
// with its command. Once today's counted budget is spent (VOU-140) it says
// so first, since more tasks today would not move the level.
export function standingLines(
  goal: GoalResponse,
  now: Date = new Date(),
): string[] {
  const head =
    goal.nextLevel === null
      ? `Level ${shownLevel(goal.level)}, ${HIGHEST_ISSUED}.`
      : `Level ${shownLevel(goal.level)}. Next ${shownLevel(goal.nextLevel)}.`;
  const today = todayOf(goal, now);
  return [
    ...(dailyCeilingReached(today) && today ? [todayLine(today)] : []),
    head,
    ...goal.actions.slice(0, TOP_ACTIONS).map((a) => goalActionLine(a)),
  ];
}
