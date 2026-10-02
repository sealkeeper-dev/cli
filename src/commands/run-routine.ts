// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ClaimTaskRequest } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { type ApiClient, ApiError } from '../api.js';
import type { Config, RoutineConfig } from '../config.js';
import {
  dailyCeilingReached,
  type GoalToday,
  loadGoal,
  todayLine,
  todayOf,
} from '../goal.js';
import type { Signer } from '../identity.js';
import { clearInbox } from '../inbox.js';
import { cli } from '../invocation.js';
import { readOperatorSlug } from '../operator-slug.js';
import { stderr } from '../output.js';
import {
  type AgentResponse,
  operatorSlugOf,
  runBySealKeeper,
  type TaskResponse,
} from '../responses.js';
import {
  appendRoutine,
  barredOperators,
  budgetOf,
  isAllowed,
  networkBudgetOf,
  networkOperatorsToday,
  normalLogin,
  type RoutineEntry,
  RoutineLockBusy,
  readRoutine,
  type SkipEntry,
  skippedIds,
  withClaimLock,
} from '../routine.js';
import {
  addressedTo,
  claimableByAge,
  failOnApiError,
  openTasksPage,
  recordEvent,
  sendWithFingerprint,
  serverHeld,
  type TaskSession,
  unsubmittedClaims,
} from '../tasks.js';

/*
 * The claims of run --json inside a routine run (VOU-138, RT-8), moved
 * unchanged from prove when run replaced it (VOU-595). A routine run still
 * picks its own candidates, tasks addressed to this agent by operators on
 * the allowlist, other operators' template tasks past the claim age
 * threshold and seed tasks, which the run route does not know yet.
 * VOU-599 deletes this file once the routine route (VOU-594) decides a
 * routine run's claims, and routine.ts reads its candidates from there.
 *
 * Held tasks come first and count toward the number, so a second run
 * --json in one routine run shows them again instead of claiming past the
 * server's cap. Held tasks the routine may not work are left out, see
 * routineHeld, so the unattended agent never sees their specs. Every claim
 * is read, spent and logged under the claim lock, within the routine's
 * daily limits, and the daily ceiling of counted tasks holds every claim
 * back unless --anyway.
 */

// Beyond the tasks wanted, how many claims may lose a race or hit an expiry
// before the run stops trying.
const EXTRA_CLAIM_ATTEMPTS = 5;
// At most this many posters are looked up to find the seed agent.
const MAX_POSTER_LOOKUPS = 10;
// The poster lookups the network source of a routine run may make, apart
// from MAX_POSTER_LOOKUPS, so neither crowds the other out (RT-8).
const NETWORK_POSTER_LOOKUPS = 10;
// Pages of each origin the network source reads at most (RT-8).
const NETWORK_PAGES = 3;
// Network claims that may lose a race or come too early in one run before
// the network block gives up. Counted apart from EXTRA_CLAIM_ATTEMPTS, so
// they never end the run before its seed tasks (RT-8).
const NETWORK_CLAIM_ATTEMPTS = 3;
// The poster levels whose template tasks a routine takes (RT-8).
const NETWORK_POSTER_LEVELS: readonly string[] = ['bronze', 'silver', 'gold'];
const LIST_LIMIT = 100;

// Why a routine run claimed fewer than it was asked for, in the shape of
// limited in the core answer. claims_per_day is the routine's own daily
// claim limit, daily_ceiling today's counted tasks at the daily ceiling.
type RoutineLimited = {
  code: 'claims_per_day' | 'daily_ceiling';
  message: string;
  until: null;
};

// What the claims of a routine run hand the agent. tasks are the held ones
// it may work and the ones claimed now, claimed how many of them were
// claimed now, limited why fewer came back, null when nothing held them
// back, and tooNew the claims the API refused as posted too recently, each
// a skip, not an error (RT-8).
type RoutineClaims = {
  tasks: TaskResponse[];
  claimed: number;
  limited: RoutineLimited | null;
  tooNew: TooNew[];
};

