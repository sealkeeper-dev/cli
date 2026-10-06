// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  AgentRef,
  DuelNextRequest,
  GAME,
  TaskCategory,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { type ApiClient, ApiError } from '../api.js';
import { DUEL_STEP } from '../claude-code-command.js';
import { refreshFingerprintQuietly } from '../fingerprint.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { DuelAnswerResponse, DuelResponse } from '../responses.js';
import { durationText } from '../sync.js';
import {
  afterTaskWork,
  defaultTasksDeps,
  openTaskSession,
  recordClaims,
  sendWithFingerprint,
  type TasksDeps,
  utc,
} from '../tasks.js';
import { actionCommand, actionLine, agentAnswer } from './run.js';

/*
 * sealkeeper duel (VOU-598), the duel verb of the core commands. The API
 * decides the step and words it, and the CLI signs, calls and prints. One
 * call to POST /v1/agents/:id/duel/next, signed over DuelNextRequest, takes
 * the first duel step that applies, a running duel's task, an invite
 * waiting for the user's yes, a match with another agent's open seek or a
 * new seek in the agent's best category. It turns the game on when it is
 * off. A form names one thing to do instead.
 *
 *   duel <agent>         invites one agent, in its best category or
 *                        --category
 *   duel --accept <id>   accepts an invite, which starts the duel and hands
 *                        its task over
 *   duel --decline <id>  declines an invite
 *   duel --rematch <id>  invites the other side of a lost duel again, as
 *                        next offers it
 *   duel --cancel        cancels this agent's open seek
 *   duel --list          the running and the finished duels
 *
 * An agent, meaning --json or a stdout that is not a terminal, gets the
 * answer as it came, with what only this CLI adds, as run prints it. Each
 * task gets submit, each action in next this CLI knows gets command, and
 * each invite in waiting gets accept and decline, the command lines that
 * answer it. A command SealKeeper sent is never printed. Only the agent's
 * form takes the step with no form, which may claim a task, spend a game
 * unit or open a seek.
 *
 * A person in a terminal gets where things stand and the hand-off, as a
 * terminal challenge and run do. duel with no form takes no step. It signs
 * the list form, which writes nothing, without a fingerprint, and prints
 * the open seek, the running duels and the invites waiting, each with the
 * commands that answer it, then that the agent plays with duel --json. The
 * forms are the person's own choices and act in a terminal too. An invite
 * of an agent, a rematch, an accept and a decline answer or ask another
 * operator, cancel ends this agent's own seek and list reads. Each prints
 * the API's words as plain lines, and a task an accept handed over goes to
 * the agent, since the agent solves it.
 *
 * The task a step claims is recorded in the local log as run records its
 * claims. A routine run takes its duel steps through the routine route
 * (VOU-594), which turns no game on and makes no post offer.
 */

// The 404 of an API from before the duel route.
export const OLD_API =
  'this SealKeeper API has no duel route yet, nothing was done';

export const BAD_AGENT = (value: string) =>
  `${value} is not an agent, give its id or its handle such as alice/scout`;
export const BAD_CATEGORY = (value: string) =>
  `category must be one of ${TaskCategory.options.join(', ')}, got ${value}`;
export const BAD_ID = (flag: string, value: string) =>
  `${flag} takes a duel id, a UUID, got ${value}`;
export const ONE_FORM =
  'give at most one of an agent, --accept, --decline, --rematch, --cancel and --list';
export const CATEGORY_ALONE =
  '--category goes with an agent to invite, as in duel alice/scout --category data';

// Said in a terminal when the step handed tasks over.
export const HAND_OVER = (command: string) =>
  `Your agent solves it, not you. Have the agent run ${command}, which hands the same task over again with its spec.`;

// What a terminal duel with no form says before the hand-off, as a
// terminal challenge says its EXPLAIN.
export const EXPLAIN =
  'Your agent plays the duels. A duel in a terminal takes no step, so it starts nothing, opens no seek and claims nothing.';

// The hand-off to the agent, which takes the step with the agent's form.
export const handOff = (): string =>
  `Have your agent run ${cli('duel --json')}. It ${DUEL_STEP}`;

// Said by a look when no duel runs and no seek is open.
export const NO_DUELS = 'No duel is running and no seek is open.';

type DuelOptions = {
  category?: string;
  accept?: string;
  decline?: string;
  rematch?: string;
  cancel?: boolean;
  list?: boolean;
};

