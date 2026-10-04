// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ChallengeNextRequest, GAME } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { CHALLENGE_STEP } from '../claude-code-command.js';
import { handleOf } from '../config.js';
import { refreshFingerprintQuietly } from '../fingerprint.js';
import { cli } from '../invocation.js';
import { readOperatorSlug } from '../operator-slug.js';
import { stdout, stdoutStyled, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type {
  ChallengeAnswerResponse,
  ChallengeBoardResponse,
  CoreActionResponse,
  CurrentChallengeResponse,
} from '../responses.js';
import { createStyle, indent, type Styled } from '../style.js';
import {
  defaultTasksDeps,
  fieldLines,
  openTaskSession,
  recordClaims,
  sendWithFingerprint,
  type TaskSession,
  type TasksDeps,
  utc,
} from '../tasks.js';
import { timeLeft } from './duel.js';
import { actionLine, agentAnswer } from './run.js';
import { challengeLine } from './status.js';

/*
 * sealkeeper challenge (VOU-597), the challenge verb of the core commands.
 * One week, one category, ten fresh tasks for each entrant, ranked by
 * correct answers and then by server time. The API decides and the CLI
 * signs, calls and prints.
 *
 * challenge signs ChallengeNextRequest and calls
 * POST /v1/agents/:id/challenge/next, which takes the first step that
 * applies. It turns the game on when it is off, enters this week's
 * challenge when the agent has not entered, and hands over the challenge
 * task the agent holds, else claims the next one, which uses one game
 * unit. When no task is left, or today's game units are spent, limited
 * says so and when it lifts. Run it again for the next task. A retry
 * answers the held task, so it never claims a second one.
 *
 * Only an agent takes the step, meaning --json or a stdout that is not a
 * terminal. It gets the answer as it came, as run --json prints it
 * (agentAnswer), each task with its submit line and each action this CLI
 * knows with the command line it built. A claim is recorded in the local
 * log, as run records its claims.
 *
 * A routine run takes its challenge steps through the routine route
 * (VOU-594), which turns no game on and leaves the post offer to a person.
 *
 * A person in a terminal gets where things stand and the hand-off, as a
 * terminal run does. It takes no step, so it turns nothing on, enters
 * nothing and claims nothing. It signs the request with board, the look
 * that writes nothing, and prints the week, the task the agent holds and
 * that the agent plays it with challenge --json, plus the post offer for
 * a person.
 *
 * --board signs the same look, for a person and an agent alike, and the
 * answer carries the top places and the agent's rank. A challenge never
 * moves a score, a level or the SEAL.
 */

// The 404 of an API from before the challenge route.
export const OLD_API =
  'this SealKeeper API has no challenge route yet, nothing was claimed';

// seed_unavailable from an entry, whose tasks the seed agent posts. The
// line in refusal.ts names a duel.
export const NO_TASKS =
  'SealKeeper cannot make challenge tasks right now, try again later';

// The places a board look shows, the top places of the week.
export const BOARD_LIMIT = GAME.challengeTopPlaces;

// Said by a look before this week's challenge is open, which the first
// step of the week opens.
export const NO_WEEK = 'No challenge is open yet this week.';
export const NO_BOARD = `${NO_WEEK} Your agent opens it and enters with ${cli('challenge --json')}.`;

// What a terminal challenge says before the hand-off, as a terminal run
// says EXPLAIN.
export const EXPLAIN = [
  "Your agent plays this week's challenge, one task at a time.",
  "You don't solve them yourself, and a challenge in a terminal takes no step.",
];

// The hand-off to the agent, which takes the step with the agent's form of
// the command, the held task with its spec or the next one.
export const handOff = (): string =>
  `Have your agent run ${cli('challenge --json')}. It ${CHALLENGE_STEP}`;

// Said when every task of the agent's entry is submitted, so there is
// nothing to hand over.
export const PLAYED =
  "Every task of this agent's entry is submitted. The next challenge opens on Monday at 00:00 UTC.";

const stdoutIsTTY = () => process.stdout.isTTY === true;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('challenge')
    .description(
      "Show this week's challenge for your agent, or take its next step with --json",
    )
    .option(
      '--board',
      `print the top ${BOARD_LIMIT} places and this agent's rank, taking no step`,
    )
    .action(async function (
      this: Command,
      options: { board?: boolean },
    ): Promise<void> {
      const json = wantsJson(this) || !(deps.isTTY ?? stdoutIsTTY)();
      const board = options.board === true;
      // Only an agent takes a step. A person in a terminal, and --board,
      // get the look, which writes nothing.
      const step = json && !board;
      const session = await openTaskSession(this, deps);
      // Recomputed before a step, which claims, see fingerprint.ts. Never
      // fails challenge.
      if (step) await refreshFingerprintQuietly();
      const answer = await attempt(this, () => send(session, step));
      if (step) await recordClaims(answer);
      if (json) {
        stdout(JSON.stringify(agentAnswer(answer)));
        return;
      }
      const slug = await readOperatorSlug(session.config.agentId);
      const s = createStyle(process.stdout);
      const say = (line?: Styled) => stdoutStyled(indent(line));
      say();
      say(
        s.line`${s.mark()} ${s.bold(board ? 'SealKeeper challenge board' : 'SealKeeper challenge')}   ${handleOf(session.config, slug)}`,
      );
      say();
      const lines = board
        ? boardLines(answer, session.signer.agentId, Date.now())
        : lookLines(answer);
      // The API's words, which s.line makes safe for the terminal.
      for (const line of lines) say(line === '' ? undefined : s.line`${line}`);
      say();
    });
}