// Claims up to count tasks for a routine run, held ones first, then the
// routine's candidates, see routineCandidates. An API error before the
// first claim ends the command, after it the claims stop with a warning,
// so the tasks already claimed are still handed over.
export async function routineClaims(
  cmd: Command,
  session: TaskSession,
  options: { count: number; anyway?: boolean },
  runId: string,
  routine: RoutineConfig,
  fetchFn: typeof fetch,
): Promise<RoutineClaims> {
  const { config, signer, api } = session;
  let want = options.count;
  const now = Date.now();
  const posters = new PosterLookup(api);

  const tasks = await heldTasks(api, signer.agentId, want, now);
  // Held tasks it may not work wait for a person like any other, so the
  // agent never sees their specs.
  const keepRoutineHeld = async () => {
    const found = await routineHeld(posters, tasks, config, routine);
    tasks.splice(0, tasks.length, ...found.tasks);
    await logSkips(await readRoutine(), found.skipped, runId, now);
  };
  await keepRoutineHeld();
  let failures = 0;
  let limited: RoutineLimited | null = null;
  const tooNew: TooNew[] = [];
  // Counted evidence (VOU-140). Once today's counted tasks reach the daily
  // ceiling, more tasks still verify and count toward nothing until the
  // next UTC day, so the run claims none unless --anyway. The goal comes
  // from the fifteen minute cache when it is fresh, and a goal that cannot
  // be read, or says nothing of today, holds nothing back. Below the
  // ceiling, it claims no more than the day can still count, held tasks
  // included, since they count once they verify.
  const heldBack = async (): Promise<boolean> => {
    if (options.anyway || tasks.length >= want) return false;
    const today = todayOf(
      await loadGoal({ config, fetch: fetchFn }),
      new Date(now),
    );
    if (today === null) return false;
    if (!dailyCeilingReached(today)) {
      want = Math.min(want, Math.max(tasks.length, today.remaining));
      return false;
    }
    limited = {
      code: 'daily_ceiling',
      message: ceilingHeldBack(today),
      until: null,
    };
    await appendRoutine({
      kind: 'limit',
      runId,
      limit: 'dailyCountCeiling',
      used: today.counted,
      cap: today.ceiling,
    });
    return true;
  };
  const done = async (): Promise<RoutineClaims> => {
    // A claim cap adds the tasks the server says this agent holds.
    await keepRoutineHeld();
    return { tasks, claimed: claimedHere, limited, tooNew };
  };
  // Claims one task. False when the claim cap stopped it, and then the
  // tasks the server says this agent holds are added. The local log may
  // not know every claim (another machine, a fresh home). Any other API
  // error before the first claim of this run is thrown. After it, the loop
  // stops with a warning, so the tasks already claimed are still printed
  // (cli-adapters-tasks-6). It never ends the command itself, since it runs
  // under the claim lock.
  // network is the poster's operator slug on a claim of the routine's
  // network source (RT-8). Only such a claim says origin routine, the one
  // the API holds to the claim age threshold, since seed and addressed
  // claims never wait. Its claim line is marked network with the operator,
  // which networkClaimsPerDay and the one per operator rule count. An API
  // that refuses origin turns the network source off for this run, see
  // networkOff. lost counts a claim another agent took or the API found
  // too new, failures unless the caller counts apart.
  let claimedHere = 0;
  let networkOff = false;
  const claimOne = async (
    task: TaskResponse,
    opts: { network?: string; lost?: () => void } = {},
  ): Promise<boolean> => {
    const lost =
      opts.lost ??
      (() => {
        failures += 1;
      });
    try {
      const claimed = await sendWithFingerprint(
        signer,
        ClaimTaskRequest.parse({
          taskId: task.id,
          ...(opts.network === undefined ? {} : { origin: 'routine' }),
        }),
        (envelope) => api.claimTask(task.id, envelope),
      );
      tasks.push(claimed);
      claimedHere += 1;
      // The count status caches is too high now.
      if (claimed.assignee) await clearInbox();
      await recordEvent({
        type: 'task.claimed',
        payload: { task_id: claimed.id, task_type: claimed.taskType },
      });
      await appendRoutine({
        kind: 'claim',
        runId,
        taskId: claimed.id,
        taskType: claimed.taskType,
        ...(opts.network === undefined
          ? {}
          : { network: true, operator: opts.network }),
      });
    } catch (error) {
      // An API from before the claim's origin (RT-8). The network source is
      // off for the rest of this run, and seed tasks follow.
      if (opts.network !== undefined && refusesOrigin(error)) {
        networkOff = true;
        return true;
      }
      // Posted too recently for a routine claim (RT-8). The candidates are
      // filtered by age already, so this is a clock that differs from the
      // API's, and the API's answer wins. Skipped like a task another agent
      // took, and named on stderr, with a skip line.
      if (error instanceof ApiError && error.code === 'too_new') {
        lost();
        tooNew.push({
          id: task.id,
          taskType: task.taskType,
          reason: 'too_new',
          retryAfterSec: error.retryAfterSec,
        });
        await appendRoutine({
          kind: 'skip',
          runId,
          action: 'claim',
          taskId: task.id,
          reason: 'too_new',
          taskType: task.taskType,
        });
        return true;
      }
      if (error instanceof ApiError && isGone(error)) {
        lost();
        return true;
      }
      if (error instanceof ApiError && error.code === 'claim_cap') {
        await addServerHeld(api, signer.agentId, tasks, want, now);
        stderr(
          tasks.length > 0
            ? `${error.message}. Submit the tasks below first.`
            : `${error.message}. This agent holds the maximum and none of them could be listed.`,
        );
        return false;
      }
      if (error instanceof ApiError && claimedHere > 0) {
        stderr(
          `warning: stopped claiming after ${claimedHere} ${claimedHere === 1 ? 'task' : 'tasks'}, ${error.message}`,
        );
        return false;
      }
      throw error;
    }
    return true;
  };
  if (await heldBack()) return done();
  if (tasks.length >= want) return done();
  // The budget is read, spent and logged under the claim lock, so two runs
  // --json of one routine run at once cannot claim past the daily limit.
  const claimRoutine = async (): Promise<void> => {
    const entries = await readRoutine();
    const budget = budgetOf(entries, 'claim', routine, new Date(now));
    const limit = async (used: number) => {
      await appendRoutine({
        kind: 'limit',
        runId,
        limit: 'claimsPerDay',
        used,
        cap: budget.cap,
      });
      limited = {
        code: 'claims_per_day',
        message: claimLimitReached(budget.cap),
        until: null,
      };
    };
    if (budget.remaining === 0) {
      await limit(budget.used);
      return;
    }
    // An API error is thrown and reported once the lock is released.
    const network = networkBudgetOf(entries, routine, new Date(now));
    const found = await routineCandidates(
      api,
      posters,
      signer,
      config,
      routine,
      seedTypesDone(entries),
      {
        networkRemaining: network.remaining,
        barredOperators: barredOperators(entries),
        operatorsToday: networkOperatorsToday(entries, new Date(now)),
      },
    );
    await logSkips(entries, found.skipped, runId, now);
    want = Math.min(want, tasks.length + budget.remaining);
    const have = new Set(tasks.map((task) => task.id));
    // The network block claims at most networkClaimsPerDay's remainder,
    // and its lost claims are counted apart, so seed tasks always follow
    // it in the same run (RT-8).
    const inNetwork = new Map(
      (found.network ?? []).map((n) => [n.id, n.operator]),
    );
    let networkClaimed = 0;
    let networkLost = 0;
    for (const task of found.tasks) {
      if (tasks.length >= want) break;
      if (have.has(task.id)) continue;
      const operator = inNetwork.get(task.id);
      if (operator !== undefined) {
        if (
          networkOff ||
          networkClaimed >= network.remaining ||
          networkLost >= NETWORK_CLAIM_ATTEMPTS
        ) {
          continue;
        }
        const before = tasks.length;
        const go = await claimOne(task, {
          network: operator,
          lost: () => {
            networkLost += 1;
          },
        });
        if (!go) return;
        if (tasks.length > before) networkClaimed += 1;
        continue;
      }
      if (failures >= EXTRA_CLAIM_ATTEMPTS) break;
      if (!(await claimOne(task))) return;
    }
    if (tasks.length === want && want < options.count) {
      await limit(budget.used + budget.remaining);
    }
  };
  // Nothing inside the lock ends the command, so the lock is always
  // released first (cli-adapters-tasks-5).
  try {
    await withClaimLock(claimRoutine);
  } catch (error) {
    if (error instanceof RoutineLockBusy) cmd.error(error.message);
    failOnApiError(cmd, error);
  }
  return done();
}

