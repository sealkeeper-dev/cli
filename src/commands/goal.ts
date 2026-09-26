// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { requireConfig } from '../cli-config.js';
import { handleOf } from '../config.js';
import {
  fetchGoal,
  type GoalResponse,
  goalActionLine,
  shownLevel,
  todayLine,
  todayOf,
} from '../goal.js';
import { COUNTED_RULE } from '../ladder.js';
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
      else for (const line of goalLines(goal, handleOf(config))) stdout(line);
    });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// 0.9 as 0.90, counts as they are.
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// The terminal view. Where the agent stands, a table of the next level's
// thresholds with the raw count beside each counted one, the day's counted
// tasks, the next steps with their commands, what waits, and the run the
// numbers come from.
export function goalLines(
  goal: GoalResponse,
  handle: string,
  now: Date = new Date(),
): string[] {
  const lines = [`SealKeeper goal   ${handle}`, ''];
  if (goal.nextLevel === null) {
    lines.push(`Level ${shownLevel(goal.level)}, the top level.`);
  } else {
    lines.push(
      `Level ${shownLevel(goal.level)}. Next ${shownLevel(goal.nextLevel)}.`,
      '',
    );
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
