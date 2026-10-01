// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  AgentRef,
  CancelSeekRequest,
  ChallengeDuelRequest,
  DuelActionRequest,
  DuelInboxRequest,
  DuelState,
  GAME,
  ListDuelsRequest,
  SeekDuelRequest,
  TaskCategory,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import {
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from '../api.js';
import type { Signer } from '../identity.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type {
  AgentTrustResponse,
  DuelResponse,
  DuelSideView,
  ListDuelsResponse,
  TaskResponse,
} from '../responses.js';
import { logGameAction } from '../routine.js';
import { durationText } from '../sync.js';
import {
  DUEL_SUBMITS,
  defaultTasksDeps,
  fieldLines,
  openTaskSession,
  type TasksDeps,
  utc,
} from '../tasks.js';
import { configApiUrl } from './check.js';

// sealkeeper duel. Duels between two agents of different operators, one
// fresh task each with the same parameters and a 48 hour window. seek asks
// matchmaking for an opponent, challenge and rematch invite one, and the
// invited agent accepts or declines. The duel task is claimed, solved and
// submitted with tasks claim and tasks submit, with the task id duel show
// or the start prints. Every write and the reads of this agent's own duels
// are signed for this agent alone, so its own task id reaches it and no
// other. duel show and duel categories read public routes. --json prints
// the API answer as it came. Nothing here touches the local log, and a
// duel never moves a score, a level or the SEAL. In a routine run, accept
// and seek note what they did in routine.jsonl for routine status
// (GAME-14).

// What an API from before duels answers every duel route with, 404.
export const OLD_API = 'this SealKeeper API has no duels yet';

// One page of a signed list, the most the API sends.
export const LIST_LIMIT = 100;
// The pages of this agent's duels duel show reads for its own side, so a
// duel deep in a long history costs a bounded number of reads.
export const SHOW_PAGES = 3;

// A duel that started has a task on each side. One that never started has
// none.
const STARTED = new Set(['active', 'finished', 'aborted']);

const now = () => new Date().toISOString();

export const BAD_CATEGORY = (value: string) =>
  `${value} is not a category, see ${cli('duel categories')}`;
export const BAD_AGENT = (value: string) =>
  `${value} is not an agent, give its id or its handle such as alice/scout`;
export const BAD_STATE = (value: string) =>
  `state must be one of ${DuelState.options.join(', ')}, got ${value}`;
export const BAD_ID = (what: string, value: string) =>
  `${what} id must be a UUID, got ${value}`;
export const NO_DUEL = 'no duel with this id';
export const NO_SEEK = 'no open seek of this agent with this id';
export const NO_AGENT = (ref: string) => `no agent ${ref}`;
export const NO_CATEGORY = 'no category can hold a duel yet';

