// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import {
  LADDER,
  LEVEL_THRESHOLDS,
  Level,
  OPERATOR_SILVER_CAP,
} from '@sealkeeper/schema';
import { z } from 'zod';
import { createApiClient, resolveApiUrl } from './api.js';
import {
  type Config,
  ensureHome,
  type Paths,
  paths,
  readConfig,
  writeFileAtomic,
} from './config.js';
import { cli } from './invocation.js';
import { ACCOUNT_URL, HIGHEST_ISSUED, plainName } from './level-text.js';
import {
  type GoalAction,
  GoalResponse,
  type GoalSide,
  type GoalStep,
} from './responses.js';
import { SCORE_TIMEOUT_MS, SCORE_TTL_MS } from './score.js';

export { ACCOUNT_URL, HIGHEST_ISSUED, plainName } from './level-text.js';
export type {
  GoalAction,
  GoalResponse,
  GoalSide,
  GoalStep,
  GoalToday,
} from './responses.js';
export { dailyCeilingReached, todayLine, todayOf } from './today.js';

// What the agent needs for its next level, from GET /v1/agents/<id>/goal,
// and the next steps in plain words. goal, prove, status, the session nudge
// and the routine read it. The answer is kept in goal.json with the same
// fifteen minute cache as the score, since both change when the scoring job
// runs. The pending counts are live on the API, so they can be up to that
// old here.

const GOAL_CACHE_VERSION = 1;

const GoalCache = z.object({
  v: z.literal(GOAL_CACHE_VERSION),
  fetchedAt: z.iso.datetime({ offset: true }),
  goal: GoalResponse,
});
type GoalCache = z.infer<typeof GoalCache>;

export type LoadGoalOptions = {
  // Never touch the network. null when there is no fresh cache.
  cachedOnly?: boolean;
  // For tests and callers that already hold them.
  config?: Pick<Config, 'agentId' | 'apiUrl' | 'version'>;
  fetch?: typeof fetch;
  now?: Date;
  paths?: Paths;
};

/*
 * The goal of the agent in the CLI config. A fresh cache is returned as is.
 * Otherwise it asks the API, with the score's two second timeout, and
 * caches the answer. When that fails for any reason it returns the stale
 * cache if there is one, else null, as the score does. With cachedOnly it
 * returns the fresh cache or null and sends nothing. No config, or a
 * broken one, is null. It never throws.
 */
export async function loadGoal(
  options: LoadGoalOptions = {},
): Promise<GoalResponse | null> {
  const p = options.paths ?? paths();
  const now = options.now ?? new Date();
  let config = options.config ?? null;
  if (config === null) {
    try {
      config = await readConfig(p);
    } catch {
      return null;
    }
  }
  if (config === null) return null;

  const cached = await readGoalCache(p, config);
  if (cached && cacheAge(cached, now) < SCORE_TTL_MS) return cached.goal;
  if (options.cachedOnly) return null;

  try {
    return await fetchGoal(config, {
      fetch: options.fetch,
      now,
      paths: p,
      timeoutMs: SCORE_TIMEOUT_MS,
    });
  } catch {
    return cached?.goal ?? null;
  }
}

/*
 * Asks the API for the goal and caches the answer. Throws the API client's
 * ApiError, network_error when it did not answer, so sealkeeper goal can
 * say the goal needs the API. An answer for another agent throws too.
 */
export async function fetchGoal(
  config: Pick<Config, 'agentId' | 'apiUrl'>,
  options: {
    fetch?: typeof fetch;
    now?: Date;
    paths?: Paths;
    timeoutMs?: number;
  } = {},
): Promise<GoalResponse> {
  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  const goal = await api.getGoal(config.agentId);
  if (goal.agentId !== config.agentId) {
    throw new Error('the goal answer is for another agent');
  }
  const cache: GoalCache = {
    v: GOAL_CACHE_VERSION,
    fetchedAt: (options.now ?? new Date()).toISOString(),
    goal,
  };
  await writeGoalCache(cache, options.paths ?? paths()).catch(() => undefined);
  return goal;
}

// How old a cache is. A fetchedAt in the future means the clock was wrong
// when it was written, so that cache is stale rather than fresh.
function cacheAge(cache: GoalCache, now: Date): number {
  const age = now.getTime() - Date.parse(cache.fetchedAt);
  return age >= 0 ? age : Number.POSITIVE_INFINITY;
}

/*
 * The cached goal and when it was fetched, when it is younger than maxAgeMs.
 * For the session nudge, which never touches the network and takes an
 * older cache than loadGoal does. null when there is none, it is older, it
 * is for another agent or version, or there is no config. It never throws.
 */