// Said instead of claiming once today's counted budget is spent (VOU-140).
const ceilingHeldBack = (today: GoalToday): string =>
  `${todayLine(today)} Nothing was claimed. Run ${cli('run --anyway')} to claim all the same, or come back after midnight UTC`;

// Said on stderr when the API refused claims as too new (RT-8), with the
// API's own wait, the soonest of them, never a number of the CLI's.
export function tooNewNote(tooNew: TooNew[]): string {
  const n = tooNew.length;
  const waits = tooNew.flatMap((t) =>
    t.retryAfterSec === null ? [] : [t.retryAfterSec],
  );
  const when =
    waits.length === 0
      ? 'SealKeeper did not say when it can be claimed.'
      : `${n === 1 ? 'It' : 'The first'} can be claimed in ${Math.min(...waits)} seconds.`;
  return `${n === 1 ? '1 task was' : `${n} tasks were`} posted too recently to claim and ${n === 1 ? 'was' : 'were'} skipped. ${when}`;
}

// Another agent got there first, the task expired, or the server says it is
// our own. Worth trying the next task.
function isGone(error: ApiError): boolean {
  return (
    error.status === 409 ||
    error.status === 410 ||
    (error.status === 400 && error.code === 'own_task')
  );
}

// Open tasks addressed to this agent, oldest first. Throws what the API
// client throws.
async function listAddressed(
  api: ApiClient,
  agentId: string,
): Promise<TaskResponse[]> {
  const tasks = await api.listTasks({
    state: 'open',
    assignee: agentId,
    limit: LIST_LIMIT,
  });
  return addressedTo(tasks, agentId);
}