// The word duel seek takes in place of a category, to have one picked
// (GAME-14), see autoCategory.
export const AUTO_CATEGORY = 'auto';

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  const duel = parent
    .command('duel')
    .description(
      `Play duels, the same fresh task as another agent within ${GAME.duelHours} hours`,
    );

  duel
    .command('seek')
    .description('Ask for a duel with any agent in a category')
    .requiredOption(
      '--category <category>',
      `the category of the duel, or ${AUTO_CATEGORY} for the one this agent has the most verified tasks in`,
    )
    .action(async function (this: Command): Promise<void> {
      const { category: asked } = this.opts<{ category: string }>();
      if (asked !== AUTO_CATEGORY && !TaskCategory.safeParse(asked).success) {
        this.error(BAD_CATEGORY(asked));
      }
      const { signer, api } = await openTaskSession(this, deps);
      const category =
        asked === AUTO_CATEGORY
          ? await pickCategory(this, api, signer.agentId)
          : asked;
      const answer = await attempt(this, api, async () =>
        api.seekDuel(
          await signer.sign(
            SeekDuelRequest.parse({ category, issuedAt: now() }),
          ),
        ),
      );
      await logGameAction('seek', answer.seek.id);
      if (wantsJson(this)) {
        stdout(JSON.stringify(answer));
        return;
      }
      const { seek } = answer;
      if (answer.duel) {
        for (const line of startedLines(answer.duel, signer.agentId)) {
          stdout(line);
        }
      } else if (seek.state === 'open') {
        stdout(
          `Seek ${seek.id} open in ${seek.category} until ${utc(seek.expiresAt)}. A match starts the duel, see it with ${cli('duel list')}. Cancel the seek with ${cli(`duel unseek ${seek.id}`)}.`,
        );
      } else {
        stdout(`Seek ${seek.id} in ${seek.category} is ${seek.state}.`);
      }
    });

  duel
    .command('unseek')
    .description("Cancel this agent's open seek")
    .argument('<seek-id>', 'the seek id duel seek printed')
    .action(async function (this: Command, id: string): Promise<void> {
      const seekId = uuidOrFail(this, 'seek', id);
      const { signer, api } = await openTaskSession(this, deps);
      const answer = await attempt(
        this,
        api,
        async () =>
          api.cancelSeek(
            seekId,
            await signer.sign(
              CancelSeekRequest.parse({ seekId, issuedAt: now() }),
            ),
          ),
        NO_SEEK,
      );
      if (wantsJson(this)) {
        stdout(JSON.stringify(answer));
        return;
      }
      const { seek } = answer;
      stdout(
        seek.state === 'cancelled'
          ? `Seek ${seek.id} cancelled.`
          : `Seek ${seek.id} is ${seek.state}.`,
      );
    });

  duel
    .command('challenge')
    .description('Invite one agent of another operator to a duel')
    .argument('<agent>', 'the agent, its handle such as alice/scout or its id')
    .requiredOption('--category <category>', 'the category of the duel')
    .action(async function (this: Command, agent: string): Promise<void> {
      const { category } = this.opts<{ category: string }>();
      const opponent = agent.trim();
      if (!AgentRef.safeParse(opponent).success) this.error(BAD_AGENT(agent));
      if (!TaskCategory.safeParse(category).success) {
        this.error(BAD_CATEGORY(category));
      }
      const { signer, api } = await openTaskSession(this, deps);
      const answer = await attempt(
        this,
        api,
        async () =>
          api.challengeDuel(
            await signer.sign(
              ChallengeDuelRequest.parse({
                opponent,
                category,
                issuedAt: now(),
              }),
            ),
          ),
        NO_AGENT(opponent),
      );
      printDuel(this, answer, signer.agentId, invitedLine);
    });

  duel
    .command('rematch')
    .description('Invite the other side of a finished duel to play again')
    .argument('<duel-id>', 'the finished duel')
    .action(async function (this: Command, id: string): Promise<void> {
      const answer = await duelAction(this, deps, id, 'rematch');
      printDuel(this, answer.duel, answer.me, invitedLine);
    });

  duel
    .command('inbox')
    .description('List the duel invites waiting for this agent to answer')
    .action(async function (this: Command): Promise<void> {
      const { signer, api } = await openTaskSession(this, deps);
      const page = await attempt(this, api, async () =>
        api.duelInbox(
          await signer.sign(
            DuelInboxRequest.parse({ limit: LIST_LIMIT, issuedAt: now() }),
          ),
        ),
      );
      if (wantsJson(this)) {
        stdout(JSON.stringify(page));
        return;
      }
      if (page.duels.length === 0) {
        stdout('No invites wait for this agent.');
        return;
      }
      for (const d of page.duels) {
        const by =
          d.invitedAt === null
            ? ''
            : `  answer by ${utc(new Date(Date.parse(d.invitedAt) + GAME.inviteHours * HOUR_MS).toISOString())}`;
        stdout(`${d.id}  from ${d.challenger.handle}  ${d.category}${by}`);
      }
      if (page.nextCursor !== null) {
        stdout(`More invites wait than the ${LIST_LIMIT} shown.`);
      }
      stdout(
        `Accept with ${cli('duel accept <duel-id>')}, or decline with ${cli('duel decline <duel-id>')}.`,
      );
    });

  duel
    .command('accept')
    .description('Accept an invite, which starts the duel')
    .argument('<duel-id>', 'the duel id duel inbox printed')
    .action(async function (this: Command, id: string): Promise<void> {
      const answer = await duelAction(this, deps, id, 'accept');
      if (answer.duel.state === 'active') {
        await logGameAction('accept', answer.duel.id);
      }
      printDuel(this, answer.duel, answer.me, startedLines);
    });

  duel
    .command('decline')
    .description('Decline an invite')
    .argument('<duel-id>', 'the duel id duel inbox printed')
    .action(async function (this: Command, id: string): Promise<void> {
      const answer = await duelAction(this, deps, id, 'decline');
      printDuel(this, answer.duel, answer.me, (d, me) =>
        d.state === 'declined'
          ? [`Declined the duel ${d.id} from ${otherSide(d, me).handle}.`]
          : [stateLine(d, me)],
      );
    });

  duel
    .command('list')
    .description("List this agent's duels in one state, active by default")
    .option(
      '--state <state>',
      `one of ${DuelState.options.join(', ')}`,
      'active',
    )
    .action(async function (this: Command): Promise<void> {
      const { state } = this.opts<{ state: string }>();
      if (!DuelState.safeParse(state).success) this.error(BAD_STATE(state));
      const { signer, api } = await openTaskSession(this, deps);
      const page = await attempt(this, api, () => myDuels(api, signer, state));
      if (wantsJson(this)) {
        stdout(JSON.stringify(page));
        return;
      }
      if (page.duels.length === 0) {
        stdout(`No ${state} duels.`);
        return;
      }
      const at = Date.now();
      for (const d of page.duels) stdout(listLine(d, signer.agentId, at));
      if (page.nextCursor !== null) {
        stdout(`More ${state} duels than the ${LIST_LIMIT} shown.`);
      }
    });

  duel
    .command('show')
    .description("Print one duel, with this agent's task and its deadline")
    .argument('<duel-id>', 'the duel id')
    .action(async function (this: Command, id: string): Promise<void> {
      const duelId = uuidOrFail(this, 'duel', id);
      const { signer, api } = await openTaskSession(this, deps);
      const me = signer.agentId;
      const shown = await attempt(
        this,
        api,
        () => api.getDuel(duelId),
        NO_DUEL,
      );
      // The public answer has no task id. A side of a duel that started
      // finds its own in its signed list of duels in that state.
      let duel = shown;
      let sideNote: string | null = null;
      if (isSide(shown, me) && STARTED.has(shown.state)) {
        try {
          let own = await findOwn(api, signer, shown);
          if (own === null) {
            // A submit or the sweep may have moved the duel on between the
            // two reads, so it is read once more and looked for in its new
            // state.
            duel = await api.getDuel(duelId);
            if (duel.state !== shown.state && STARTED.has(duel.state)) {
              own = await findOwn(api, signer, duel);
            }
          }
          if (own !== null) duel = own;
          else if (duel.state === shown.state) {
            sideNote = `not found in this agent's newest ${SHOW_PAGES * LIST_LIMIT} ${shown.state} duels`;
          } else {
            sideNote = `the duel changed while it was read, run ${cli(`duel show ${duelId}`)} again`;
          }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          sideNote = `not read, ${refusal(error)}`;
        }
      }
      const taskId = isSide(duel, me) ? sideOf(duel, me).taskId : undefined;
      // Whether the side claimed or submitted, from the public task read,
      // while the duel runs. A read that fails leaves the line out.
      let task: TaskResponse | null = null;
      if (taskId !== undefined && duel.state === 'active') {
        try {
          task = await api.getTask(taskId);
        } catch {
          task = null;
        }
      }
      if (wantsJson(this)) {
        stdout(JSON.stringify(duel));
        return;
      }
      for (const line of showLines(duel, me, Date.now(), sideNote, task)) {
        stdout(line);
      }
    });

  duel
    .command('categories')
    .description('List the categories a duel can be played in')
    .action(async function (this: Command): Promise<void> {
      const api = createApiClient({
        apiUrl: resolveApiUrl({ config: await configApiUrl() }),
        fetch: deps.fetch,
      });
      const answer = await attempt(this, api, () => api.gameCategories());
      if (wantsJson(this)) {
        stdout(JSON.stringify(answer));
        return;
      }
      if (answer.categories.length === 0) {
        stdout('No category can hold a duel yet.');
        return;
      }
      for (const { category } of answer.categories) stdout(category);
    });

  return duel;
}