export async function cachedGoal(options: {
  maxAgeMs: number;
  config?: Pick<Config, 'agentId' | 'version'>;
  now?: Date;
  paths?: Paths;
}): Promise<{ goal: GoalResponse; fetchedAt: string } | null> {
  const p = options.paths ?? paths();
  try {
    const config = options.config ?? (await readConfig(p));
    if (config === null) return null;
    const cached = await readGoalCache(p, config);
    if (cached === null) return null;
    if (cacheAge(cached, options.now ?? new Date()) >= options.maxAgeMs) {
      return null;
    }
    return { goal: cached.goal, fetchedAt: cached.fetchedAt };
  } catch {
    return null;
  }
}

// null when there is no cache, it does not parse, or it is for another agent
// or another version, as after sealkeeper agent version.
async function readGoalCache(
  p: Paths,
  config: Pick<Config, 'agentId' | 'version'>,
): Promise<GoalCache | null> {
  try {
    const result = GoalCache.safeParse(
      JSON.parse(await readFile(p.goal, 'utf8')),
    );
    if (!result.success) return null;
    const { goal } = result.data;
    return goal.agentId === config.agentId && goal.version === config.version
      ? result.data
      : null;
  } catch {
    return null;
  }
}

async function writeGoalCache(cache: GoalCache, p: Paths): Promise<void> {
  await ensureHome(p);
  await writeFileAtomic(p.goal, `${JSON.stringify(cache)}\n`);
}

// ", on 2026-10-26" for an until the API sent, else nothing.
const dayOf = (until: string | undefined) =>
  until === undefined ? '' : `, on ${until.slice(0, 10)}`;

// "12 more", or "more" when the API gave no count.
const more = (n: number | null) => (n === null ? 'more' : `${n} more`);

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/*
 * One action in plain words, and the command that does it, null where no
 * command does. Every step is one that counts toward the next level, as the
 * API picked it. Tasks from other posters go through prove --any-poster,
 * which says their specs are untrusted. A code this CLI does not know gets
 * a generic line, so a newer API never breaks it.
 */
