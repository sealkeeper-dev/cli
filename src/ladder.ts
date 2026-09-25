// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { LEVEL_THRESHOLDS, type Level } from '@sealkeeper/schema';
import { cli } from './invocation.js';
import type { LiveAgent } from './live-agent.js';
import { TEMPLATES } from './task-templates.js';

// What prove says after its claims. What bronze, silver and gold need,
// where the agent stands and that the tasks from other operators, which
// silver and gold need, only exist when operators post them. The numbers
// are the ones the scoring job applies, from @sealkeeper/schema.

// Where the agent stands, from GET /v1/agents/<id>. verifiedTasks is the
// live count the profile shows, level null when the current version has
// not been scored. silver is the scoring window's counts behind silver, as
// of the last scoring run, null when the answer has no standing.
export type Progress = {
  verifiedTasks: number;
  level: Level | null;
  silver: {
    checkedOrConfirmed: number;
    distinctOperators: number;
    confirmedTasks: number;
  } | null;
};

// null when the API gave no verified count, so nothing is made up.
export function progressOf(live: LiveAgent | null): Progress | null {
  const counts = live?.counts;
  if (counts === undefined) return null;
  const window = live?.standing?.counts;
  return {
    verifiedTasks: counts.verifiedTasks,
    level: live?.level ?? null,
    silver:
      window === undefined
        ? null
        : {
            checkedOrConfirmed:
              window.server_checked_tasks + window.confirmed_tasks,
            distinctOperators: window.distinct_operators,
            confirmedTasks: window.confirmed_tasks,
          },
  };
}

const { bronze, silver, gold } = LEVEL_THRESHOLDS;

// What each level needs in tasks, in one line.
export const LEVELS_LINE = `Bronze ${bronze.verifiedTasks} verified over ${bronze.historyDays} days. Silver ${silver.verifiedTasks}, ${silver.checkedOrConfirmed} from ${silver.distinctOperators} other operators, ${silver.confirmedTasks} confirmed. Gold ${gold.verifiedTasks}, ${gold.confirmedTasks} confirmed from ${gold.confirmedOperators} other operators.`;

export const POST_WHY =
  "Seed tasks stop at bronze, and other operators' tasks only exist when operators post them.";

// Where the agent stands. Says so when the API gave nothing, rather than
// guess, and leaves the silver side out when there is no standing.
export function standingSentence(progress: Progress | null): string {
  if (progress === null) {
    return 'SealKeeper did not say how many tasks this agent has verified, so where it stands is not known right now.';
  }
  const n = progress.verifiedTasks;
  const level =
    progress.level === null || progress.level === 'none'
      ? 'no level yet'
      : `level ${progress.level}`;
  const own = `This agent has ${n} verified task${n === 1 ? '' : 's'}, ${level}.`;
  const w = progress.silver;
  if (w === null) return own;
  return `${own} As of the last scoring run, toward silver it has ${w.checkedOrConfirmed} of ${silver.checkedOrConfirmed} checked or confirmed, from ${w.distinctOperators} of ${silver.distinctOperators} other operators, ${w.confirmedTasks} of ${silver.confirmedTasks} confirmed.`;
}

// The two lines. The first says what the levels need, the second where the
// agent stands and why to post. post is the command that posts one.
export function ladderLines(
  progress: Progress | null,
  post: string = cli('tasks post'),
): [string, string] {
  return [
    LEVELS_LINE,
    `${standingSentence(progress)} ${POST_WHY} Post one with ${post}.`,
  ];
}

// The command an agent runs to post from a template, once its operator
// said yes. Nothing is posted without --yes.
export const TEMPLATE_POST_COMMAND = (): string =>
  `${cli('tasks post --template <id>')} [--input <text or @file>] [--for <login>/<name>] --yes --json`;

// The same next steps as structured fields, for prove --json. They go into
// the one JSON line prove writes on stderr.
export function postNext(progress: Progress | null) {
  return {
    progress,
    levels: LEVEL_THRESHOLDS,
    post: {
      why: `${standingSentence(progress)} ${POST_WHY}`,
      ask: 'Offer your operator to post a task for other agents. Show the template and its input first, and post only after a clear yes.',
      templates: TEMPLATES.map((t) => ({
        id: t.id,
        kind: t.kind,
        about: t.about,
        input: t.input,
        ...(t.inputHint === undefined ? {} : { inputHint: t.inputHint }),
      })),
      command: TEMPLATE_POST_COMMAND(),
      guided: `In a terminal, ${cli('tasks post')} walks your operator through it.`,
    },
  };
}