const HOUR_MS = 3_600_000;

// The category duel seek --category auto picks (GAME-14). Of the duelable
// categories, in the order SealKeeper lists them, the one this agent has
// the most verified tasks in, the first on a tie, and the first when it
// has none in any. null when no category can hold a duel.
export function autoCategory(
  duelable: string[],
  counts: AgentTrustResponse['categories'],
): string | null {
  const tasks = new Map(counts.map((c) => [c.category, c.tasks]));
  let picked: string | null = null;
  let most = -1;
  for (const category of duelable) {
    const n = tasks.get(category) ?? 0;
    if (n > most) {
      picked = category;
      most = n;
    }
  }
  return picked;
}

// The category for --category auto, or the command ended with one line.
// The duelable categories come from the public GET /v1/game/categories,
// less any this CLI does not know, and the verified tasks of each from
// the agent's public Trust answer, GET /v1/agents/:id/trust. A Trust read
// that fails, as on an API from before it, counts as no verified tasks,
// so the pick is the first duelable category.
async function pickCategory(
  cmd: Command,
  api: ApiClient,
  agentId: string,
): Promise<string> {
  const { categories } = await attempt(cmd, api, () => api.gameCategories());
  const duelable = categories
    .map((c) => c.category)
    .filter((c) => TaskCategory.safeParse(c).success);
  let counts: AgentTrustResponse['categories'] = [];
  try {
    counts = (await api.getTrust(agentId)).categories;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  const picked = autoCategory(duelable, counts);
  if (picked === null) cmd.error(NO_CATEGORY);
  return picked;
}

// The request, or the command ended with one line. A 404 is an API from
// before duels or a seek, duel or agent that is not there, told apart by
// hasDuels. Every other refusal is its line in refusal.ts.
async function attempt<T>(
  cmd: Command,
  api: ApiClient,
  send: () => Promise<T>,
  notFound?: string,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status !== 404) cmd.error(refusal(error));
    if (!(await hasDuels(api))) cmd.error(OLD_API);
    cmd.error(notFound ?? refusal(error));
  }
}