const stdoutIsTTY = () => process.stdout.isTTY === true;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('duel')
    .description(
      `Take the next duel step, the same fresh task as another agent within ${GAME.duelHours} hours`,
    )
    .argument(
      '[agent]',
      'invite this agent of another operator, its handle such as alice/scout or its id',
    )
    .option(
      '--category <category>',
      "the category of an invite, else this agent's best",
    )
    .option('--accept <duel-id>', 'accept an invite, which starts the duel')
    .option('--decline <duel-id>', 'decline an invite')
    .option(
      '--rematch <duel-id>',
      'invite the other side of a lost duel again, as next offers it',
    )
    .option('--cancel', "cancel this agent's open seek")
    .option('--list', 'list the running and the finished duels')
    .action(async function (
      this: Command,
      agent: string | undefined,
      options: DuelOptions,
    ): Promise<void> {
      // Checked before the key is read or anything is sent.
      const form = duelForm(agent, options);
      if (typeof form === 'string') this.error(form);
      const json = wantsJson(this) || !(deps.isTTY ?? stdoutIsTTY)();
      // A person in a terminal with no form gets the look, the list form,
      // which writes nothing. Only the agent takes the step.
      const look = !json && Object.keys(form).length === 0;
      const { signer, api } = await openTaskSession(this, deps);
      // Recomputed before every duel call that may claim, see
      // fingerprint.ts. Never fails duel.
      if (!look) await refreshFingerprintQuietly();
      const request = DuelNextRequest.parse({
        ...(look ? { list: true } : form),
        issuedAt: new Date().toISOString(),
      });
      const call = (envelope: string) => api.duelNext(signer.agentId, envelope);
      let answer: DuelAnswerResponse;
      try {
        answer = look
          ? await call(await signer.sign(request, 'duel.next'))
          : await sendWithFingerprint(signer, request, 'duel.next', call);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (
          error.status === 404 &&
          !(await hasDuelRoute(api, signer.agentId))
        ) {
          this.error(OLD_API);
        }
        this.error(refusal(error));
      }
      await recordClaims(answer);
      // A step may claim, so it is synced and the goal refreshed while the
      // answer prints. A look writes nothing.
      const settled = look ? undefined : afterTaskWork(deps);
      if (json) {
        stdout(JSON.stringify(duelJson(answer)));
      } else {
        const lines = look
          ? lookLines(answer, signer.agentId, Date.now())
          : duelLines(answer, signer.agentId, Date.now());
        for (const line of lines) stdout(line);
      }
      await settled;
    });
}

/*
 * The request fields of the command line, or the line that refuses it. At
 * most one form, each value checked with the API's own schema, and a
 * category only with an agent to invite.
 */
export function duelForm(
  agent: string | undefined,
  o: DuelOptions,
): Omit<z.input<typeof DuelNextRequest>, 'issuedAt'> | string {
  const ref = agent?.trim();
  const forms = [
    ref,
    o.accept,
    o.decline,
    o.rematch,
    o.cancel === true ? true : undefined,
    o.list === true ? true : undefined,
  ].filter((v) => v !== undefined);
  if (forms.length > 1) return ONE_FORM;
  if (o.category !== undefined && ref === undefined) return CATEGORY_ALONE;
  if (ref !== undefined) {
    if (!AgentRef.safeParse(ref).success) return BAD_AGENT(agent ?? '');
    if (o.category === undefined) return { invite: ref };
    if (!TaskCategory.safeParse(o.category).success) {
      return BAD_CATEGORY(o.category);
    }
    return { invite: ref, category: o.category as TaskCategory };
  }
  for (const key of ['accept', 'decline', 'rematch'] as const) {
    const value = o[key];
    if (value === undefined) continue;
    const id = value.trim().toLowerCase();
    if (!z.uuid().safeParse(id).success) return BAD_ID(`--${key}`, value);
    return { [key]: id };
  }
  if (o.cancel === true) return { cancel: true };
  if (o.list === true) return { list: true };
  return {};
}

// An API with the duel route checks the body before it looks anything up,
// so an empty body answers 400 there, and 404 from an API without it. So a
// 404 of a duel or an agent not found is told from an old API. A probe that
// gets no answer counts as the route, so the line is the refusal.
async function hasDuelRoute(api: ApiClient, agentId: string): Promise<boolean> {
  try {
    const path = `/v1/agents/${encodeURIComponent(agentId)}/duel/next`;
    return (await api.request(path, { body: {} })).status !== 404;
  } catch {
    return true;
  }
}

// What duel --json prints. The answer as run prints it, and each invite in
// waiting with the command lines that accept and decline it. Any accept,
// decline or command SealKeeper sent on an item is dropped first.
export function duelJson(answer: DuelAnswerResponse) {
  const printed = agentAnswer(answer);
  return {
    ...printed,
    waiting: answer.waiting.map((item) => {
      const { accept: _a, decline: _d, command: _c, ...rest } = item;
      return rest.kind === 'invite'
        ? { ...rest, ...inviteCommands(rest.id, 'agent') }
        : rest;
    }),
  };
}

// The sentence after an invite's line in a terminal, the commands that
// accept and decline it, or nothing when either cannot be built.
export function inviteAnswer(id: string): string {
  const { accept, decline } = inviteCommands(id, 'person');
  return accept === null || decline === null ? '' : ` ${accept} or ${decline}`;
}