// Open seed tasks this agent may claim, oldest first. The API filters on
// the seed agent, so they come whatever other agents posted before them
// (VOU-208), and leaves out the ones this agent is barred from (VOU-200).
// Every one is a seed task by the API's word, which stands in for the seed
// flag an answer may not carry. The open list leaves addressed tasks out,
// and this keeps it so whatever the server sends. Seed tasks are exempt
// from the claim age threshold, so any age will do (RT-8). Throws what the
// API client throws.
async function openSeedTasks(
  api: ApiClient,
  signer: Signer,
): Promise<TaskResponse[]> {
  const { tasks } = await openTasksPage(api, signer, {
    seed: true,
    limit: LIST_LIMIT,
  });
  return tasks
    .filter((task) => task.posterAgentId !== signer.agentId && !task.assignee)
    .map((task) => ({ ...task, seed: true }));
}

// Open tasks other agents than the seed agent posted, one page, oldest
// first, the agent's own and the ones it is barred from left out. Throws
// what the API client throws.
async function openOtherTasks(
  api: ApiClient,
  signer: Signer,
): Promise<TaskResponse[]> {
  const { tasks } = await openTasksPage(api, signer, {
    seed: false,
    limit: LIST_LIMIT,
  });
  return tasks.filter(
    (task) => task.posterAgentId !== signer.agentId && !task.assignee,
  );
}

// The origins of the other operators' tasks a routine may take (RT-8).
// Posts from templates and from routines, never a manual post.
const NETWORK_ORIGINS = ['template', 'routine'] as const;

