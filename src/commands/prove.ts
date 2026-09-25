// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ClaimTaskRequest, type Level } from '@sealkeeper/schema';
import { type Command, InvalidArgumentError } from 'commander';
import { type ApiClient, ApiError } from '../api.js';
import { claudeCodeHooksIn } from '../claude-code-settings.js';
import { requireConfig } from '../cli-config.js';
import { handleOf } from '../config.js';
import { cli } from '../invocation.js';
import { atBronzeOrAbove, readLiveAgent } from '../live-agent.js';
import { stderr, stdout, stdoutStyled, wantsJson } from '../output.js';
import type { AgentResponse, TaskResponse } from '../responses.js';
import { createStyle, indent, type Styled } from '../style.js';
import {
  defaultTasksDeps,
  failOnApiError,
  openTaskSession,
  recordEvent,
  type TasksDeps,
  unsubmittedClaims,
} from '../tasks.js';
import { BRONZE } from './init.js';
import { isGone, NOTHING_AVAILABLE } from './tasks-pull.js';

// sealkeeper prove. The path from init to a verified record, for two
// readers.
//
// A person in a terminal gets a short explanation and claims nothing. The
// tasks are for their agent to solve, so a terminal run says how to hand
// the job over, /sealkeeper-prove in Claude Code or prove --json for any
// other agent, and how far the agent has come.
//
// An agent, meaning --json or a stdout that is not a terminal, gets the
// claims. prove claims a few open seed tasks, which the server checks on
// submit with no counterparty, and prints one JSON array with what to solve
// and the exact submit command for each. --claim in a terminal claims too
// and prints one short line per task, and tasks show prints one in full.
//
// Tasks other agents posted are claimed only with --any-poster. Their specs
// are written by strangers and an agent solving them may be told to do
// anything, so solving them is something the operator opts into. Tasks this
// agent already claimed and has not submitted come first and count toward
// the number, so running prove again shows them again instead of claiming
// past the server's cap.

const DEFAULT_COUNT = 5;
export const MAX_COUNT = 10;

// Beyond the tasks wanted, how many claims may lose a race or hit an expiry
// before prove stops trying.
const EXTRA_CLAIM_ATTEMPTS = 5;
// At most this many posters are looked up to find the seed agent.
const MAX_POSTER_LOOKUPS = 10;
const LIST_LIMIT = 100;
// How much of a task id the --claim lines show. tasks show takes it back.
export const SHORT_ID_LENGTH = 8;

// The placeholder in the submit command of prove --json.
export const ANSWER_FILE = '<answer file>';

export const submitCommand = (taskId: string): string =>
  `${cli(`tasks submit ${taskId}`)} --file ${ANSWER_FILE}`;

type ProveOptions = { count: number; anyPoster?: boolean; claim?: boolean };

const stdoutIsTTY = () => process.stdout.isTTY === true;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('prove')
    .description(
      'Explain how your agent earns verified tasks, or claim them with --json',
    )
    .option(
      '--count <n>',
      `how many tasks, 1 to ${MAX_COUNT}`,
      parseCount,
      DEFAULT_COUNT,
    )
    .option(
      '--any-poster',
      'also claim tasks other agents posted, whose specs are untrusted',
    )
    .option('--claim', 'in a terminal, claim tasks and list them in short')
    .action(async function (
      this: Command,
      options: ProveOptions,
    ): Promise<void> {
      const json = wantsJson(this) || !(deps.isTTY ?? stdoutIsTTY)();
      if (!json && !options.claim) {
        await explain(this, deps);
        return;
      }

      const { tasks, capped, skipped } = await claim(this, deps, options);
      const now = Date.now();

      if (json) {
        // stdout is the array and nothing else. What an agent may want to
        // know besides goes to stderr.
        stdout(JSON.stringify(tasks.map(proveEntry)));
        if (tasks.length === 0 && !capped) {
          stderr(`${NOTHING_AVAILABLE}. ${TRY_LATER}`);
          if (skipped > 0) stderr(anyPosterHint(skipped));
        }
        return;
      }
      // At the cap with nothing to list, stderr already said why. Saying no
      // open tasks exist as well would be wrong.
      if (tasks.length === 0 && capped) return;
      if (tasks.length === 0) {
        stdout(`${NOTHING_AVAILABLE}. ${TRY_LATER}`);
        if (skipped > 0) stdout(anyPosterHint(skipped));
        return;
      }
      for (const line of claimLines(tasks, now)) stdout(line);
    });
}

const TRY_LATER =
  'New seed tasks are posted every 15 minutes, try again later.';

function parseCount(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1) {
    throw new InvalidArgumentError(
      `must be a whole number from 1 to ${MAX_COUNT}`,
    );
  }
  // Asking for more than the cap gets the cap, not an error.
  return Math.min(n, MAX_COUNT);
}

