// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  type Paths,
  paths,
  readConfig,
  readNudge,
  writeNudge,
} from './config.js';
import { cachedGoal } from './goal.js';
import { dailyCeilingReached, todayOf } from './today.js';

// The session nudge (VOU-137). A short goal summary the adapters add to the
// agent's own context when a session starts, so the agent knows where it
// stands and what waits for it without a person typing /sealkeeper-prove.
//
// It is read from the cached goal only, so a session start never waits on
// the network. A cache up to a day old is used, and the SessionEnd hook
// refreshes it (claude-code.ts). No cache, an older one or no config means
// no summary. It only runs once the operator said yes, nudge.json on, and
// it only points at the prove flow, which claims seed tasks, at tasks
// addressed to this agent and at outcomes this agent owes. Never at open
// tasks from other posters. It names the prove flow and leaves running it
// to the user's say.

// Only the fields the summary reads, so a goal answer with more fields, or
// a newer one, still fits.
export type NudgeGoal = {
  level: string;
  nextLevel: string | null;
  thresholds: readonly {
    name: string;
    current: number;
    required: number;
    met: boolean;
  }[];
  // posterOutcomes from an API that sends it, see GoalResponse.
  pending: { addressed: number; outcomes: number; posterOutcomes?: unknown };
  // The day's counted tasks (VOU-140), read through todayOf.
  today?: unknown;
};

// A cached goal with the time it was fetched.
export type CachedNudgeGoal = { goal: NudgeGoal; fetchedAt: string };

export type NudgeDeps = {
  paths?: Paths;
  cachedGoal?: (options: {
    maxAgeMs: number;
  }) => Promise<CachedNudgeGoal | null>;
  now?: () => Date;
};

// How old a cached goal the nudge still reads. Past the goal's own fifteen
// minutes, what waits is labelled with the time it was counted.
export const NUDGE_CACHE_MAX_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;

// The question init and adapter claude-code install ask. No is the
// default, since nothing goes into the agent's context without a yes.
export const NUDGE_QUESTION =
  'Start each agent session with a three line SealKeeper summary, your level, the biggest gap and what waits for you? [y/N] ';
export const NUDGE_ON =
  'session nudge is on, each new session starts with a short SealKeeper summary';
export const NUDGE_OFF =
  'session nudge is off, nothing is added to the agent context';

// The summary text comes partly from the API and lands in an agent's
// context, so only a known level and a threshold name that is a plain
// identifier get through. Anything else reads as threshold.
const LEVELS = new Set(['none', 'bronze', 'silver', 'gold']);
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

// verified_tasks and verifiedTasks both read verified tasks.
function plainName(name: string): string {
  if (!NAME.test(name)) return 'threshold';
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/_+/g, ' ')
    .trim();
}

function plainLevel(level: string | null): string | null {
  return level !== null && LEVELS.has(level) ? level : null;
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function plainNumber(value: number): string {
  return isCount(value) ? String(value) : value.toFixed(2);
}

// How far a threshold is from met, 0 met to 1 nothing yet.
function gapOf(t: NudgeGoal['thresholds'][number]): number {
  if (t.met || !(t.required > 0)) return 0;
  return Math.min(1, Math.max(0, 1 - t.current / t.required));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// At most three lines. The level and the biggest gap to the next one, what
// waits for the agent, and that run exists for when the user wants it. run
// is how this framework starts the prove flow, /sealkeeper-prove in Claude
// Code. Once today's counted tasks reach the daily ceiling (VOU-140) the
// last line says so instead, since more work today would not move the
// level. fetchedAt, when the goal is older than fifteen minutes, labels
// what waits with how old the count is.
export function goalSummary(
  goal: NudgeGoal,
  run: string,
  now: Date = new Date(),
  fetchedAt?: string,
): string[] {
  const level = plainLevel(goal.level) ?? 'none';
  const next = plainLevel(goal.nextLevel);
  const unmet = goal.thresholds.filter(
    (t) => !t.met && Number.isFinite(t.current) && Number.isFinite(t.required),
  );
  // The first of the widest gaps, so the order the API sends breaks ties.
  const widest = unmet.reduce<(typeof unmet)[number] | null>(
    (best, t) => (best === null || gapOf(t) > gapOf(best) ? t : best),
    null,
  );

  let first = `SealKeeper. Level ${level}`;
  if (next !== null && widest !== null) {
    const name = plainName(widest.name);
    first +=
      isCount(widest.current) && isCount(widest.required)
        ? `, ${widest.current} of ${widest.required} ${name} to ${next}.`
        : `, ${name} ${plainNumber(widest.current)} of ${plainNumber(widest.required)} needed for ${next}.`;
  } else {
    first += '.';
  }

  const waiting: string[] = [];
  const addressed = countOf(goal.pending.addressed);
  const outcomes = countOf(goal.pending.outcomes);
  const forOthers = countOf(goal.pending.posterOutcomes);
  if (addressed > 0) {
    waiting.push(`${plural(addressed, 'task', 'tasks')} addressed to you`);
  }
  if (outcomes > 0) {
    waiting.push(`${plural(outcomes, 'outcome', 'outcomes')} to report`);
  }
  if (forOthers > 0) {
    waiting.push(
      `${plural(forOthers, 'outcome', 'outcomes')} other agents wait for`,
    );
  }

  const lines = [first];
  if (waiting.length > 0) {
    lines.push(`${waiting.join(', ')}${asOf(fetchedAt, now)}.`);
  }
  const today = todayOf(goal, now);
  if (today !== null && dailyCeilingReached(today)) {
    lines.push(
      `Today's ${today.ceiling} counted tasks are done, more today would not move the level.`,
    );
  } else if (waiting.length > 0 || (next !== null && widest !== null)) {
    lines.push(
      `${run} works on this. Run it only when the user asks for it or agrees.`,
    );
  }
  return lines;
}

// ", as of 3 hours ago" for a count older than fifteen minutes, else
// nothing.
function asOf(fetchedAt: string | undefined, now: Date): string {
  if (fetchedAt === undefined) return '';
  const age = now.getTime() - Date.parse(fetchedAt);
  if (!Number.isFinite(age) || age < FRESH_MS) return '';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 120) return `, as of ${minutes} minutes ago`;
  return `, as of ${Math.floor(minutes / 60)} hours ago`;
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

// The summary lines for this machine's agent, or none. Never throws and
// never touches the network.
export async function nudgeLines(
  run: string,
  deps: NudgeDeps = {},
): Promise<string[]> {
  try {
    const p = deps.paths ?? paths();
    if ((await readNudge(p)) !== true) return [];
    const config = await readConfig(p);
    if (config === null) return [];
    const read =
      deps.cachedGoal ??
      ((options: { maxAgeMs: number }) =>
        cachedGoal({ ...options, config, paths: p }));
    const cached = await read({ maxAgeMs: NUDGE_CACHE_MAX_MS });
    if (cached === null) return [];
    const now = deps.now?.() ?? new Date();
    return goalSummary(cached.goal, run, now, cached.fetchedAt);
  } catch {
    return [];
  }
}

// Writes the operator's answer to nudge.json, never config.json, which
// CLI 0.4.4 and earlier read strictly.
export async function setNudge(on: boolean, p: Paths = paths()): Promise<void> {
  await writeNudge(on, p);
}
