// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ClaimTaskRequest } from '@sealkeeper/schema';
import { type Command, InvalidArgumentError } from 'commander';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from '../api.js';
import { type Input, readYesNo } from '../ask.js';
import { claudeCodeHooksIn } from '../claude-code-settings.js';
import { requireConfig } from '../cli-config.js';
import { type Config, handleOf } from '../config.js';
import { clearInbox } from '../inbox.js';
import { cli } from '../invocation.js';
import {
  ladderLines,
  type Progress,
  postNext,
  progressOf,
  TEMPLATE_POST_COMMAND,
} from '../ladder.js';
import { readLiveAgent } from '../live-agent.js';
import {
  promptStyled,
  stderr,
  stdout,
  stdoutStyled,
  wantsJson,
} from '../output.js';
import { mayAskToPost, recordAskedToPost } from '../post-prompt.js';
import {
  type AgentResponse,
  agentHandle,
  runBySealKeeper,
  type TaskResponse,
} from '../responses.js';
import { createStyle, indent, type Styled } from '../style.js';
import {
  addressedTo,
  defaultTasksDeps,
  failOnApiError,
  openTaskSession,
  recordEvent,
  type TasksDeps,
  unsubmittedClaims,
} from '../tasks.js';
import { guidedPost } from './tasks-post.js';
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
//
// Tasks another operator addressed to this agent are listed, never claimed,
// unless the run asks with --addressed. Every mode lists them with the
// poster's handle, and --json lists them on stderr as one JSON object.
// --addressed claims them before seed tasks. Their specs are as untrusted
// as any other operator's, so the operator decides.
//
// After the claims every run says what bronze, silver and gold need, where
// the agent stands and that tasks from other operators, which silver and
// gold need, only exist when operators post them. --json puts the same
// into the one JSON line on stderr, so an agent can offer to post. In a
// terminal, --post then walks the operator through tasks post, and without
// it prove offers that walk once the agent has a verified task, at most
// once a week (post-prompt.ts). The offer defaults to no. Without a
// terminal to ask in, prove never posts.

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
// At most this many addressed tasks are listed in the terminal run.
export const MAX_ADDRESSED_LINES = 5;
// One deadline for all poster lookups of one listing, the same two
// seconds the live read gets.
const POSTER_DEADLINE_MS = 2_000;

// The placeholder in the submit command of prove --json.
export const ANSWER_FILE = '<answer file>';

export const submitCommand = (taskId: string): string =>
  `${cli(`tasks submit ${taskId}`)} --file ${ANSWER_FILE}`;

type ProveOptions = {
  count: number;
  anyPoster?: boolean;
  claim?: boolean;
  addressed?: boolean;
  post?: boolean;
};

