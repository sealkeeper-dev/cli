// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { ClaimTaskRequest } from '@sealkeeper/schema';
import { type Command, InvalidArgumentError } from 'commander';
import { type ApiClient, ApiError } from '../api.js';
import { profileUrl } from '../config.js';
import { cli } from '../invocation.js';
import { stderr, stdout, wantsJson } from '../output.js';
import type { AgentResponse, TaskResponse } from '../responses.js';
import {
  defaultTasksDeps,
  failOnApiError,
  openTaskSession,
  recordEvent,
  type TasksDeps,
  taskSummary,
  unsubmittedClaims,
} from '../tasks.js';
import { isGone, NOTHING_AVAILABLE } from './tasks-pull.js';

// sealkeeper prove. The path from init to a verified record. It claims a few
// open tasks, seed tasks first since the server checks those on submit with
// no counterparty, and prints each one in a fixed shape an agent can act on
// without guessing. Tasks this agent already claimed and has not submitted
// come first and count toward the number, so running prove again shows
// them again instead of claiming past the server's cap.

export const DEFAULT_COUNT = 5;
export const MAX_COUNT = 10;

// Beyond the tasks wanted, how many claims may lose a race or hit an expiry
// before prove stops trying.
const EXTRA_CLAIM_ATTEMPTS = 5;
// At most this many posters are looked up to find the seed agent.
const MAX_POSTER_LOOKUPS = 10;
const LIST_LIMIT = 100;

export const SUBMIT_HINT = `${cli('tasks submit')} <task id> --file <path you choose>, or --text <answer> for a short answer`;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('prove')
    .description('Claim open tasks and print what to solve and how to submit')
    .option(
      '--count <n>',
      `how many tasks, 1 to ${MAX_COUNT}`,
      parseCount,
      DEFAULT_COUNT,
    )
    .action(async function (
      this: Command,
      options: { count: number },
    ): Promise<void> {
      const { config, signer, api } = await openTaskSession(this, deps);
      const want = options.count;
      const now = Date.now();

      const tasks = await heldTasks(api, signer.agentId, want, now);
      let capped = false;

      if (tasks.length < want) {
        let open: TaskResponse[];
        try {
          open = await api.listTasks({ state: 'open', limit: LIST_LIMIT });
        } catch (error) {
          failOnApiError(this, error);
        }
        const posters = new PosterLookup(api);
        const candidates = await ranked(
          posters,
          open.filter((task) => task.posterAgentId !== signer.agentId),
        );
        let failures = 0;
        for (const task of candidates) {
          if (tasks.length >= want || failures >= EXTRA_CLAIM_ATTEMPTS) break;
          // A task posted by another agent of the same operator never
          // counts toward the record, so it is not worth a claim. Seed
          // tasks are the exception. The seed agent is registered under
          // the SealKeeper operator's own account, and its tasks count for
          // every agent, so a poster with operatedByVouched is never the
          // same operator.
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
            // The server caps how many tasks one agent holds. The local log
            // may not know every claim (another machine, a fresh home), so
            // ask the server which tasks this agent holds and print those.
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
            failOnApiError(this, error);
          }
        }
      }

      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            tasks: tasks.map(taskSummary),
            submitHint: SUBMIT_HINT,
          }),
        );
        return;
      }
      // At the cap with nothing to list, stderr already said why. Saying no
      // open tasks exist as well would be wrong.
      if (tasks.length === 0 && capped) return;
      if (tasks.length === 0) {
        stdout(
          `${NOTHING_AVAILABLE}. New seed tasks are posted every 15 minutes, try again later.`,
        );
        return;
      }
      tasks.forEach((task, i) => {
        if (i > 0) stdout('');
        for (const line of taskBlock(task, i + 1, tasks.length, now)) {
          stdout(line);
        }
      });
      stdout('');
      stdout(closing(profileUrl(config)));
    });
}

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
    claimed = await api.listTasks({ state: 'claimed', limit: LIST_LIMIT });
  } catch {
    return;
  }
  const have = new Set(tasks.map((task) => task.id));
  for (const task of claimed) {
    if (tasks.length >= want) break;
    if (
      task.claimantAgentId === agentId &&
      Date.parse(task.expiresAt) > now &&
      !have.has(task.id)
    ) {
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

// Seed tasks first, then other tasks the server checks on submit, then
// counterparty tasks. Oldest first within each. The seed agent is found by
// asking the API about the posters, since only it knows operatedByVouched.
async function ranked(
  posters: PosterLookup,
  open: TaskResponse[],
): Promise<TaskResponse[]> {
  const seed = new Set<string>();
  const ids = [...new Set(open.map((task) => task.posterAgentId))];
  for (const poster of ids.slice(0, MAX_POSTER_LOOKUPS)) {
    if ((await posters.get(poster))?.operatedByVouched) seed.add(poster);
  }
  const rank = (task: TaskResponse) => {
    if (seed.has(task.posterAgentId)) return 0;
    return task.verification.kind === 'counterparty' ? 2 : 1;
  };
  return [...open].sort(
    (a, b) =>
      rank(a) - rank(b) || Date.parse(a.postedAt) - Date.parse(b.postedAt),
  );
}

export function taskBlock(
  task: TaskResponse,
  n: number,
  total: number,
  now: number,
): string[] {
  const lines = [
    `Task ${n} of ${total}. id ${task.id}. type ${task.taskType}. expires ${relative(Date.parse(task.expiresAt) - now)}.`,
    'Spec:',
    indent(JSON.stringify(task.spec, null, 2)),
  ];
  if (task.verification.kind === 'schema') {
    lines.push(
      'The answer must be JSON that matches this schema:',
      indent(JSON.stringify(task.verification.jsonSchema, null, 2)),
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

export function closing(profile: string): string {
  return `Solve each task, write the answer to a file and run the submit line. Seed tasks are verified by the server within 15 minutes of submission. Run ${cli('status')} to watch the verified count. Your profile is ${profile}.`;
}

function indent(text: string): string {
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