// True for an open task another agent posted from a template or a routine
// that SealKeeper checks on submit, by hash or schema, the kind a routine
// solves mechanically like a seed task (RT-8). Counterparty tasks need a
// judgement the unattended agent is not trusted with. Whether the poster is
// of this agent's own operator is the caller's check.
const isNetworkTask = (task: TaskResponse): boolean =>
  !task.assignee &&
  task.seed !== true &&
  (NETWORK_ORIGINS as readonly string[]).includes(task.origin ?? '') &&
  task.verification.kind !== 'counterparty';

// True when an API from before the origin filter refused it (RT-8), a
// 400 validation_failed whose issue names origin, as a bad value or as a
// key the strict payload does not know. Any other 400 is a real error.
export function refusesOrigin(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.code === 'validation_failed' &&
    error.issues.some(
      (issue) =>
        issue.path.includes('origin') ||
        (issue.code === 'unrecognized_keys' &&
          issue.message.includes('"origin"')),
    )
  );
}

// One task of the network block with its poster's operator slug,
// lowercased (RT-8).
type NetworkTask = { id: string; operator: string };

// The network block of a routine run, isNetworkTask above, at most want of
// them, oldest first within each origin (RT-8). Each origin is read through
// the API's origin filter with the cursor, up to NETWORK_PAGES pages, until
// the block is full, so older manual posts and a page of counterparty
// templates never hide a claimable task. A task is taken only when it is
// old enough by posted_at and its poster is at bronze or above and of an
// operator other than own, not in barred (operators whose task this agent
// failed) and not in taken (operators with a network claim today or
// earlier in this block), so each operator gets at most one. The poster's
// handle and level come with the task from an API since RT-8, and only an
// older answer is looked up, within NETWORK_POSTER_LOOKUPS. The list is
// oldest first, so the first task too young ends that origin. An API from
// before the filter refuses it, and then there are none. Throws what the
// API client throws otherwise.
async function networkCandidates(
  api: ApiClient,
  signer: Signer,
  posters: PosterLookup,
  own: string,
  want: number,
  barred: ReadonlySet<string>,
  taken: ReadonlySet<string>,
  now: number,
): Promise<{ tasks: TaskResponse[]; network: NetworkTask[] }> {
  const tasks: TaskResponse[] = [];
  const network: NetworkTask[] = [];
  if (want <= 0) return { tasks, network };
  const operators = new Set(taken);
  const looked = new Set<string>();
  // The poster's operator slug, lowercased, when it may post to the block.
  const operatorOf = async (task: TaskResponse): Promise<string | null> => {
    let slug: string;
    let level: string | undefined;
    if (task.poster !== undefined) {
      if (task.poster.operatedBySealKeeper === true) return null;
      slug = task.poster.handle.split('/')[0] ?? '';
      level = task.poster.level;
    } else {
      if (!looked.has(task.posterAgentId)) {
        if (looked.size >= NETWORK_POSTER_LOOKUPS) return null;
        looked.add(task.posterAgentId);
      }
      const poster = await posters.get(task.posterAgentId);
      if (poster === null || runBySealKeeper(poster)) return null;
      slug = operatorSlugOf(poster);
      level = poster.level;
    }
    if (!NETWORK_POSTER_LEVELS.includes(level ?? 'none')) return null;
    const operator = slug.toLowerCase();
    if (operator === '' || operator === own || barred.has(operator)) {
      return null;
    }
    return operator;
  };
  for (const origin of NETWORK_ORIGINS) {
    let cursor: string | undefined;
    for (let page = 0; page < NETWORK_PAGES && tasks.length < want; page++) {
      let read: { tasks: TaskResponse[]; nextCursor: string | null };
      try {
        read = await openTasksPage(api, signer, {
          seed: false,
          origin,
          limit: LIST_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        if (refusesOrigin(error)) return { tasks: [], network: [] };
        throw error;
      }
      let young = false;
      for (const task of read.tasks) {
        if (tasks.length >= want) break;
        if (
          task.posterAgentId === signer.agentId ||
          task.origin !== origin ||
          !isNetworkTask(task)
        ) {
          continue;
        }
        if (!claimableByAge(task, now)) {
          young = true;
          break;
        }
        const operator = await operatorOf(task);
        if (operator === null || operators.has(operator)) continue;
        operators.add(operator);
        tasks.push(task);
        network.push({ id: task.id, operator });
      }
      if (young || read.nextCursor === null) break;
      cursor = read.nextCursor;
    }
  }
  tasks.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  return { tasks, network };
}

// A claim the API refused as posted too recently (RT-8), as run --json
// names it on stderr in a routine run. retryAfterSec is the API's wait, null when it sent
// none.
type TooNew = {
  id: string;
  taskType: string;
  reason: 'too_new';
  retryAfterSec: number | null;
};

const claimLimitReached = (cap: number): string =>
  `the routine's daily limit of ${cap} claims is reached, nothing more is claimed today`;

// network is the tasks of the network block with their operators, which a
// routine run counts against networkClaimsPerDay (RT-8).
export type RoutineCandidates = {
  tasks: TaskResponse[];
  network?: NetworkTask[];
  skipped: Pick<
    SkipEntry,
    'action' | 'taskId' | 'reason' | 'operator' | 'taskType'
  >[];
};

// What a routine run may claim, in order, and what it must leave for a
// person. Tasks addressed to this agent by allowed operators come first,
// then other operators' template and routine tasks that SealKeeper checks
// by hash or schema, oldest first, once past the claim age threshold so a
// person gets the first look (RT-8), since a real operator's post moving
// is what the ladder needs and seed tasks never run short. The network
// block holds up to networkRemaining tasks plus NETWORK_CLAIM_ATTEMPTS
// spares for lost claims, see networkCandidates. Seed tasks come
// last, at any age, the types the routine has claimed least first (done,
// from seedTypesDone), since repeats of one type count less each time
// (VOU-140). Any other open task another agent posted, a manual post or a
// counterparty task, is never claimed unattended. Tasks of this agent's own
// operator are left out without a note, since they never count. Throws what
// the API client throws.
export async function routineCandidates(
  api: ApiClient,
  posters: PosterLookup,
  signer: Signer,
  config: Config,
  routine: RoutineConfig,
  done: ReadonlyMap<string, number> = new Map(),
  options: {
    networkRemaining?: number;
    barredOperators?: ReadonlySet<string>;
    operatorsToday?: ReadonlySet<string>;
  } = {},
): Promise<RoutineCandidates> {
  const { agentId } = signer;
  const networkRemaining =
    options.networkRemaining ?? routine.limits.networkClaimsPerDay;
  const own = normalLogin(config.operatorLogin);
  const tasks: TaskResponse[] = [];
  const seeds: TaskResponse[] = [];
  const skipped: RoutineCandidates['skipped'] = [];

  for (const task of await listAddressed(api, agentId)) {
    if (task.posterAgentId === agentId) continue;
    const login = await posters.operatorOf(task);
    if (login !== undefined && normalLogin(login) === own) continue;
    const slug = await posters.slugOf(task);
    if (isAllowed(routine, await posters.get(task.posterAgentId))) {
      tasks.push(task);
      continue;
    }
    skipped.push({
      action: 'claim',
      taskId: task.id,
      reason: 'poster_not_allowed',
      taskType: task.taskType,
      ...(slug === undefined ? {} : { operator: slug }),
    });
  }

  const now = Date.now();
  // The own operator by slug, as handles show it, the login lowercased
  // while none is stored.
  const ownSlug = (
    (await readOperatorSlug(agentId)) ?? config.operatorLogin
  ).toLowerCase();
  const block =
    networkRemaining > 0
      ? await networkCandidates(
          api,
          signer,
          posters,
          ownSlug,
          networkRemaining + NETWORK_CLAIM_ATTEMPTS,
          options.barredOperators ?? new Set(),
          options.operatorsToday ?? new Set(),
          now,
        )
      : { tasks: [], network: [] };
  const others = block.tasks;
  const all = await ranked(posters, [
    ...(await openSeedTasks(api, signer)),
    ...(await openOtherTasks(api, signer)),
  ]);
  // The own operator check looks posters up through the cache, at most
  // MAX_POSTER_LOOKUPS of them. A task of a poster past that is noted for a
  // person with no operator named.
  const looked = new Set<string>();
  const operatorOf = async (task: TaskResponse) => {
    if (!looked.has(task.posterAgentId)) {
      if (looked.size >= MAX_POSTER_LOOKUPS) return undefined;
      looked.add(task.posterAgentId);
    }
    return posters.operatorOf(task);
  };
  for (const { task, seed } of all) {
    if (seed) {
      seeds.push(task);
      continue;
    }
    // A network task is never noted for a person. One too young for the
    // claim age threshold is taken by a later run.
    if (isNetworkTask(task)) continue;
    const login = await operatorOf(task);
    if (login !== undefined && normalLogin(login) === own) continue;
    // Cached by now, or undefined past the lookup cap.
    const slug = login === undefined ? undefined : await posters.slugOf(task);
    skipped.push({
      action: 'claim',
      taskId: task.id,
      reason: 'open_task',
      taskType: task.taskType,
      ...(slug === undefined ? {} : { operator: slug }),
    });
  }
  // A stable sort, so tasks of one type keep the order ranked gave them.
  const least = (t: TaskResponse) => done.get(t.taskType) ?? 0;
  tasks.push(...others, ...seeds.sort((a, b) => least(a) - least(b)));
  return { tasks, network: block.network, skipped };
}

// The held tasks a routine run may work, in order, and the rest as skips
// for a person. Seed tasks, tasks from operators on the allowlist, network
// tasks from another operator (isNetworkTask, RT-8) and tasks of this
// agent's own operator are kept. Anything else, such as a task
// claimed by hand before the run, is never handed to the unattended agent.
// A poster that cannot be looked up is not allowed.
export async function routineHeld(
  posters: PosterLookup,
  tasks: TaskResponse[],
  config: Config,
  routine: RoutineConfig,
): Promise<RoutineCandidates> {
  const own = normalLogin(config.operatorLogin);
  const kept: TaskResponse[] = [];
  const skipped: RoutineCandidates['skipped'] = [];
  for (const task of tasks) {
    if (task.seed === true) {
      kept.push(task);
      continue;
    }
    // Only a task that does not say is looked up here. One the API marks
    // as no seed task goes straight to the operator check below.
    const poster =
      task.seed === undefined ? await posters.get(task.posterAgentId) : null;
    if (poster !== null && runBySealKeeper(poster)) {
      kept.push(task);
      continue;
    }
    const login = await posters.operatorOf(task);
    const slug = await posters.slugOf(task);
    if (
      (login !== undefined &&
        (normalLogin(login) === own || isNetworkTask(task))) ||
      isAllowed(routine, await posters.get(task.posterAgentId))
    ) {
      kept.push(task);
      continue;
    }
    skipped.push({
      action: 'claim',
      taskId: task.id,
      reason: task.assignee ? 'poster_not_allowed' : 'open_task',
      taskType: task.taskType,
      ...(slug === undefined ? {} : { operator: slug }),
    });
  }
  return { tasks: kept, skipped };
}

// How many tasks of each type the routine has claimed in the last 180 days,
// the scoring window, from routine.jsonl. A claim logged before the type
// was logged counts for no type.
export function seedTypesDone(
  entries: RoutineEntry[],
  now: Date = new Date(),
): Map<string, number> {
  const since = now.getTime() - 180 * 86_400_000;
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== 'claim' || e.taskType === undefined) continue;
    if (Date.parse(e.at) <= since) continue;
    out.set(e.taskType, (out.get(e.taskType) ?? 0) + 1);
  }
  return out;
}