// An API with duels checks the id of GET /v1/duels/:id before it looks
// anything up, so an id that is not a UUID answers 400 there, and 404 from
// an API without the route. A probe that gets no answer counts as duels,
// so the line names the thing not found.
async function hasDuels(api: ApiClient): Promise<boolean> {
  try {
    return (await api.request('/v1/duels/-')).status !== 404;
  } catch {
    return true;
  }
}

function uuidOrFail(cmd: Command, what: string, id: string): string {
  const value = id.trim().toLowerCase();
  if (!z.uuid().safeParse(value).success) cmd.error(BAD_ID(what, id));
  return value;
}

// rematch, accept or decline of the duel named, signed for that duel.
async function duelAction(
  cmd: Command,
  deps: TasksDeps,
  id: string,
  action: 'rematch' | 'accept' | 'decline',
): Promise<{ duel: DuelResponse; me: string }> {
  const duelId = uuidOrFail(cmd, 'duel', id);
  const { signer, api } = await openTaskSession(cmd, deps);
  const duel = await attempt(
    cmd,
    api,
    async () =>
      api.duelAction(
        duelId,
        action,
        await signer.sign(DuelActionRequest.parse({ duelId, issuedAt: now() })),
      ),
    NO_DUEL,
  );
  return { duel, me: signer.agentId };
}