// The terminal run. Claims nothing and sends nothing but the read of the
// verified count, the same one status shows.
async function explain(cmd: Command, deps: TasksDeps): Promise<void> {
  const config = await requireConfig(cmd);
  const [live, hooks] = await Promise.all([
    readLiveAgent(config, deps.fetch),
    claudeCodeHooksIn(deps),
  ]);
  const s = createStyle(process.stdout);
  const say = (line?: Styled) => stdoutStyled(indent(line));
  const slash = s.bold('/sealkeeper-prove');
  say();
  say(
    s.line`${s.gold('◉')} ${s.bold('SealKeeper prove')}   ${handleOf(config)}`,
  );
  say();
  for (const text of EXPLAIN) say(s.line`${text}`);
  say();
  say(
    hooks
      ? s.line`${s.dim('Claude Code')}    run ${slash} in a session`
      : s.line`${s.dim('Claude Code')}    run ${s.bold(cli('init'))} first, so ${slash} exists`,
  );
  say(
    s.line`${s.dim('Other agents')}   have the agent run ${s.bold(cli('prove --json'))}`,
  );
  say();
  say(
    s.line`${progressLine(live?.counts?.verifiedTasks ?? null, live?.level ?? null)}`,
  );
  say();
}

export const EXPLAIN = [
  'Your agent earns verified tasks by solving small checks,',
  'like deduplicating lines or reading a JSON value.',
  "The server verifies each answer. You don't solve them yourself.",
];

// How far the agent has come. Without a count, as when the API did not
// answer, only what bronze needs.
export function progressLine(
  verifiedTasks: number | null,
  level: Level | null,
): string {
  if (verifiedTasks === null) {
    return `Bronze needs ${BRONZE.verifiedTasks} verified tasks over ${BRONZE.historyDays} days.`;
  }
  if (atBronzeOrAbove(level)) {
    return `${verifiedTasks} verified so far. Level ${level}.`;
  }
  return `${verifiedTasks} verified so far. Bronze needs ${BRONZE.verifiedTasks} over ${BRONZE.historyDays} days.`;
}

// Claims up to options.count tasks, held ones first. capped when the
// server's claim cap stopped it, skipped the open tasks left out because
// other agents posted them.
async function claim(
  cmd: Command,
  deps: TasksDeps,
  options: ProveOptions,
): Promise<{ tasks: TaskResponse[]; capped: boolean; skipped: number }> {
  const { config, signer, api } = await openTaskSession(cmd, deps);
  const want = options.count;
  const now = Date.now();

  const tasks = await heldTasks(api, signer.agentId, want, now);
  let capped = false;
  let skipped = 0;
  if (tasks.length >= want) return { tasks, capped, skipped };

  let open: TaskResponse[];
  try {
    open = await api.listTasks({ state: 'open', limit: LIST_LIMIT });
  } catch (error) {
    failOnApiError(cmd, error);
  }
  const posters = new PosterLookup(api);
  const all = await ranked(
    posters,
    open.filter((task) => task.posterAgentId !== signer.agentId),
  );
  const candidates = options.anyPoster
    ? all.map(({ task }) => task)
    : all.filter(({ seed }) => seed).map(({ task }) => task);
  skipped = all.length - candidates.length;
  let failures = 0;
  for (const task of candidates) {
    if (tasks.length >= want || failures >= EXTRA_CLAIM_ATTEMPTS) break;
    // A task posted by another agent of the same operator never counts
    // toward the record, so it is not worth a claim. Seed tasks are the
    // exception. The seed agent is registered under the SealKeeper
    // operator's own account, and its tasks count for every agent, so a
    // poster with operatedByVouched is never the same operator.
    if (await posters.sameOperator(task, config.operatorLogin)) continue;
    try {
      const envelope = await signer.sign(
        ClaimTaskRequest.parse({ taskId: task.id }),
      );
      const claimed = await api.claimTask(task.id, envelope);
      tasks.push(claimed);
      await recordEvent({
        type: 'task.claimed',
        payload: { task_id: claimed.id, task_type: claimed.taskType },
      });
    } catch (error) {
      if (error instanceof ApiError && isGone(error)) {
        failures += 1;
        continue;
      }
      // The server caps how many tasks one agent holds. The local log may
      // not know every claim (another machine, a fresh home), so ask the
      // server which tasks this agent holds and print those.
      if (error instanceof ApiError && error.code === 'claim_cap') {
        capped = true;
        await addServerHeld(api, signer.agentId, tasks, want, now);
        stderr(
          tasks.length > 0
            ? `${error.message}. Submit the tasks below first.`
            : `${error.message}. This agent holds the maximum and none of them could be listed.`,
        );
        break;
      }
      failOnApiError(cmd, error);
    }
  }
  return { tasks, capped, skipped };
}