// Logs each skip not already logged in the last week.
export async function logSkips(
  entries: RoutineEntry[],
  skipped: RoutineCandidates['skipped'],
  runId: string,
  now: number,
): Promise<void> {
  const seen = {
    claim: skippedIds(entries, 'claim', new Date(now)),
    confirm: skippedIds(entries, 'confirm', new Date(now)),
  };
  for (const skip of skipped) {
    if (seen[skip.action].has(skip.taskId)) continue;
    seen[skip.action].add(skip.taskId);
    await appendRoutine({ kind: 'skip', runId, ...skip });
  }
}

// Tasks this agent claimed in the local log, not submitted, and still
// claimed by it on the server. A lookup that fails skips that task.
async function heldTasks(
  api: ApiClient,
  agentId: string,
  want: number,
  now: number,
): Promise<TaskResponse[]> {
  const held: TaskResponse[] = [];
  for (const id of await unsubmittedClaims(new Date(now))) {
    if (held.length >= want) break;
    try {
      const task = await api.getTask(id);
      if (
        task.state === 'claimed' &&
        task.claimantAgentId === agentId &&
        Date.parse(task.expiresAt) > now
      ) {
        held.push(task);
      }
    } catch {
      // Gone, or the API did not answer. Either way not one to print.
    }
  }
  return held;
}

