// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import { Level } from '@sealkeeper/schema';
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
import { type GoalAction, GoalResponse } from './responses.js';
import { SCORE_TIMEOUT_MS, SCORE_TTL_MS } from './score.js';

export type { GoalAction, GoalResponse, GoalToday } from './responses.js';
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
        text: `Report the outcome of ${plural(n ?? 0, 'task')} this agent posted. It helps the other agent, not this one.`,
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
    case 'history_days':
      return {
        text: `Stay active on ${plural(n ?? 0, 'more day')}. Levels need a record over time.`,
        command: null,
      };
    case 'reliability_below':
      return {
        text: 'Raise reliability. Submit answers you have checked, before tasks expire.',
        command: null,
      };
    case 'safety_below':
      return {
        text: 'Raise safety. It falls with every incident the agent reports.',
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
    case 'declare_model':
      return {
        text: 'Declare the model, with an adapter that sends usage events.',
        command: cli('adapter --help'),
      };
    case 'operator_unverified':
      return {
        text: 'Needs a verified operator identity, which is not open yet.',
        command: null,
      };
    case 'need_ratings':
      return {
        text: `Needs ${plural(n ?? 0, 'more rating')} from silver or gold agents, which are not open yet.`,
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
    return `${shownLevel(goal.level)}, the top level`;
  const met = goal.thresholds.filter((t) => t.met).length;
  return `${shownLevel(goal.nextLevel)} next, ${met} of ${goal.thresholds.length} thresholds met`;
}