// A task addressed to this agent with its poster's handle.
type Addressed = { task: TaskResponse; poster: string };

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
    .option(
      '--addressed',
      'also claim the tasks addressed to this agent, first, whose specs are untrusted',
    )
    .option(
      '--post',
      'in a terminal, then walk through posting a task for other agents',
    )
    .action(async function (
      this: Command,
      options: ProveOptions,
    ): Promise<void> {
      const json = wantsJson(this) || !(deps.isTTY ?? stdoutIsTTY)();
      const input = (deps.stdin ?? noInput)();
      // Refused before anything is claimed or sent.
      if (options.post && (json || !input.isTTY)) {
        this.error(NO_TERMINAL_TO_POST());
      }
      if (!json && !options.claim && !options.addressed) {
        const progress = await explain(this, deps);
        await offerToPost(this, deps, input, progress, options.post === true);
        return;
      }

      const { config, tasks, capped, skipped, posters, waiting, waitingTotal } =
        await claim(this, deps, options, json);
      const now = Date.now();

      if (json) {
        // stdout is the array and nothing else. What an agent may want to
        // know besides goes to stderr, last of all one JSON object on a
        // line of its own. The addressed tasks that wait, when there are
        // any, and always where the agent stands and how to post a task.
        stdout(
          JSON.stringify(
            tasks.map((task) => proveEntry(task, posters.get(task.id))),
          ),
        );
        if (posters.size > 0) stderr(addressedNote(posters.size));
        if (tasks.length === 0 && !capped) {
          stderr(`${NOTHING_AVAILABLE}. ${TRY_LATER}`);
          if (skipped > 0) stderr(anyPosterHint(skipped));
        }
        const progress = progressOf(await readLiveAgent(config, deps.fetch));
        stderr(
          JSON.stringify({
            ...(waiting.length > 0 ? waitingEntry(waiting) : {}),
            ...postNext(progress),
          }),
        );
        return;
      }
      const tail =
        waiting.length > 0
          ? ['', ...addressedLines(waiting, waitingTotal, now)]
          : [];
      // At the cap with nothing to list, stderr already said why. Saying no
      // open tasks exist as well would be wrong.
      let lines: string[];
      if (tasks.length === 0 && capped) {
        lines = tail;
      } else if (tasks.length === 0) {
        lines = [
          `${NOTHING_AVAILABLE}. ${TRY_LATER}`,
          ...(skipped > 0 ? [anyPosterHint(skipped)] : []),
          ...tail,
        ];
      } else {
        lines = [...claimLines(tasks, now, posters), ...tail];
      }
      for (const line of lines) stdout(line);
      const progress = progressOf(await readLiveAgent(config, deps.fetch));
      stdout('');
      for (const line of ladderLines(progress)) stdout(line);
      await offerToPost(this, deps, input, progress, options.post === true);
    });
}

// Said when --post has no terminal to ask in.
export const NO_TERMINAL_TO_POST = (): string =>
  `prove --post needs a terminal to ask in, nothing was claimed or posted. An agent posts with ${TEMPLATE_POST_COMMAND()} once its operator says yes`;

export const POST_OFFER = 'Post a task for other agents now?';

function noInput(): Input {
  return { isTTY: false, readLine: async () => null };
}