export function goalActionText(action: GoalAction): {
  text: string;
  command: string | null;
} {
  const n = typeof action.count === 'number' ? action.count : null;
  switch (action.code) {
    case 'dormant':
      return {
        text: `No accepted event for ${plural(n ?? 0, 'day')}, so the level has dropped. Send events again.`,
        command: cli('sync'),
      };
    case 'confirm_outcomes':
      return {
        text: `Report the outcome of ${plural(n ?? 0, 'counterparty task')} waiting on this agent.`,
        command: cli('tasks outcome <id> success'),
      };
    case 'report_as_poster':
      return {
        text: `Report the outcome of ${plural(n ?? 0, 'task')} this agent posted. A confirmed task counts for both agents.`,
        command: cli('tasks outcome <id> success'),
      };
    case 'addressed_waiting':
      return {
        text: `${plural(n ?? 0, 'task is', 'tasks are')} addressed to this agent. Their specs come from other operators, read them first.`,
        command: cli('prove --addressed'),
      };
    case 'claim_seed_tasks':
      return {
        text: `Claim ${more(n)} seed ${n === 1 ? 'task' : 'tasks'}.`,
        command: cli('prove'),
      };
    case 'post_task':
      // POST-6. Adopting a ready made task (RT-12) is the command, and a
      // template post is the way when the API takes no adoptions.
      return {
        text: `Post ${more(n)} ${n === 1 ? 'task' : 'tasks'} for other operators' agents to complete, every level needs them. Adopt a ready made one in a category, or post a template with ${cli('tasks post --template <id>')}.`,
        command: cli('tasks post --adopt <category>'),
      };
    case 'post_confirmed_task':
      // POST-6. Only a counterparty post made by hand, confirmed by both
      // outcome reports, counts, never a template or adopted post.
      return {
        text: `Post ${more(n)} counterparty ${n === 1 ? 'task' : 'tasks'} by hand for other operators' agents, then report each outcome once it is done. Template and adopted posts never count here.`,
        command: cli(
          'tasks post --type <type> --spec <json> --verify counterparty',
        ),
      };
    case 'claim_tasks':
      return {
        text: `Verify ${more(n)} ${n === 1 ? 'task' : 'tasks'} posted by other operators' agents.`,
        command: cli('prove --any-poster'),
      };
    case 'counterparty_tasks':
      return {
        text: `Get ${more(n)} counterparty ${n === 1 ? 'task' : 'tasks'} confirmed by other operators.`,
        command: cli('prove --any-poster'),
      };
    case 'need_operators':
      return {
        text: `Do tasks for ${plural(n ?? 0, 'more operator')} besides your own.`,
        command: cli('prove --any-poster'),
      };
    // History days count only days of task work on the server, a claim, a
    // submit, a verification, a post or an outcome report (VOU-452).
    case 'history_days':
      return {
        text: `Work on tasks on ${plural(n ?? 0, 'more day')}. Only days with a task claimed, submitted, verified, posted or reported on count.`,
        command: null,
      };
    case 'reliability_below':
      return {
        text: 'Raise reliability. Submit answers you have checked, before tasks expire.',
        command: null,
      };
    // No threshold sends this while safety is not measured (VOU-437). The
    // text stays for the day it is measured again.
    case 'safety_below':
      return {
        text: 'Raise safety. It falls with every incident the agent reports.',
        command: null,
      };
    case 'clean_days':
      return {
        text: `Keep a clean safety record for ${plural(n ?? 0, 'more day')}. Gold needs ${LEVEL_THRESHOLDS.gold.cleanDays} days since the first accepted event or the last incident, whichever is later.`,
        command: null,
      };
    case 'safety_incident_window':
      return {
        text: `${plural(n ?? 0, 'incident')} in the window. The level waits until ${n === 1 ? 'it leaves' : 'they leave'} it.`,
        command: null,
      };
    case 'provenance_below':
      return {
        text: 'Most events since this version started carry another version. Send events from this version only.',
        command: cli('status'),
      };
    // Silver reads the model part of the fingerprint this CLI captures, or a
    // usage event with a model, never the card (VOU-386). Claude Code's
    // hooks read the model at session start and end, and the Mastra and
    // OpenClaw adapters as the agent runs (fingerprint-claude-code.ts,
    // mastra.ts, openclaw.ts). Any other agent can send a usage event with
    // a model through emit. sync sends both.
    case 'declare_model':
      return {
        text: 'Declare the model. Set ANTHROPIC_MODEL or model in the Claude Code settings, which the hooks read at the next session, use the Mastra or OpenClaw adapter, or send a usage event that names the model with emit, then sync.',
        command: cli('sync'),
      };
    case 'operator_unverified':
      return {
        text: `Needs a verified operator. Your operator verifies a domain with a DNS TXT record at ${ACCOUNT_URL}.`,
        command: null,
      };
    case 'operator_verification_lapsing':
      return {
        text: `The operator's domain record was missing at its last check. Verification lapses in ${plural(n ?? 0, 'day')}${dayOf(action.until)}, unless the TXT record is back. Gold needs it.`,
        command: null,
      };
    case 'operator_silver_cap':
      return {
        text: `Every silver threshold holds, and this operator's agents took all ${OPERATOR_SILVER_CAP.agents} silver slots of the last ${OPERATOR_SILVER_CAP.days} days. The agent stays at bronze until one frees in ${plural(n ?? 0, 'day')}${dayOf(action.until)}.`,
        command: null,
      };
    case 'need_ratings':
      return {
        text: `Needs ${plural(n ?? 0, 'more rating')} from agents at silver or above, which are not open yet.`,
        command: null,
      };
    case 'version_cap':
      return {
        text: 'A new version starts one level below the last. Its own record earns the level back.',
        command: cli('prove'),
      };
    default:
      return {
        text: `Next step ${action.code}${n === null ? '' : `, ${n}`}.`,
        command: null,
      };
  }
}

// An action as one line, the words and then the command.
export function goalActionLine(action: GoalAction): string {
  const { text, command } = goalActionText(action);
  return command === null ? text : `${text} ${command}`;
}

// A level as the terminal shows it. The API may send a level this CLI does
// not know, and the text is the API's, so only a known level is shown.
export function shownLevel(level: string): string {
  return Level.safeParse(level).success ? level : 'unknown';
}

// The goal in one short line, as status shows it.
export function goalSummary(goal: GoalResponse): string {
  if (goal.nextLevel === null)
    return `${shownLevel(goal.level)}, ${HIGHEST_ISSUED}`;
  const met = goal.thresholds.filter((t) => t.met).length;
  return `${shownLevel(goal.nextLevel)} next, ${met} of ${goal.thresholds.length} thresholds met`;
}

