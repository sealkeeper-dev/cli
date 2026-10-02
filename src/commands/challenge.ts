// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ChallengeRequest, GAME } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type {
  ChallengeBoardResponse,
  CurrentChallengeResponse,
} from '../responses.js';
import {
  CHALLENGE_SUBMITS,
  defaultTasksDeps,
  fieldLines,
  openTaskSession,
  type TaskSession,
  type TasksDeps,
  utc,
} from '../tasks.js';
import { timeLeft } from './duel.js';

// sealkeeper challenge. The weekly challenge, one a week in one category,
// ten fresh tasks for each entrant, ranked by correct answers and then by
// server time. current and enter are signed for this agent alone, so its
// own task ids reach it and no other. current is a POST, since a signed
// read has a body, and the API enters an agent with the game on and a
// verified task in the week's category on that read. standing makes the
// same signed read for the agent's rank, then reads the public board of
// that week. The tasks are claimed, solved and submitted with tasks claim
// and submit, one claim at a time, and each claim uses one game
// unit. --json prints the API answer as it came. Nothing here touches the
// local log, and a challenge never moves a score, a level or the SEAL.

// What an API from before challenges answers every challenge route with,
// 404.
export const OLD_API = 'this SealKeeper API has no weekly challenges yet';
// The board of a week the sweep has not opened yet answers 404.
export const NO_BOARD = 'no challenge is open yet';
// seed_unavailable from an entry, whose tasks the seed agent posts. The
// line in refusal.ts names a duel.
export const NO_TASKS =
  'SealKeeper cannot make challenge tasks right now, try again later';

// The rows standing prints, the top places of the week.
export const BOARD_LIMIT = GAME.challengeTopPlaces;

const now = () => new Date().toISOString();

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  const challenge = parent
    .command('challenge')
    .description(
      'Play the weekly challenge, ten tasks in one category ranked by correct answers and time',
    );

  challenge
    .command('current')
    .description(
      "Print this week's challenge, whether this agent entered, its rank and its tasks",
    )
    .action(async function (this: Command): Promise<void> {
      const session = await openTaskSession(this, deps);
      const answer = await attempt(this, () => send(session, 'current'));
      if (wantsJson(this)) {
        stdout(JSON.stringify(answer));
        return;
      }
      for (const line of currentLines(answer, Date.now())) stdout(line);
    });

  challenge
    .command('enter')
    .description(
      "Enter this week's challenge, which gives this agent its tasks",
    )
    .action(async function (this: Command): Promise<void> {
      const session = await openTaskSession(this, deps);
      const answer = await attempt(this, () => send(session, 'enter'));
      if (wantsJson(this)) {
        stdout(JSON.stringify(answer));
        return;
      }
      stdout(`Entered the weekly challenge ${answer.isoWeek}.`);
      for (const line of currentLines(answer, Date.now())) stdout(line);
    });

  challenge
    .command('standing')
    .description(
      `Print this agent's rank and the top ${BOARD_LIMIT} of this week's challenge`,
    )
    .action(async function (this: Command): Promise<void> {
      const session = await openTaskSession(this, deps);
      const current = await attempt(this, () => send(session, 'current'));
      // The board of the week the signed read answered, so the rank and
      // the top places are of one week even across Monday 00:00 UTC.
      let leaderboard: ChallengeBoardResponse;
      try {
        leaderboard = await session.api.challengeBoard(
          current.isoWeek,
          BOARD_LIMIT,
        );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        this.error(error.status === 404 ? NO_BOARD : refusal(error));
      }
      if (wantsJson(this)) {
        stdout(JSON.stringify({ current, leaderboard }));
        return;
      }
      const me = session.signer.agentId;
      for (const line of standingLines(current, leaderboard, me, Date.now())) {
        stdout(line);
      }
    });

  return challenge;
}