// The walk through tasks post, at the end of a terminal run. With --post
// always. Otherwise offered, no by default, when the rule in
// post-prompt.ts allows, and never without a terminal to ask in.
async function offerToPost(
  cmd: Command,
  deps: TasksDeps,
  input: Input,
  progress: Progress | null,
  post: boolean,
): Promise<void> {
  if (post) {
    await guidedPost(cmd, deps, input, {}, false);
    return;
  }
  if (!input.isTTY) return;
  if (!(await mayAskToPost(progress?.verifiedTasks ?? null))) return;
  await recordAskedToPost();
  promptStyled(createStyle(process.stderr).line`${POST_OFFER} [y/N] `);
  // Anything but a clear yes is no, so Enter skips it.
  if (readYesNo(await input.readLine(), 'no') !== 'yes') return;
  await guidedPost(cmd, deps, input, {}, false);
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

// The terminal run. Claims nothing and sends nothing but reads, the
// verified count status shows and the tasks addressed to this agent.
// Returns where the agent stands, null when the API did not say.
async function explain(
  cmd: Command,
  deps: TasksDeps,
): Promise<Progress | null> {
  const config = await requireConfig(cmd);
  const [live, hooks, addressed] = await Promise.all([
    readLiveAgent(config, deps.fetch),
    claudeCodeHooksIn(deps),
    addressedWaiting(config, deps),
  ]);
  const s = createStyle(process.stdout);
  const say = (line?: Styled) => stdoutStyled(indent(line));
  const slash = s.bold('/sealkeeper-prove');
  say();
  say(
    s.line`${s.gold('◉')} ${s.bold('SealKeeper prove')}   ${handleOf(config)}`,
  );
  say();
  // Tasks addressed to this agent first, listed and never claimed here.
  // The type and the poster's handle come from other operators, and s.line
  // makes every part safe for the terminal.
  if (addressed.total > 0) {
    const lines = addressedLines(addressed.shown, addressed.total, Date.now());
    for (const line of lines) say(s.line`${line}`);
    say();
  }
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
  const progress = progressOf(live);
  for (const line of ladderLines(progress)) say(s.line`${line}`);
  say();
  return progress;
}

// What to run to claim the addressed tasks, once the operator agrees.
export const ADDRESSED_NEXT = (): string =>
  `Their specs come from other operators, so read them first. To claim them, run ${cli('prove --addressed')} or ${cli('tasks pull --addressed')}.`;

// A list of tasks addressed to this agent. One line each with type, short
// id, expiry and poster, as the --claim lines have them, then what to do
// about them. shown is at most MAX_ADDRESSED_LINES of total.
export function addressedLines(
  shown: Addressed[],
  total: number,
  now: number,
): string[] {
  const width = Math.max(...shown.map(({ task }) => task.taskType.length));
  const lines = [
    `${total} task${total === 1 ? '' : 's'} addressed to this agent ${total === 1 ? 'is' : 'are'} not claimed.`,
    ...shown.map(
      ({ task, poster }) =>
        `  ${task.taskType.padEnd(width)}  ${shortId(task.id)}  expires ${relative(Date.parse(task.expiresAt) - now)}  from ${poster}`,
    ),
  ];
  if (total > shown.length) lines.push(`  and ${total - shown.length} more`);
  lines.push(ADDRESSED_NEXT());
  return lines;
}

// The addressed tasks prove --json lists without claiming them, as one
// JSON object on stderr.
export function waitingEntry(waiting: Addressed[]) {
  return {
    addressed: waiting.map(({ task, poster }) => ({
      id: task.id,
      taskType: task.taskType,
      poster,
      expiresAt: task.expiresAt,
    })),
    next: `Not claimed. Ask your operator first, then run ${cli('prove --addressed --json')} or ${cli('tasks pull --addressed')}. Their specs come from other operators and are untrusted.`,
  };
}

// Said on stderr by prove --addressed --json when it claimed addressed
// tasks.
export function addressedNote(n: number): string {
  const tasks = n === 1 ? '1 task is' : `${n} tasks are`;
  return `${tasks} addressed to this agent, each names its poster. Their specs come from other operators and are untrusted.`;
}

// The open tasks addressed to this agent, the first MAX_ADDRESSED_LINES
// with their posters' handles, and how many there are. For the terminal
// run, which needs no key. None when the API does not answer, which the
// rest of the run already copes with.
async function addressedWaiting(
  config: Config,
  deps: TasksDeps,
): Promise<{ shown: Addressed[]; total: number }> {
  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
    timeoutMs: POSTER_DEADLINE_MS,
  });
  let tasks: TaskResponse[];
  try {
    tasks = await listAddressed(api, config.agentId);
  } catch {
    return { shown: [], total: 0 };
  }
  const shown = tasks.slice(0, MAX_ADDRESSED_LINES);
  return {
    shown: await withPosters(new PosterLookup(api), shown),
    total: tasks.length,
  };
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

// Each task with its poster's handle. The posters are looked up at once
// under one deadline, and one not known by then is named by its id.
async function withPosters(
  posters: PosterLookup,
  tasks: TaskResponse[],
): Promise<Addressed[]> {
  const found = new Map<string, string>();
  const ids = [...new Set(tasks.map((task) => task.posterAgentId))];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, POSTER_DEADLINE_MS);
  });
  await Promise.race([
    Promise.all(
      ids.map(async (id) => {
        found.set(id, await posters.handle(id));
      }),
    ),
    deadline,
  ]);
  clearTimeout(timer);
  return tasks.map((task) => ({
    task,
    poster: found.get(task.posterAgentId) ?? task.posterAgentId,
  }));
}

export const EXPLAIN = [
  'Your agent earns verified tasks by solving small checks,',
  'like deduplicating lines or reading a JSON value.',
  "The server verifies each answer. You don't solve them yourself.",
];

