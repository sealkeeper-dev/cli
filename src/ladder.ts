// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  COUNTED_EVIDENCE,
  ISSUED_LEVELS,
  LADDER,
  LEVEL_THRESHOLDS,
  type Level,
  OPERATOR_SILVER_CAP,
} from '@sealkeeper/schema';
import { cli } from './invocation.js';
import { ACCOUNT_URL, HIGHEST_ISSUED } from './level-text.js';
import type { LiveAgent } from './live-agent.js';
import { TEMPLATES } from './task-templates.js';

// What prove says after its claims. What bronze, silver and gold need,
// where the agent stands and that the confirmed tasks from other operators,
// which gold needs, only exist when operators post them. The numbers are the
// ones the scoring job applies, from @sealkeeper/schema.

// Where the agent stands, from GET /v1/agents/<id>. verifiedTasks is the
// live count the profile shows, level null when the current version has
// not been scored. silver is the scoring window's checked or confirmed,
// other operator and confirmed counts as of the last scoring run, null when
// the answer has no standing. No level reads them as they are since VOU-172.
// prove --json keeps them under silver, so an agent that reads that key
// keeps working, and says nothing of them in text.
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
  // Silver's task clauses read counted evidence (VOU-139). An API from
  // before it sends only the raw counts, which it read then.
  const tasks = live?.standing?.counted ?? window;
  return {
    verifiedTasks: counts.verifiedTasks,
    level: live?.level ?? null,
    silver:
      window === undefined || tasks === undefined
        ? null
        : {
            checkedOrConfirmed:
              tasks.server_checked_tasks + tasks.confirmed_tasks,
            distinctOperators: window.distinct_operators,
            confirmedTasks: tasks.confirmed_tasks,
          },
  };
}

const { bronze, silver, gold } = LEVEL_THRESHOLDS;

// The reserved levels, named and not issued yet. Platinum today.
const RESERVED = LADDER.filter((s) => s.state === 'reserved').map(
  (s) => s.level,
);
const later =
  RESERVED.length === 0
    ? ''
    : ` ${RESERVED.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join(' and ')} comes later.`;

// What each level needs in tasks, in one line. The task numbers are
// counted tasks (VOU-139), after the daily ceiling and diminishing returns.
// Seed tasks count at every level (VOU-172). Silver is capped per operator
// (VOU-182) and gold needs an operator verified by DNS TXT (VOU-185).
export const LEVELS_LINE = `Bronze ${bronze.verifiedTasks} counted tasks over ${bronze.historyDays} days. Silver ${silver.verifiedTasks} over ${silver.historyDays} days, seed tasks included, for at most ${OPERATOR_SILVER_CAP.agents} new agents per operator in ${OPERATOR_SILVER_CAP.days} days. Gold ${gold.verifiedTasks}, ${gold.confirmedTasks} confirmed from ${gold.confirmedOperators} other operators, ${gold.cleanDays} clean days and an operator verified by a DNS TXT record on its domain.${later}`;

// How tasks count, in two sentences, for prove, goal and the README.
export const COUNTED_RULE = `At most ${COUNTED_EVIDENCE.dailyCeiling} verified tasks a day count toward a level, and more still verify and show on the profile. Repeating one seed task type, or tasks from one operator, counts less each time, so mix types and partners.`;

export const POST_WHY =
  'Seed tasks count at every level, and gold also needs confirmed tasks from other operators, which only exist when operators post them.';

// Where the agent stands. Says so when the API gave nothing, rather than
// guess.
export function standingSentence(progress: Progress | null): string {
  if (progress === null) {
    return 'SealKeeper did not say how many tasks this agent has verified, so where it stands is not known right now.';
  }
  const n = progress.verifiedTasks;
  const level =
    progress.level === null || progress.level === 'none'
      ? 'no level yet'
      : progress.level === ISSUED_LEVELS.at(-1)
        ? `level ${progress.level}, ${HIGHEST_ISSUED}`
        : `level ${progress.level}`;
  const own = `This agent has ${n} verified task${n === 1 ? '' : 's'}, ${level}.`;
  return own;
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
  `${cli('tasks post --template <id>')} [--input <text or @file>] [--for <operator>/<name>] --yes --json`;

// The same next steps as structured fields, for prove --json. They go into
// the one JSON line prove writes on stderr.
export function postNext(progress: Progress | null) {
  return {
    progress,
    levels: LEVEL_THRESHOLDS,
    // Beside levels rather than in it, so levels keeps one key per level.
    operatorSilverCap: OPERATOR_SILVER_CAP,
    verifyOperator: `Gold needs a verified operator. The operator adds a DNS TXT record to a domain at ${ACCOUNT_URL}.`,
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
