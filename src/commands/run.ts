// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  AgentRef,
  RUN_COUNT_DEFAULT,
  RUN_COUNT_MAX,
  RunRequest,
  TaskCategory,
} from '@sealkeeper/schema';
import { type Command, InvalidArgumentError } from 'commander';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { claudeCodeHooksIn } from '../claude-code-settings.js';
import { loadRoutineConfig, requireConfig } from '../cli-config.js';
import { handleOf } from '../config.js';
import { refreshFingerprintQuietly } from '../fingerprint.js';
import { HIGHEST_ISSUED, shownLevel } from '../goal.js';
import { cli } from '../invocation.js';
import { keepNudgeFresh } from '../nudge.js';
import { readOperatorSlug } from '../operator-slug.js';
import { stderr, stdout, stdoutStyled, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type {
  CoreActionResponse,
  CoreAnswerResponse,
  StatusAnswerResponse,
  TaskResponse,
} from '../responses.js';
import { activeRoutineRun, appendRoutine } from '../routine.js';
import { readStatus } from '../status-answer.js';
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
import { dailyCeilingReached, todayLine, todayOf } from '../today.js';
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
 * every call claims, so the standing comes from the status route, which
 * claims nothing, as status reads it (status-answer.ts).
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

// How many of the status answer's actions the terminal run shows.
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
 * user's yes the action asks for. challenge and sync take no argument, and
 * sync asks before it sends while auto sync is off. duel takes one form of
 * the duel command, see duelWords. An argument this CLI does not know makes
 * no command, so a line never does less than the API meant. run, challenge,
 * duel and status use it. For a person, reader person, it is the same
 * command without --json and without the --yes that stands for a yes, so
 * run hands the work to the agent and a post asks first.
 */
export function actionCommand(
  action: CoreActionResponse,
  reader: 'agent' | 'person' = 'agent',
): string | null {
  const args = Object.entries(action.args);
  const agent = reader === 'agent';
  if (action.action === 'sync') return args.length === 0 ? cli('sync') : null;
  if (action.action === 'challenge') {
    return args.length === 0
      ? cli(['challenge', ...(agent ? ['--json'] : [])].join(' '))
      : null;
  }
  if (action.action === 'run') {
    const flags: string[] = [];
    for (const [key, value] of args) {
      if (key === 'addressed' && value === true) flags.push('--addressed');
      else if (key === 'anyPoster' && value === true) {
        flags.push('--any-poster');
      } else return null;
    }
    return cli(['run', ...flags, ...(agent ? ['--json'] : [])].join(' '));
  }
  if (action.action === 'duel') {
    const words = duelWords(action.args);
    if (words === null) return null;
    return cli([...words, ...(agent ? ['--json'] : [])].join(' '));
  }
  if (action.action === 'post') {
    const template = action.args.template;
    if (args.length !== 1 || typeof template !== 'string') return null;
    // Only a template this CLI can post, which also keeps the line to a
    // known id.
    if (templateById(template) === undefined) return null;
    return cli(
      `tasks post --template ${template}${agent ? ' --yes --json' : ''}`,
    );
  }
  return null;
}

/*
 * The words of the duel command for the args of a duel action, the request
 * fields of the duel route, or null. No args is the step with no form.
 * accept, decline and rematch take a duel id, cancel and list true, and
 * invite an agent by id or handle, with a category or without. Each value
 * is checked with the API's own schema, so a line only ever carries a
 * UUID, an agent ref or a category. An agent id that starts with a hyphen
 * would read as an option, so it makes no command.
 */
const DUEL_ID_FLAGS: Record<string, string> = {
  accept: '--accept',
  decline: '--decline',
  rematch: '--rematch',
};

export function duelWords(args: CoreActionResponse['args']): string[] | null {
  const entries = Object.entries(args);
  if (entries.length === 0) return ['duel'];
  const { invite, category } = args;
  if (invite !== undefined) {
    if (
      entries.length > (category === undefined ? 1 : 2) ||
      typeof invite !== 'string' ||
      invite.startsWith('-') ||
      !AgentRef.safeParse(invite).success ||
      (category !== undefined && !TaskCategory.safeParse(category).success)
    ) {
      return null;
    }
    return category === undefined
      ? ['duel', invite]
      : ['duel', invite, '--category', String(category)];
  }
  const [entry, ...more] = entries;
  if (entry === undefined || more.length > 0) return null;
  const [key, value] = entry;
  const flag = DUEL_ID_FLAGS[key];
  if (flag !== undefined) {
    return typeof value === 'string' && z.uuid().safeParse(value).success
      ? ['duel', flag, value]
      : null;
  }
  if ((key === 'cancel' || key === 'list') && value === true) {
    return ['duel', `--${key}`];
  }
  return null;
}

// A task a routine run or tasks claim claimed or held, in the shape of a
// core answer task. The submits its claim has left are not known here, so
// they are left out.
export function coreTaskOf(task: TaskResponse) {
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
// does not hold yet is recorded. run, challenge and duel all use it.
export async function recordClaims(
  answer: Pick<CoreAnswerResponse, 'tasks'>,
): Promise<void> {
  const known = new Set(await unsubmittedClaims());
  const fresh = answer.tasks.filter((task) => !known.has(task.id));
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
  const [hooks, read, slug] = await Promise.all([
    claudeCodeHooksIn(deps),
    readStatus({ config, fetch: deps.fetch }),
    readOperatorSlug(config.agentId),
    // The session nudge's own cache, see nudge.ts.
    keepNudgeFresh(deps.fetch),
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
  // The level and the top actions of the status answer, fresh or the last
  // one kept, or one line when there is neither. The labels come from the
  // API, and s.line makes every part safe for the terminal.
  const lines =
    read.answer === null ? [NO_STANDING] : standingLines(read.answer);
  for (const line of lines) say(s.line`${line}`);
  say();
}

// The level, and the next level or that none is issued above it. status
// prints the same line.
export function levelLine(
  standing: Pick<CoreAnswerResponse['standing'], 'level' | 'nextLevel'>,
): string {
  return standing.nextLevel === null
    ? `Level ${shownLevel(standing.level)}, ${HIGHEST_ISSUED}.`
    : `Level ${shownLevel(standing.level)}. Next ${shownLevel(standing.nextLevel)}.`;
}

// Where the agent stands and the top two next steps of the status answer,
// each label with its command. Once today's counted budget is spent
// (VOU-140) it says so first, since more tasks today would not move the
// level.
export function standingLines(
  answer: StatusAnswerResponse,
  now: Date = new Date(),
): string[] {
  const today = todayOf(answer.status, now);
  return [
    ...(dailyCeilingReached(today) && today ? [todayLine(today)] : []),
    levelLine(answer.standing),
    ...answer.next.slice(0, TOP_ACTIONS).map(actionLine),
  ];
}

// An action as one line for a person, the API's label and the command
// this CLI built, when it knows the action. status prints its steps the
// same way.
export function actionLine(action: CoreActionResponse): string {
  const command = actionCommand(action, 'person');
  return command === null ? action.label : `${action.label} ${command}`;
}