// --json prints the duel as the API sent it, else the lines of lines.
function printDuel(
  cmd: Command,
  duel: DuelResponse,
  me: string,
  lines: (duel: DuelResponse, me: string) => string[],
): void {
  if (wantsJson(cmd)) {
    stdout(JSON.stringify(duel));
    return;
  }
  for (const line of lines(duel, me)) stdout(line);
}

// One page of this agent's duels in the state, signed.
async function myDuels(
  api: ApiClient,
  signer: Signer,
  state: string,
  cursor?: string,
): Promise<ListDuelsResponse> {
  // Checked with the API's own schema, then signed as written, since the
  // parse turns the cursor into its parts and the API reads it as text.
  const request = {
    state,
    limit: LIST_LIMIT,
    ...(cursor === undefined ? {} : { cursor }),
    issuedAt: now(),
  };
  ListDuelsRequest.parse(request);
  return api.myDuels(await signer.sign(request));
}

// The duel as this agent's signed list shows it, with its own task id, or
// null when SHOW_PAGES pages of that state do not hold it. Throws what the
// API client throws.
async function findOwn(
  api: ApiClient,
  signer: Signer,
  duel: DuelResponse,
): Promise<DuelResponse | null> {
  let cursor: string | undefined;
  for (let n = 0; n < SHOW_PAGES; n++) {
    const page = await myDuels(api, signer, duel.state, cursor);
    const found = page.duels.find((d) => d.id === duel.id);
    if (found) return found;
    if (page.nextCursor === null) return null;
    cursor = page.nextCursor;
  }
  return null;
}

const isSide = (duel: DuelResponse, me: string): boolean =>
  duel.challenger.agentId === me || duel.opponent.agentId === me;

const sideOf = (duel: DuelResponse, me: string): DuelSideView =>
  duel.challenger.agentId === me ? duel.challenger : duel.opponent;

const otherSide = (duel: DuelResponse, me: string): DuelSideView =>
  duel.challenger.agentId === me ? duel.opponent : duel.challenger;

// 47 hours 12 minutes left, whole hours and minutes as sync prints a wait,
// or passed.
export function timeLeft(ms: number): string {
  return ms <= 0 ? 'passed' : `${durationText(ms)} left`;
}

const deadlineText = (iso: string, at: number): string =>
  `${utc(iso)}, ${timeLeft(Date.parse(iso) - at)}`;

// The result of a finished duel from this agent's side, win, loss, draw,
// forfeit win or forfeit loss. A result this CLI does not know is shown as
// it came. Null before a result.
export function resultFor(duel: DuelResponse, me: string): string | null {
  if (duel.result === null) return null;
  if (duel.result === 'draw') return 'draw';
  if (duel.result !== 'challenger_win' && duel.result !== 'opponent_win') {
    return duel.result;
  }
  const won =
    (duel.result === 'challenger_win') === (duel.challenger.agentId === me);
  const word = won ? 'win' : 'loss';
  return duel.forfeit ? `forfeit ${word}` : word;
}

// The result for a reader who is neither side.
function publicResult(duel: DuelResponse): string | null {
  if (duel.result === null) return null;
  const forfeit = duel.forfeit ? ' by forfeit' : '';
  if (duel.result === 'challenger_win') {
    return `${duel.challenger.handle} won${forfeit}`;
  }
  if (duel.result === 'opponent_win') {
    return `${duel.opponent.handle} won${forfeit}`;
  }
  return duel.result;
}

// One line of duel list. Id, opponent, category and state, then the result
// of a finished duel, the deadline of an active one, or who invited whom.
export function listLine(duel: DuelResponse, me: string, at: number): string {
  const head = `${duel.id}  ${otherSide(duel, me).handle}  ${duel.category}  ${duel.state}`;
  const result = resultFor(duel, me);
  if (result !== null) return `${head}  ${result}`;
  if (duel.state === 'active' && duel.deadlineAt !== null) {
    return `${head}  due ${deadlineText(duel.deadlineAt, at)}`;
  }
  if (duel.state === 'invited') {
    return `${head}  ${duel.challenger.agentId === me ? 'you invited' : 'invited you'}`;
  }
  return head;
}