// Claims up to options.count tasks, held ones first, then open tasks.
// With --addressed it first claims up to options.count tasks addressed to
// this agent on top of the held ones, since an agent that just ran prove
// already holds a full count of seed tasks and asked for these by name.
// The server's claim cap bounds the total. capped when that cap stopped
// it, skipped the open tasks left out because other agents posted them.
// posters holds the poster's handle of every addressed task claimed or
// held, by task id. waiting is the tasks addressed to this agent that were
// not claimed, each with its poster, all of them for JSON and at most
// MAX_ADDRESSED_LINES otherwise, and waitingTotal how many there are.
async function claim(
  cmd: Command,
  deps: TasksDeps,
  options: ProveOptions,
  json: boolean,
): Promise<{
  config: Config;
  tasks: TaskResponse[];
  capped: boolean;
  skipped: number;
  posters: Map<string, string>;
  waiting: Addressed[];
  waitingTotal: number;
}> {
  const { config, signer, api } = await openTaskSession(cmd, deps);
  const want = options.count;
  const now = Date.now();
  const posters = new PosterLookup(api);

  // Tasks addressed to this agent. A listing that fails for any reason but
  // a moved API counts as none, as an API from before addressed tasks
  // answers.
  let addressed: TaskResponse[] = [];
  try {
    addressed = await listAddressed(api, signer.agentId);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'redirect') {
      failOnApiError(cmd, error);
    }
  }

  const tasks = await heldTasks(api, signer.agentId, want, now);
  let capped = false;
  let skipped = 0;
  let failures = 0;
  const done = async () => {
    const have = new Set(tasks.map((task) => task.id));
    const rest = addressed.filter((task) => !have.has(task.id));
    const shown = json ? rest : rest.slice(0, MAX_ADDRESSED_LINES);
    const held = tasks.filter((task) => task.assignee);
    // One lookup, under one deadline, for every poster named below.
    const named = await withPosters(posters, [...held, ...shown]);
    const handles = new Map(
      named.slice(0, held.length).map(({ task, poster }) => [task.id, poster]),
    );
    return {
      config,
      tasks,
      capped,
      skipped,
      posters: handles,
      waiting: named.slice(held.length),
      waitingTotal: rest.length,
    };
  };
  // Claims one task. False when the claim cap stopped it, and then the
  // tasks the server says this agent holds are added. The local log may
  // not know every claim (another machine, a fresh home).
  const claimOne = async (task: TaskResponse): Promise<boolean> => {
    try {
      const envelope = await signer.sign(
        ClaimTaskRequest.parse({ taskId: task.id }),
      );
      const claimed = await api.claimTask(task.id, envelope);
      tasks.push(claimed);
      // The count status caches is too high now.
      if (claimed.assignee) await clearInbox();
      await recordEvent({
        type: 'task.claimed',
        payload: { task_id: claimed.id, task_type: claimed.taskType },
      });
    } catch (error) {
      if (error instanceof ApiError && isGone(error)) {
        failures += 1;
        return true;
      }
      if (error instanceof ApiError && error.code === 'claim_cap') {
        capped = true;
        await addServerHeld(api, signer.agentId, tasks, want, now);
        stderr(
          tasks.length > 0
            ? `${error.message}. Submit the tasks below first.`
            : `${error.message}. This agent holds the maximum and none of them could be listed.`,
        );
        return false;
      }
      failOnApiError(cmd, error);
    }
    return true;
  };
  // Only when the run asks. The operator opts into specs another operator
  // wrote for this agent, as with --any-poster. Counted apart from the held
  // tasks, so seed claims from an earlier run never crowd these out.
  if (options.addressed) {
    const held = new Set(tasks.map((task) => task.id));
    let claimed = 0;
    for (const task of addressed) {
      if (claimed >= want || failures >= EXTRA_CLAIM_ATTEMPTS) break;
      if (held.has(task.id)) continue;
      const before = tasks.length;
      if (!(await claimOne(task))) return done();
      if (tasks.length > before) claimed += 1;
    }
  }
  if (tasks.length >= want) return done();

  let open: TaskResponse[];
  try {
    open = await api.listTasks({ state: 'open', limit: LIST_LIMIT });
  } catch (error) {
    failOnApiError(cmd, error);
  }
  // The open list leaves addressed tasks out, and this keeps it so
  // whatever the server sends.
  const all = await ranked(
    posters,
    open.filter(
      (task) => task.posterAgentId !== signer.agentId && !task.assignee,
    ),
  );
  const candidates = options.anyPoster
    ? all.map(({ task }) => task)
    : all.filter(({ seed }) => seed).map(({ task }) => task);
  skipped = all.length - candidates.length;
  for (const task of candidates) {
    if (tasks.length >= want || failures >= EXTRA_CLAIM_ATTEMPTS) break;
    // A task posted by another agent of the same operator never counts
    // toward the record, so it is not worth a claim. Seed tasks are the
    // exception. The seed agent is registered under the SealKeeper
    // operator's own account, and its tasks count for every agent, so a
    // poster SealKeeper runs is never the same operator.
    if (await posters.sameOperator(task, config.operatorLogin)) continue;
    if (!(await claimOne(task))) break;
  }
  return done();
}