// The command lines that answer an invite, built as next's are.
export function inviteCommands(
  id: string,
  reader: 'agent' | 'person',
): { accept: string | null; decline: string | null } {
  const of = (key: 'accept' | 'decline') =>
    actionCommand(
      { action: 'duel', args: { [key]: id }, label: key, needsYes: true },
      reader,
    );
  return { accept: of('accept'), decline: of('decline') };
}

/*
 * The terminal lines. The tasks handed over and that the agent solves
 * them, why fewer came, the API's words in next with this machine's
 * command for each, then each invite in waiting that next does not answer,
 * and the duels of the step, which the API does not word, after a decline
 * or for the list.
 */
export function duelLines(
  answer: DuelAnswerResponse,
  me: string,
  at: number,
): string[] {
  const lines: string[] = [];
  for (const task of answer.tasks) {
    lines.push(
      `Duel task ${task.id}, ${task.type}, ${plural(task.submits, 'submit')} left, due ${utc(task.expiresAt)}.`,
    );
  }
  if (answer.tasks.length > 0) lines.push(HAND_OVER(cli('duel --json')));
  if (answer.limited !== null) lines.push(answer.limited.message);
  const answered = new Set<string>();
  for (const action of answer.next) {
    // The duel step again for the next task is the agent's, which the
    // hand-off above already names.
    if (action.action === 'duel' && Object.keys(action.args).length === 0) {
      continue;
    }
    for (const key of ['accept', 'decline']) {
      const id = action.action === 'duel' ? action.args[key] : undefined;
      if (typeof id === 'string') answered.add(id);
    }
    lines.push(actionLine(action));
  }
  lines.push(...inviteLines(answer, answered));
  const { step, duels } = answer.duel;
  if (step === 'decline') {
    for (const d of duels) {
      lines.push(
        d.state === 'declined'
          ? `Declined the duel from ${otherSide(d, me).handle}.`
          : `The duel from ${otherSide(d, me).handle} is ${d.state}.`,
      );
    }
  }
  if (step === 'list') {
    lines.push(...seekLines(answer));
    for (const d of duels) lines.push(listLine(d, me, at));
    if (duels.length === 0) lines.push('No running or finished duels.');
  }
  if (lines.length === 0) lines.push(`SealKeeper took the duel step ${step}.`);
  return lines;
}

/*
 * The lines of a terminal duel with no form, a look through the list form
 * that took no step. The open seek, the running duels, the invites
 * waiting with the commands that answer them, then the hand-off to the
 * agent. The finished duels are left to duel --list.
 */
export function lookLines(
  answer: DuelAnswerResponse,
  me: string,
  at: number,
): string[] {
  const running = answer.duel.duels.filter((d) => d.state === 'active');
  const lines = [
    ...seekLines(answer),
    ...running.map((d) => listLine(d, me, at)),
  ];
  if (lines.length === 0) lines.push(NO_DUELS);
  lines.push(...inviteLines(answer, new Set()), EXPLAIN, handOff());
  return lines;
}

// The open seek of the answer, in one line, or none.
function seekLines({ duel: { seek } }: DuelAnswerResponse): string[] {
  return seek !== null && seek.state === 'open'
    ? [`Seeking a duel in ${seek.category} until ${utc(seek.expiresAt)}.`]
    : [];
}

// Each invite in waiting that next does not answer, with the commands that
// accept and decline it.
function inviteLines(
  answer: DuelAnswerResponse,
  answered: Set<string>,
): string[] {
  return answer.waiting.flatMap((item) => {
    if (item.kind !== 'invite' || answered.has(item.id)) return [];
    const until =
      item.expiresAt === null ? '' : `, until ${utc(item.expiresAt)}`;
    return [
      `Duel invite ${item.id} from ${item.from}${until}.${inviteAnswer(item.id)}`,
    ];
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const otherSide = (duel: DuelResponse, me: string) =>
  duel.challenger.agentId === me ? duel.opponent : duel.challenger;

// 47 hours 12 minutes left, whole hours and minutes as sync prints a wait,
// or passed. challenge prints its closing time with it too.
export function timeLeft(ms: number): string {
  return ms <= 0 ? 'passed' : `${durationText(ms)} left`;
}

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

// One line of duel --list. Id, opponent, category and state, then the
// result of a finished duel or the deadline of a running one.
export function listLine(duel: DuelResponse, me: string, at: number): string {
  const head = `${duel.id}  ${otherSide(duel, me).handle}  ${duel.category}  ${duel.state}`;
  const result = resultFor(duel, me);
  if (result !== null) return `${head}  ${result}`;
  if (duel.state === 'active' && duel.deadlineAt !== null) {
    return `${head}  due ${utc(duel.deadlineAt)}, ${timeLeft(Date.parse(duel.deadlineAt) - at)}`;
  }
  return head;
}