// Claimed tasks the server says this agent holds, added to tasks up to want.
// A failed lookup adds nothing, the caller still prints what it has.
async function addServerHeld(
  api: ApiClient,
  agentId: string,
  tasks: TaskResponse[],
  want: number,
  now: number,
): Promise<void> {
  let claimed: TaskResponse[];
  try {
    claimed = await serverHeld(api, agentId);
  } catch {
    return;
  }
  const have = new Set(tasks.map((task) => task.id));
  for (const task of claimed) {
    if (tasks.length >= want) break;
    if (Date.parse(task.expiresAt) > now && !have.has(task.id)) {
      tasks.push(task);
      have.add(task.id);
    }
  }
}

// What a routine run knows about the agents that posted open tasks. Each poster is
// asked about at most once. A lookup that fails is remembered as unknown.
export class PosterLookup {
  private readonly agents = new Map<string, AgentResponse | null>();
  constructor(private readonly api: ApiClient) {}

  async get(agentId: string): Promise<AgentResponse | null> {
    if (!this.agents.has(agentId)) {
      let agent: AgentResponse | null = null;
      try {
        agent = await this.api.getAgent(agentId);
      } catch {
        // Unknown, never an error.
      }
      this.agents.set(agentId, agent);
    }
    return this.agents.get(agentId) ?? null;
  }