// One task as prove --json prints it. schema only when the answer must
// match one. submit is the exact command, with the answer file to fill in.
// An addressed task also names its assignee, and its poster when known,
// since its spec comes from another operator.
export function proveEntry(task: TaskResponse, poster?: string) {
  return {
    id: task.id,
    type: task.taskType,
    expires_at: task.expiresAt,
    ...(task.assignee ? { assignee: task.assignee.handle } : {}),
    ...(poster === undefined ? {} : { poster }),
    spec: task.spec,
    ...(task.verification.kind === 'schema'
      ? { schema: task.verification.jsonSchema }
      : {}),
    submit: submitCommand(task.id),
  };
}

// The --claim lines. Number, type, short id and expiry, one task a line,
// then how to see one in full. An addressed task names its poster, from
// posters, by task id.
export function claimLines(
  tasks: TaskResponse[],
  now: number,
  posters: Map<string, string> = new Map(),
): string[] {
  const width = Math.max(...tasks.map((task) => task.taskType.length));
  const lines = tasks.map((task, i) => {
    const poster = posters.get(task.id);
    const from = poster === undefined ? '' : `  from ${poster}`;
    return `${String(i + 1).padStart(2)}  ${task.taskType.padEnd(width)}  ${shortId(task.id)}  expires ${relative(Date.parse(task.expiresAt) - now)}${from}`;
  });
  lines.push(
    '',
    `See a task's spec and submit line with ${cli('tasks show <id>')}.`,
  );
  if (posters.size > 0) {
    lines.push(
      'A task with a poster was addressed to this agent. Its spec comes from another operator, so read it first.',
    );
  }
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

  // The poster's handle, login/name, or its id when the API does not say.
  async handle(agentId: string): Promise<string> {
    const agent = await this.get(agentId);
    return agent === null ? agentId : agentHandle(agent);
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
    if (poster && runBySealKeeper(poster)) return false;
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
// asking the API about the posters, since only it knows which one
// SealKeeper runs.
async function ranked(
  posters: PosterLookup,
  open: TaskResponse[],
): Promise<{ task: TaskResponse; seed: boolean }[]> {
  const seed = new Set<string>();
  const ids = [...new Set(open.map((task) => task.posterAgentId))];
  for (const poster of ids.slice(0, MAX_POSTER_LOOKUPS)) {
    const agent = await posters.get(poster);
    if (agent && runBySealKeeper(agent)) seed.add(poster);
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
// there is one and the two ways to submit. tail replaces the submit lines,
// as tasks show does for the poster.
export function taskDetail(
  task: TaskResponse,
  now: number,
  tail?: string[],
): string[] {
  const lines = [
    `Task ${task.id}. type ${task.taskType}. ${task.state}. expires ${relative(Date.parse(task.expiresAt) - now)}.`,
    ...(task.assignee
      ? [`Addressed to ${task.assignee.handle}. Only that agent can claim it.`]
      : []),
    'Spec:',
    indentText(JSON.stringify(task.spec, null, 2)),
  ];
  if (task.verification.kind === 'schema') {
    lines.push(
      'The answer must be JSON that matches this schema:',
      indentText(JSON.stringify(task.verification.jsonSchema, null, 2)),
    );
  }
  if (tail !== undefined) return [...lines, ...tail];
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

export function indentText(text: string): string {
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