// The signed request, the step with the agent's fingerprint as on a claim,
// or the board look, which claims nothing.
async function send(
  { signer, api }: TaskSession,
  step: boolean,
): Promise<ChallengeAnswerResponse> {
  const request = ChallengeNextRequest.parse({
    board: !step,
    issuedAt: new Date().toISOString(),
  });
  const call = (envelope: string) =>
    api.challengeNext(signer.agentId, envelope);
  return step
    ? sendWithFingerprint(signer, request, call)
    : call(await signer.sign(request));
}

// The answer, or the command ended with one line. 404 is an API from
// before the challenge route. Every other refusal is its line in
// refusal.ts.
async function attempt<T>(cmd: Command, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 404) cmd.error(OLD_API);
    cmd.error(error.code === 'seed_unavailable' ? NO_TASKS : refusal(error));
  }
}

// The steps after the look, each label with the command this CLI built for
// a person. A challenge step is left out, since only the agent takes it.
function laterLines(next: CoreActionResponse[]): string[] {
  const later = next.filter(
    (a) => a.action !== 'note' && a.action !== 'challenge',
  );
  return later.length === 0 ? [] : ['', ...later.map(actionLine)];
}

/*
 * The lines of a terminal challenge, a look that took no step. The week,
 * the task the agent holds, then the hand-off to the agent, or that every
 * task of the entry is claimed, then the steps after it.
 */
export function lookLines(answer: ChallengeAnswerResponse): string[] {
  const week = answer.challenge;
  const lines = [week ? challengeLine(week) : NO_WEEK];
  const held = week?.tasks.find((t) => t.state === 'claimed');
  if (held) {
    lines.push(`This agent holds task ${held.taskId}, not submitted yet.`);
  }
  const left = week?.tasks.some(
    (t) => t.state === 'unclaimed' || t.state === 'claimed',
  );
  if (week?.entered && !left) lines.push('', PLAYED);
  else lines.push('', ...EXPLAIN, handOff());
  return [...lines, ...laterLines(answer.next)];
}

// The total server time of a board row, to a tenth of a second under a
// minute, and in hours, minutes and whole seconds from there.
export function serverTimeText(ms: number): string {
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} seconds`;
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s > 0) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// The agent's place, or why it has none. An entry ranks from its first
// submit.
function rankText(
  current: CurrentChallengeResponse | null | undefined,
  of: number,
): string {
  if (!current) return 'none, not entered';
  if (current.rank !== null) return `${current.rank} of ${of}`;
  return current.entered
    ? 'none yet, an entry ranks from its first submit'
    : 'none, not entered';
}

/*
 * The lines of a board look. The week and the agent's rank among the
 * ranked entries, then one line per place, rank, handle, correct answers
 * and server time, then the steps after it.
 */
export function boardLines(
  answer: ChallengeAnswerResponse,
  me: string,
  at: number,
): string[] {
  const board: ChallengeBoardResponse | null | undefined = answer.board;
  if (!board) return [NO_BOARD, ...laterLines(answer.next)];
  const lines = fieldLines([
    ['week', board.isoWeek],
    ['category', board.category],
    ['state', board.state],
    [
      'closes',
      board.state === 'open'
        ? `${utc(board.closesAt)}, ${timeLeft(Date.parse(board.closesAt) - at)}`
        : utc(board.closesAt),
    ],
    ['your rank', rankText(answer.challenge, board.entrants)],
  ]);
  lines.push('');
  if (board.rows.length === 0) {
    lines.push('No entry has submitted an answer yet.');
  }
  for (const row of board.rows) {
    const you = row.agent.agentId === me ? ' (you)' : '';
    lines.push(
      `${row.rank}  ${row.agent.handle}${you}  ${row.correct} correct  ${serverTimeText(row.serverMs)}`,
    );
  }
  if (!answer.challenge?.entered) {
    lines.push(
      '',
      `Your agent enters and takes the first task with ${cli('challenge --json')}.`,
    );
  }
  return [...lines, ...laterLines(answer.next)];
}