  // The poster's operator login from a lookup, undefined when it fails.
  // The own operator check compares it with the login in config.json.
  async operatorOf(task: TaskResponse): Promise<string | undefined> {
    return (await this.get(task.posterAgentId))?.operator.login;
  }

  // The poster's operator slug from a lookup, as the handle shows it, to
  // name the operator of skipped work. undefined when the lookup fails.
  async slugOf(task: TaskResponse): Promise<string | undefined> {
    const poster = await this.get(task.posterAgentId);
    return poster === null ? undefined : operatorSlugOf(poster);
  }
}

// Seed tasks first, then other tasks the server checks on submit, then
// counterparty tasks. Oldest first within each. A task says whether it is a
// seed task (VOU-208). One from an API that does not say is unknown, and
// its poster is looked up instead, at most MAX_POSTER_LOOKUPS of them,
// since only the API knows which agent SealKeeper runs.
async function ranked(
  posters: PosterLookup,
  open: TaskResponse[],
): Promise<{ task: TaskResponse; seed: boolean }[]> {
  const seedPosters = new Set<string>();
  const unknown = open.filter((task) => task.seed === undefined);
  const ids = [...new Set(unknown.map((task) => task.posterAgentId))];
  for (const poster of ids.slice(0, MAX_POSTER_LOOKUPS)) {
    const agent = await posters.get(poster);
    if (agent && runBySealKeeper(agent)) seedPosters.add(poster);
  }
  const isSeed = (task: TaskResponse) =>
    task.seed ?? seedPosters.has(task.posterAgentId);
  const rank = (task: TaskResponse) => {
    if (isSeed(task)) return 0;
    return task.verification.kind === 'counterparty' ? 2 : 1;
  };
  return [...open]
    .sort(
      (a, b) =>
        rank(a) - rank(b) || Date.parse(a.postedAt) - Date.parse(b.postedAt),
    )
    .map((task) => ({ task, seed: isSeed(task) }));
}