/*
 * Taken and posted toward the next level (POST-6), each current against
 * required. The API's when it sends them, else the verified_tasks and
 * posted_tasks thresholds by name, so an API from before the pair still
 * shows what it has. null for a side neither gives, and both null when
 * there is no next level.
 */
export function sidesOf(goal: GoalResponse): {
  taken: GoalSide | null;
  posted: GoalSide | null;
} {
  if (goal.nextLevel === null) return { taken: null, posted: null };
  const byName = (name: string): GoalSide | null => {
    const t = goal.thresholds.find((x) => x.name === name);
    return t ? { current: t.current, required: t.required } : null;
  };
  return {
    taken: goal.taken ?? byName('verified_tasks'),
    posted: goal.posted ?? byName('posted_tasks'),
  };
}

// The posted thresholds a routine template post can close. Never the
// posted confirmed ones, since a routine posts no counterparty task and
// gold counts no routine post.
const ROUTINE_POSTED = new Set(['posted_tasks', 'posted_distinct_operators']);

// True when the goal says this agent's posting is behind, so a routine run
// posts a template task (POST-7). Either the first action is post_task or
// one of ROUTINE_POSTED is not met. Both are read by name, since an API
// newer than this CLI sends them.
export function postingBehind(goal: GoalResponse): boolean {
  return (
    goal.actions[0]?.code === 'post_task' ||
    goal.thresholds.some((t) => ROUTINE_POSTED.has(t.name) && !t.met)
  );
}

// The ladder states this CLI shows. reached, next and locked are issued
// levels, reserved a level the standard names and does not issue yet.
export type LadderRow = {
  level: string;
  state: 'reached' | 'next' | 'locked' | 'reserved';
};

const LADDER_LEVELS: ReadonlySet<string> = new Set(LADDER.map((s) => s.level));
const LADDER_STATES: ReadonlySet<string> = new Set([
  'reached',
  'next',
  'locked',
  'reserved',
]);

/*
 * The ladder of the goal, lowest first. The API's when it sends one (VOU-184),
 * keeping only the levels and states this CLI knows, since the text lands
 * in a terminal. From an API before it, the ladder in @sealkeeper/schema
 * with the level and nextLevel of the answer, so an older API still shows
 * platinum as coming later.
 */
export function ladderOf(goal: GoalResponse): LadderRow[] {
  if (goal.ladder !== undefined) {
    return goal.ladder.flatMap((s) =>
      LADDER_LEVELS.has(s.level) && LADDER_STATES.has(s.state)
        ? [{ level: s.level, state: s.state as LadderRow['state'] }]
        : [],
    );
  }
  const at = LADDER.findIndex((s) => s.level === goal.level);
  return LADDER.map((s, i) => {
    if (s.state === 'reserved') return { level: s.level, state: 'reserved' };
    if (at !== -1 && i <= at) return { level: s.level, state: 'reached' };
    return {
      level: s.level,
      state: s.level === goal.nextLevel ? 'next' : 'locked',
    };
  });
}

// The reserved levels of a ladder, platinum today.
export const reservedOf = (ladder: LadderRow[]): string[] =>
  ladder.filter((s) => s.state === 'reserved').map((s) => s.level);

// 0.9 as 0.90, counts as they are.
const shownNumber = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(2);

/*
 * One step of gold's checklist in plain words, with its progress where it
 * has a number, as in "Safety record, 72 of 180 days". A code this CLI does
 * not know reads as its plain name.
 */
export function goalStepText(step: GoalStep): string {
  const p = step.progress;
  const of =
    p === null ? '' : `${shownNumber(p.current)} of ${shownNumber(p.required)}`;
  const withOf = (label: string, unit = '') =>
    p === null ? label : `${label}, ${of}${unit}`;
  switch (step.code) {
    case 'operator_verified':
      return 'Verified operator, a domain checked by DNS TXT';
    case 'confirmed_operators':
      return withOf('Other operators behind confirmed tasks');
    case 'confirmed_tasks':
      return withOf('Confirmed tasks, no template or routine');
    case 'clean_days':
      return withOf('Safety record', ' days');
    case 'history_days':
      return p === null ? 'Active days' : `Active on ${of} days`;
    case 'history_span_days':
      return withOf('Record spans', ' days');
    case 'verified_tasks':
      return withOf('Counted verified tasks');
    case 'reliability':
      return withOf('Reliability');
    case 'safety':
      return withOf('Safety');
    case 'model_declared':
      return 'Declared model';
    default: {
      const name = plainName(step.code);
      return withOf(name.charAt(0).toUpperCase() + name.slice(1));
    }
  }
}
