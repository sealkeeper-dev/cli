// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { requireConfig } from '../cli-config.js';
import { handleOf } from '../config.js';
import {
  fetchGoal,
  type GoalResponse,
  goalActionLine,
  goalStepText,
  HIGHEST_ISSUED,
  type LadderRow,
  ladderOf,
  reservedOf,
  shownLevel,
  sidesOf,
  todayLine,
  todayOf,
} from '../goal.js';
import { COUNTED_RULE } from '../ladder.js';
import { readOperatorSlug } from '../operator-slug.js';
import { stdout, wantsJson } from '../output.js';

// sealkeeper goal. What this agent needs for its next level, for a person
// in a terminal and, with --json, for an agent. It always asks the API,
// since the pending counts are live there, and refreshes the cache status
// and prove read.

type GoalCommandDeps = { fetch?: typeof fetch };

// Like check, 2 when the goal could not be read.
const EXIT_ERROR = 2;

export function register(parent: Command, deps: GoalCommandDeps = {}): Command {
  return parent
    .command('goal')
    .description(
      'Show what your agent needs for its next level and what to do next, --json for agents',
    )
    .action(async function (this: Command): Promise<void> {
      const config = await requireConfig(this);
      let goal: GoalResponse;
      try {
        goal = await fetchGoal(config, { fetch: deps.fetch });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (error instanceof ApiError && error.code === 'network_error') {
          this.error(`the goal needs the SealKeeper API, ${why}`, {
            exitCode: EXIT_ERROR,
          });
        }
        this.error(why, { exitCode: EXIT_ERROR });
      }
      // The API answer as it came, unknown keys included.
      if (wantsJson(this)) stdout(JSON.stringify(goal));
      else {
        const slug = await readOperatorSlug(config.agentId);
        for (const line of goalLines(goal, handleOf(config, slug))) {
          stdout(line);
        }
      }
    });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// 0.9 as 0.90, counts as they are.
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// The terminal view. Where the agent stands and the ladder, with platinum
// as coming later. Taken and posted side by side toward the next level
// (POST-6), each current of required. Below gold, a table of the next
// level's thresholds with
// the raw count beside each counted one. Toward gold, gold's checklist
// (VOU-184) and the one step left when only one is. An API from before the
// checklist gets the table there too. Then the day's counted tasks, the
// next steps with their commands, what waits, and the run the numbers come
// from.
export function goalLines(
  goal: GoalResponse,
  handle: string,
  now: Date = new Date(),
): string[] {
  const lines = [`SealKeeper goal   ${handle}`, ''];
  const ladder = ladderOf(goal);
  const reserved = reservedOf(ladder);
  if (goal.nextLevel === null) {
    lines.push(`Level ${shownLevel(goal.level)}, ${HIGHEST_ISSUED}.`);
  } else {
    lines.push(
      `Level ${shownLevel(goal.level)}. Next ${shownLevel(goal.nextLevel)}.`,
    );
  }
  if (ladder.length > 0) lines.push(ladderLine(ladder));
  // Only as a pair, so an API from before posted evidence shows none.
  const { taken, posted } = sidesOf(goal);
  if (taken !== null && posted !== null) {
    lines.push(
      `Taken ${num(taken.current)} of ${num(taken.required)}   Posted ${num(posted.current)} of ${num(posted.required)}`,
    );
  }
  if (goal.nextLevel === null && reserved.length > 0) {
    lines.push(
      `${cap(reserved.join(' and '))} ${reserved.length === 1 ? 'is' : 'are'} coming later. The standard names ${reserved.length === 1 ? 'it' : 'them'} and SealKeeper does not issue ${reserved.length === 1 ? 'it' : 'them'} yet.`,
    );
  }
  const steps = goal.steps ?? [];
  if (goal.nextLevel === 'gold' && steps.length > 0) {
    lines.push('', 'Gold checklist');
    for (const step of steps) {
      lines.push(`  ${step.done ? '[x]' : '[ ]'} ${goalStepText(step)}`);
    }
    const open = steps.filter((step) => !step.done);
    if (open.length === 1 && open[0] !== undefined) {
      lines.push('', `One step left for gold. ${goalStepText(open[0])}.`);
    }
  } else if (goal.nextLevel !== null) {
    lines.push('');
    const width = Math.max(
      'threshold'.length,
      ...goal.thresholds.map((t) => t.name.length),
    );
    // Task thresholds are in counted units (VOU-139), with every verified
    // task beside them as raw. An API from before it sends no raw.
    const cols = (a: string, b: string, c: string, d: string, e: string) =>
      `  ${a.padEnd(width)}  ${b.padStart(8)}  ${c.padStart(8)}  ${d.padStart(8)}  ${e}`;
    lines.push(cols('threshold', 'current', 'raw', 'required', 'met'));
    for (const t of goal.thresholds) {
      lines.push(
        cols(
          t.name,
          num(t.current),
          typeof t.raw === 'number' ? num(t.raw) : '',
          num(t.required),
          t.met ? 'yes' : 'no',
        ),
      );
    }
  }
  const today = todayOf(goal, now);
  if (today !== null) lines.push('', todayLine(today), COUNTED_RULE);
  lines.push('');
  if (goal.actions.length === 0) {
    lines.push('Nothing to do right now.');
  } else {
    lines.push('Next');
    for (const action of goal.actions)
      lines.push(`  ${goalActionLine(action)}`);
  }
  const { addressed, outcomes } = goal.pending;
  if (addressed > 0 || outcomes > 0) {
    lines.push(
      '',
      cap(
        `waiting ${addressed} addressed ${addressed === 1 ? 'task' : 'tasks'}, ${outcomes} ${outcomes === 1 ? 'outcome' : 'outcomes'} to report.`,
      ),
    );
  }
  lines.push(
    '',
    goal.asOf === null
      ? 'Not scored yet. Scoring runs every 15 minutes.'
      : `As of the scoring run at ${goal.asOf}.`,
  );
  return lines;
}

const LADDER_WORD: Record<LadderRow['state'], string> = {
  reached: ' reached',
  next: ' next',
  locked: '',
  reserved: ' coming later',
};

// The ladder on one line, lowest first and none left out, as in "Ladder
// bronze reached > silver next > gold > platinum coming later".
function ladderLine(ladder: LadderRow[]): string {
  const shown = ladder
    .filter((s) => s.level !== 'none')
    .map((s) => `${s.level}${LADDER_WORD[s.state]}`);
  return `Ladder  ${shown.join(' > ')}`;
}