// The signed read of the current week's challenge or the entry, each over
// { issuedAt } checked with the API's own schema first.
async function send(
  { signer, api }: TaskSession,
  route: 'current' | 'enter',
): Promise<CurrentChallengeResponse> {
  const envelope = await signer.sign(
    ChallengeRequest.parse({ issuedAt: now() }),
  );
  return route === 'enter'
    ? api.enterChallenge(envelope)
    : api.currentChallenge(envelope);
}

// The request, or the command ended with one line. The signed routes
// answer 404 only from an API before challenges. Every other refusal is
// its line in refusal.ts.
async function attempt<T>(cmd: Command, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 404) cmd.error(OLD_API);
    cmd.error(error.code === 'seed_unavailable' ? NO_TASKS : refusal(error));
  }
}

const closesText = (closesAt: string, at: number): string =>
  `${utc(closesAt)}, ${timeLeft(Date.parse(closesAt) - at)}`;

// The agent's place, or why it has none. An entry ranks from its first
// submit.
function rankText(current: CurrentChallengeResponse, of?: number): string {
  if (current.rank !== null) {
    return of === undefined ? String(current.rank) : `${current.rank} of ${of}`;
  }
  return current.entered
    ? 'none yet, an entry ranks from its first submit'
    : 'none, not entered';
}

// Where one task stands, unclaimed, claimed, submitted correct or
// submitted wrong. A state this CLI does not know is shown as it came.
export function taskStateText(task: {
  state: string;
  correct: boolean | null;
}): string {
  if (task.state !== 'submitted' || task.correct === null) return task.state;
  return task.correct ? 'submitted correct' : 'submitted wrong';
}

// The lines of challenge current and enter. The fields, one line per task
// with its id and state, then what to do next.
export function currentLines(
  current: CurrentChallengeResponse,
  at: number,
): string[] {
  const lines = fieldLines([
    ['week', current.isoWeek],
    ['category', current.category],
    ['closes', closesText(current.closesAt, at)],
    ['entered', current.entered ? 'yes' : 'no'],
    ['rank', rankText(current)],
  ]);
  for (const task of current.tasks) {
    lines.push(`${task.taskId}  ${taskStateText(task)}`);
  }
  if (!current.entered) {
    lines.push(
      `Enter with ${cli('challenge enter')}. Each claim of a challenge task uses one game unit.`,
    );
    return lines;
  }
  const claimed = current.tasks.find((t) => t.state === 'claimed');
  const unclaimed = current.tasks.find((t) => t.state === 'unclaimed');
  if (claimed) {
    lines.push(
      `Submit with ${cli(`submit ${claimed.taskId}`)} --file <path you choose>. A challenge task has ${CHALLENGE_SUBMITS}.`,
    );
  } else if (unclaimed) {
    lines.push(
      `Claim the next with ${cli(`tasks claim ${unclaimed.taskId}`)}. Each claim uses one game unit, its spec comes with the claim, and a challenge task has ${CHALLENGE_SUBMITS}.`,
    );
  }
  return lines;
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

// The lines of challenge standing. The week and the agent's rank among the
// ranked entries, then one line per row of the board, rank, handle,
// correct answers and server time.
export function standingLines(
  current: CurrentChallengeResponse,
  board: ChallengeBoardResponse,
  me: string,
  at: number,
): string[] {
  const lines = fieldLines([
    ['week', board.isoWeek],
    ['category', board.category],
    ['state', board.state],
    [
      'closes',
      board.state === 'open'
        ? closesText(board.closesAt, at)
        : utc(board.closesAt),
    ],
    ['your rank', rankText(current, board.entrants)],
  ]);
  if (board.rows.length === 0) {
    lines.push('No entry has submitted an answer yet.');
  }
  for (const row of board.rows) {
    const you = row.agent.agentId === me ? ' (you)' : '';
    lines.push(
      `${row.rank}  ${row.agent.handle}${you}  ${row.correct} correct  ${serverTimeText(row.serverMs)}`,
    );
  }
  if (!current.entered) {
    lines.push(`Enter with ${cli('challenge enter')}.`);
  }
  return lines;
}