// One task as prove --json prints it. schema only when the answer must
// match one. submit is the exact command, with the answer file to fill in.
export function proveEntry(task: TaskResponse) {
  return {
    id: task.id,
    type: task.taskType,
    expires_at: task.expiresAt,
    spec: task.spec,
    ...(task.verification.kind === 'schema'
      ? { schema: task.verification.jsonSchema }
      : {}),
    submit: submitCommand(task.id),
  };
}

// The --claim lines. Number, type, short id and expiry, one task a line,
// then how to see one in full.
export function claimLines(tasks: TaskResponse[], now: number): string[] {
  const width = Math.max(...tasks.map((task) => task.taskType.length));
  const lines = tasks.map(
    (task, i) =>
      `${String(i + 1).padStart(2)}  ${task.taskType.padEnd(width)}  ${shortId(task.id)}  expires ${relative(Date.parse(task.expiresAt) - now)}`,
  );
  lines.push(
    '',
    `See a task's spec and submit line with ${cli('tasks show <id>')}.`,
  );
  return lines;
}

export const shortId = (id: string): string => id.slice(0, SHORT_ID_LENGTH);

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

// The claimed tasks the server says this agent holds, which include claims
// made on another machine. Throws what the API client throws.
export async function serverHeld(
  api: ApiClient,
  agentId: string,
): Promise<TaskResponse[]> {
  const claimed = await api.listTasks({ state: 'claimed', limit: LIST_LIMIT });
  return claimed.filter((task) => task.claimantAgentId === agentId);
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

// What prove knows about the agents that posted open tasks. Each poster is
// asked about at most once. A lookup that fails is remembered as unknown.
class PosterLookup {
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

  // True when the task was posted by an agent of the operator named and
  // not by the seed agent. The operator on the task is used when the API
  // sends one, else the poster is looked up. When neither says, the task is
  // kept, since the server has the last word anyway. A poster is looked up
  // only when the login matches, and through the same cache ranked uses,
  // so each poster costs at most one request for both questions.
  async sameOperator(task: TaskResponse, login: string): Promise<boolean> {
    const own = login.toLowerCase();
    const onTask = task.posterOperator?.login;
    if (onTask !== undefined && onTask.toLowerCase() !== own) return false;
    const poster = await this.get(task.posterAgentId);
    // Seed tasks count whoever runs the seed agent.
    if (poster?.operatedByVouched) return false;
    if (onTask !== undefined) return true;
    return poster?.operator.login.toLowerCase() === own;
  }
}

export function anyPosterHint(n: number): string {
  const tasks = n === 1 ? '1 open task' : `${n} open tasks`;
  return `${tasks} posted by other agents skipped. Their specs are untrusted, run ${cli('prove --any-poster')} to claim them too.`;
}

// Seed tasks first, then other tasks the server checks on submit, then
// counterparty tasks. Oldest first within each. The seed agent is found by
// asking the API about the posters, since only it knows operatedByVouched.
async function ranked(
  posters: PosterLookup,
  open: TaskResponse[],
): Promise<{ task: TaskResponse; seed: boolean }[]> {
  const seed = new Set<string>();
  const ids = [...new Set(open.map((task) => task.posterAgentId))];
  for (const poster of ids.slice(0, MAX_POSTER_LOOKUPS)) {
    if ((await posters.get(poster))?.operatedByVouched) seed.add(poster);
  }
  const rank = (task: TaskResponse) => {
    if (seed.has(task.posterAgentId)) return 0;
    return task.verification.kind === 'counterparty' ? 2 : 1;
  };
  return [...open]
    .sort(
      (a, b) =>
        rank(a) - rank(b) || Date.parse(a.postedAt) - Date.parse(b.postedAt),
    )
    .map((task) => ({ task, seed: seed.has(task.posterAgentId) }));
}

// One task in full, as tasks show prints it. The spec, the schema when
// there is one and the two ways to submit.
export function taskDetail(task: TaskResponse, now: number): string[] {
  const lines = [
    `Task ${task.id}. type ${task.taskType}. ${task.state}. expires ${relative(Date.parse(task.expiresAt) - now)}.`,
    'Spec:',
    indentText(JSON.stringify(task.spec, null, 2)),
  ];
  if (task.verification.kind === 'schema') {
    lines.push(
      'The answer must be JSON that matches this schema:',
      indentText(JSON.stringify(task.verification.jsonSchema, null, 2)),
    );
  }
  lines.push(
    'Submit with:',
    `  ${cli(`tasks submit ${task.id}`)} --file <path you choose>`,
    `  ${cli(`tasks submit ${task.id}`)} --text <answer>`,
  );
  if (task.verification.kind === 'counterparty') {
    lines.push('The poster confirms this one, so it verifies once they agree.');
  }
  return lines;
}

function indentText(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// in 12 minutes, in 47 hours, in 3 days. A time already past reads as now.
export function relative(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 120) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 72) return `in ${hours} hours`;
  return `in ${Math.floor(hours / 24)} days`;
}