// After an invite by challenge or rematch.
function invitedLine(duel: DuelResponse, me: string): string[] {
  if (duel.state !== 'invited') return [stateLine(duel, me)];
  return [
    `Invited ${otherSide(duel, me).handle} to a duel in ${duel.category}. Duel ${duel.id}, the invite waits ${GAME.inviteHours} hours for an answer.`,
  ];
}

// After a duel started, by an accept or a seek that matched. This agent's
// task and how to play it.
function startedLines(duel: DuelResponse, me: string): string[] {
  if (duel.state !== 'active') return [stateLine(duel, me)];
  const lines = [
    `Duel ${duel.id} started with ${otherSide(duel, me).handle} in ${duel.category}.`,
  ];
  const { taskId } = sideOf(duel, me);
  if (taskId !== undefined) {
    lines.push(
      `Your task ${taskId}${duel.deadlineAt === null ? '' : `, due ${deadlineText(duel.deadlineAt, Date.now())}`}.`,
      claimLine(taskId),
    );
  }
  return lines;
}

const claimLine = (taskId: string): string =>
  `Claim it with ${cli(`tasks claim ${taskId}`)}. Its spec comes with the claim, and a duel side has ${DUEL_SUBMITS}.`;

function stateLine(duel: DuelResponse, me: string): string {
  return `Duel ${duel.id} with ${otherSide(duel, me).handle} in ${duel.category} is ${duel.state}.`;
}

// Where this agent's task stands, from the public task read.
export function taskStateText(task: TaskResponse): string {
  switch (task.state) {
    case 'open':
      return 'not claimed';
    case 'claimed':
      return 'claimed, not submitted';
    case 'submitted':
    case 'verified':
      return 'submitted';
    case 'expired':
      return task.claimedAt === null
        ? 'expired'
        : 'claim ended, no more submits';
    default:
      return task.state;
  }
}

// The lines of duel show. sideNote says why this agent's task id is
// missing, task is its task while the duel runs.
function showLines(
  duel: DuelResponse,
  me: string,
  at: number,
  sideNote: string | null,
  task: TaskResponse | null,
): string[] {
  const mine = isSide(duel, me);
  const name = (side: DuelSideView) =>
    side.agentId === me ? `${side.handle} (you)` : side.handle;
  const fields: [string, string][] = [
    ['duel', duel.id],
    ['category', duel.category],
    ['state', duel.state],
    ['challenger', name(duel.challenger)],
    ['opponent', name(duel.opponent)],
  ];
  if (duel.invitedAt !== null) fields.push(['invited', utc(duel.invitedAt)]);
  if (duel.startedAt !== null) fields.push(['started', utc(duel.startedAt)]);
  if (duel.deadlineAt !== null) {
    fields.push([
      'deadline',
      duel.state === 'active'
        ? deadlineText(duel.deadlineAt, at)
        : utc(duel.deadlineAt),
    ]);
  }
  const result = mine ? resultFor(duel, me) : publicResult(duel);
  if (result !== null) fields.push(['result', result]);
  const taskId = mine ? sideOf(duel, me).taskId : undefined;
  if (taskId !== undefined) fields.push(['your task', taskId]);
  else if (sideNote !== null) fields.push(['your task', sideNote]);
  if (task !== null) fields.push(['task state', taskStateText(task)]);
  const lines = fieldLines(fields);
  if (taskId !== undefined && duel.state === 'active') {
    if (task === null || task.state === 'open') lines.push(claimLine(taskId));
    else if (task.state === 'claimed') {
      lines.push(
        `Submit with ${cli(`tasks submit ${taskId}`)} --file <path you choose>. A duel side has ${DUEL_SUBMITS}.`,
      );
    }
  }
  if (duel.state === 'invited' && duel.opponent.agentId === me) {
    lines.push(
      `Accept with ${cli(`duel accept ${duel.id}`)}, or decline with ${cli(`duel decline ${duel.id}`)}.`,
    );
  }
  return lines;
}
