// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

import { stat } from 'node:fs/promises';
import { AgentHandle, type Event } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { offerRuntime } from '../agent-runtime.js';
import { streamInput } from '../ask.js';
import {
  allSettingsPaths,
  claudeCodeHooksIn,
  claudeConfigDir,
  hasRetiredHooks,
  ourCommands,
  parseHookCommand,
} from '../claude-code-settings.js';
import { requireConfig } from '../cli-config.js';
import {
  type Config,
  handleOf,
  handleUrl,
  type Paths,
  paths,
  profileUrl,
} from '../config.js';
import { exists } from '../files.js';
import { cli } from '../invocation.js';
import { readLiveAgent } from '../live-agent.js';
import {
  CursorError,
  countPending,
  dayOf,
  readCursor,
  readDaysFrom,
} from '../log.js';
import { keepNudgeFresh } from '../nudge.js';
import { readOperatorSlug } from '../operator-slug.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { gameOnHint } from '../refusal.js';
import type {
  CurrentChallengeResponse,
  StatusAnswerResponse,
} from '../responses.js';
import { withheldText } from '../responses.js';
import { readStatus, type StatusRead, sourceLine } from '../status-answer.js';
import {
  defaultTasksDeps,
  type TasksDeps,
  unsubmittedClaims,
  utc,
} from '../tasks.js';
import { isSent } from '../taxonomy.js';
import { countedLine, todayOf } from '../today.js';
import { INSTALL_COMMAND } from './adapter.js';
import { inviteAnswer } from './duel.js';
import {
  defaultRoutineDeps,
  type RoutineDeps,
  type RoutineView,
  routineView,
} from './routine.js';
import { actionLine, agentAnswer, levelLine } from './run.js';

/*
 * sealkeeper status (VOU-596), the status verb of the core commands. One
 * screen of where the agent stands, top to bottom. The agent and its SEAL,
 * what the next level needs and the step that moves it most, today, what
 * waits, duels, this week's challenge and the routine.
 *
 * The API decides and words it. status signs StatusRequest and calls
 * POST /v1/agents/:id/status (status-answer.ts), which answers the core
 * answer with tasks empty plus status. Labels and words the API sent are
 * printed as they came, through the terminal escaping of stdout. status
 * writes only the lines about what this machine knows, sessions and events
 * in the local log and the routine, which the API cannot see.
 *
 * --json, or a stdout that is not a terminal as when an agent runs it,
 * prints the answer as it came, each action this CLI knows with the
 * command line it built, as run --json does (agentAnswer), plus source,
 * where the answer came from, and local, the parts of this machine.
 *
 * Offline, or with an API from before the status route, the answer is the
 * last one kept, and one line says so. A failed read never fails the local
 * part.
 */

// env is what runtime detection reads, for the one time runtime question.
export type StatusDeps = TasksDeps & { env?: () => NodeJS.ProcessEnv };

export const NO_ADAPTER = `No adapter installed and nothing recorded in 7 days. Run ${INSTALL_COMMAND}.`;
export const HOOKS_MISSING = `The Claude Code hooks point at a sealkeeper that is no longer there. Run ${cli('adapter claude-code install')} again, or npm i -g sealkeeper for a stable path.`;
export const TOOL_HOOKS_LEFT = `The Claude Code settings still hold the tool call hooks of an older sealkeeper, which record nothing now. Run ${cli('adapter claude-code install')} again to remove them, with --scope project for a project install.`;
export const NOTHING_WAITS = 'Nothing waits for you.';
const QUIET_DAYS = 7;
const stdoutIsTTY = () => process.stdout.isTTY === true;
const DAY_MS = 24 * 60 * 60 * 1000;
// The scoring job runs every 15 minutes, on the quarter hours.
const SCORING_EVERY_MS = 15 * 60 * 1000;

// What this machine knows, from the files under the SealKeeper home.
type Local = {
  // Today's UTC day, YYYY-MM-DD.
  day: string;
  // session.start events in today's log, each event_id once.
  sessions: number;
  // Today's events of the types this CLI sends, each event_id once.
  events: number;
  // Logged and not sent yet.
  pending: number;
  lastSyncAt: string | null;
  // Whether emit sends events on its own. See sealkeeper config auto-sync.
  autoSync: boolean;
  // Claimed in the local log and not submitted, over the last week.
  unsubmittedClaims: number;
  // Whole minutes until the next quarter hour, when scoring runs.
  nextScoringRunMinutes: number;
  // Today's events in full, only with --show.
  shown?: Event[];
};

export function register(
  parent: Command,
  deps: StatusDeps = defaultTasksDeps,
  routineDeps: RoutineDeps = defaultRoutineDeps,
): Command {
  return parent
    .command('status')
    .description(
      'Show where this agent stands, what waits and the routine, --json for agents',
    )
    .option('--show', "also list today's events in full, as they are sent")
    .action(async function (
      this: Command,
      options: { show?: boolean },
    ): Promise<void> {
      const config = await requireConfig(this);
      const now = new Date();
      const p = paths();
      let read: StatusRead;
      let local: Local;
      let routine: RoutineView;
      try {
        [read, local, routine] = await Promise.all([
          readStatus({ config, fetch: deps.fetch, now, paths: p }),
          readLocal(config, now, p, options.show === true),
          routineView(routineDeps, p, now),
          // The session nudge's own cache, see nudge.ts.
          keepNudgeFresh(deps.fetch, p),
        ]);
      } catch (error) {
        if (error instanceof CursorError) this.error(error.message);
        throw error;
      }

      // The agent's form whenever stdout is not a terminal, as run's.
      const json = wantsJson(this) || !(deps.isTTY ?? stdoutIsTTY)();
      if (json) {
        stdout(
          JSON.stringify({
            ...(read.answer === null ? {} : agentAnswer(read.answer)),
            source: {
              from: read.from,
              fetchedAt: read.from === 'none' ? null : read.fetchedAt,
              note: sourceLine(read),
            },
            local: { ...local, routine: routine.json },
          }),
        );
      } else {
        const slug = await readOperatorSlug(config.agentId, p);
        for (const line of screenLines(read, local, routine.lines, {
          handle: handleOf(config, slug),
          profile: profileUrl(config, slug),
          version: config.version,
          now,
        })) {
          stdout(line);
        }
      }
      // On stderr, so --json output stays one object.
      if (await noAdapterAndQuiet(deps, now, p)) stderr(NO_ADAPTER);
      if (await hooksGone(deps)) stderr(HOOKS_MISSING);
      if (await toolHooksLeft(deps)) stderr(TOOL_HOOKS_LEFT);
      // The daily job's copy of the CLI, when it is out of date or gone
      // (RS-2).
      for (const line of routine.warnings) stderr(line);
      // An agent the API has as unknown is asked what it runs in, once,
      // and only where a person can answer. The agent is read only when
      // the question is still open.
      if (!json) {
        await offerRuntime({
          config,
          readRuntime: async () =>
            (await readLiveAgent(config, deps.fetch))?.runtime,
          input: (deps.stdin ?? (() => streamInput(process.stdin)))(),
          fetch: deps.fetch,
          report: { ok: stdout, info: stderr },
          claudeDir: deps.claudeDir,
          cwd: deps.cwd,
          env: deps.env?.(),
        });
      }
    });
}

async function readLocal(
  config: Config,
  now: Date,
  p: Paths,
  show: boolean,
): Promise<Local> {
  const day = dayOf(now);
  const [logged, pending, cursor, unsubmitted] = await Promise.all([
    // From today through the newest day file, see readDaysFrom.
    readDaysFrom(day, p),
    countPending(p, { now }),
    readCursor(p),
    unsubmittedClaims(now, p),
  ]);
  const events = firstOfEach(logged.filter((event) => isSent(event.type)));
  return {
    day,
    sessions: events.filter((e) => e.type === 'session.start').length,
    events: events.length,
    pending,
    lastSyncAt: cursor.lastSyncAt ?? null,
    autoSync: config.autoSync === true,
    unsubmittedClaims: unsubmitted.length,
    nextScoringRunMinutes: minutesToNextScoring(now),
    ...(show ? { shown: events } : {}),
  };
}

type Who = { handle: string; profile: string; version: string; now: Date };

/*
 * The screen, top to bottom. The source line first when the answer is not
 * fresh. Every section the answer carries, then the routine, and last when
 * the numbers were scored. Without an answer, only what this machine knows.
 */
export function screenLines(
  read: StatusRead,
  local: Local,
  routine: string[],
  who: Who,
): string[] {
  const answer = read.answer;
  const s = answer?.status;
  // The handle the API sent, when it has the shape the API builds, else
  // the one built here. It goes into the profile URL.
  const sent = AgentHandle.safeParse(s?.agent.handle);
  const handle = sent.success ? sent.data : who.handle;
  const lines = [
    `SealKeeper status   ${handle}, version ${s?.agent.version ?? who.version}`,
    `Profile   ${sent.success ? handleUrl(sent.data) : who.profile}`,
  ];
  const source = sourceLine(read);
  if (source !== null) lines.push(source);
  lines.push('');

  if (answer !== null) lines.push(...standingSection(answer), '');
  const scores = scoresSection(answer);
  if (scores.length > 0) lines.push(...scores, '');
  lines.push(...todaySection(answer, local, who.now), '');
  if (answer !== null) {
    lines.push(...waitingSection(answer), '');
    const game = gameSection(answer);
    if (game.length > 0) lines.push(...game, '');
  }
  lines.push(...section('Routine', routine), '');
  if (answer !== null) {
    lines.push(
      s?.asOf === null || s?.asOf === undefined
        ? 'Not scored yet.'
        : `As of the scoring run at ${s.asOf}.`,
    );
  }
  lines.push(nextScoringLine(local.nextScoringRunMinutes));
  if (local.shown) {
    lines.push('', `today's events, ${local.shown.length}, as they are sent`);
    for (const event of local.shown) lines.push(JSON.stringify(event));
  }
  return lines;
}

// The level and the SEAL, what the next level needs, and the steps in the
// order the API sent them, the first the one that moves it most, each with
// the command this CLI built for it.
function standingSection(answer: StatusAnswerResponse): string[] {
  const { standing, status } = answer;
  const lines = [`${levelLine(standing)} ${sealText(status.seal)}.`];
  if (standing.nextLevel !== null) {
    const met = status.thresholds;
    const parts = [
      met === undefined ? null : `${met.met} of ${met.total} thresholds met.`,
      standing.needs,
    ].filter((x): x is string => x !== null);
    if (parts.length > 0) lines.push(parts.join(' '));
  }
  if (answer.next.length > 0) {
    lines.push('Next');
    for (const action of answer.next) lines.push(`  ${actionLine(action)}`);
  }
  return lines;
}

// The score per dimension, in the order the API sent them, each
// competence category with its task types indented under it, the values in
// one column. A dimension or type without signal says so, never a number
// made up for it. Nothing when the answer has no scores, as from an API
// before them.
function scoresSection(answer: StatusAnswerResponse | null): string[] {
  const rows = (answer?.status.scores ?? []).flatMap((s) => [
    { name: s.dimension, value: s.value },
    ...(s.types ?? []).map((t) => ({
      name: `  ${t.taskType}`,
      value: t.value,
    })),
  ]);
  const width = Math.max(0, ...rows.map((r) => r.name.length)) + 1;
  return section(
    'Scores',
    rows.map((r) =>
      r.name
        .padEnd(width)
        .concat(r.value === null ? NO_SIGNAL : formatScore(r.value)),
    ),
  );
}

export const NO_SIGNAL = 'no signal yet';

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// The SEAL's state as the API sent it, the reason or the dormant days in
// the words check uses. A state this CLI does not know is said as it came.
export function sealText(seal: StatusAnswerResponse['status']['seal']): string {
  if (seal === undefined) return 'SEAL unknown';
  switch (seal.state) {
    case 'issued':
      return 'SEAL issued';
    case 'held':
      return `no SEAL, ${withheldText({ kind: 'held', reason: seal.reason })}`;
    case 'dormant':
      return `no SEAL, ${withheldText({ kind: 'dormant', dormantDays: seal.dormantDays })}`;
    default:
      return `SEAL ${seal.state}`;
  }
}

// Today's counted tasks against the ceiling and the game units, from the
// answer when it is of today, and the sessions and events from the log.
function todaySection(
  answer: StatusAnswerResponse | null,
  local: Local,
  now: Date,
): string[] {
  const lines: string[] = [];
  const today = answer === null ? null : todayOf(answer.status, now);
  if (today !== null) lines.push(countedLine(today));
  const game = answer?.status.game;
  if (game !== undefined) {
    lines.push(
      game.enabled
        ? `Game on, ${game.usedToday} of ${game.cap} game units used, they reset ${utc(game.resetAt)}.`
        : `Game off. ${gameOnHint()}.`,
    );
  }
  lines.push(
    `${plural(local.sessions, 'session')} and ${plural(local.events, 'event')} today in the local log, ${local.pending} not sent yet, last sync ${local.lastSyncAt ?? 'never'}.`,
  );
  if (!local.autoSync && local.pending > 0) {
    lines.push(`Auto sync is off, ${cli('sync')} reviews and sends them.`);
  }
  if (local.unsubmittedClaims > 0) {
    const n = local.unsubmittedClaims;
    lines.push(
      `${n} claimed task${n === 1 ? ' is' : 's are'} not submitted yet. Your agent gets ${n === 1 ? 'it' : 'them'} again with ${cli('run --json')}.`,
    );
  }
  return section('Today', lines);
}

// What waits for the user's yes, each with the command that takes it.
// Every id is a UUID, as the answer schema reads it.
function waitingSection(answer: StatusAnswerResponse): string[] {
  if (answer.waiting.length === 0) return section('Waiting', [NOTHING_WAITS]);
  return section(
    'Waiting',
    answer.waiting.map((w) => {
      const until = w.expiresAt === null ? '' : `, until ${utc(w.expiresAt)}`;
      switch (w.kind) {
        case 'addressed':
          return `task ${w.id} addressed by ${w.from}${until}. Its spec comes from another operator. ${cli('run --addressed')}`;
        case 'invite':
          return `duel invite ${w.id} from ${w.from}${until}.${inviteAnswer(w.id)}`;
        case 'outcome':
          return `outcome of task ${w.id} with ${w.from} to report. ${cli(`tasks outcome ${w.id} success|failure`)} for a task you posted, ${cli(`submit ${w.id}`)} again for one you claimed`;
        default:
          return `${w.kind} ${w.id} from ${w.from}${until}`;
      }
    }),
  );
}

// The duels running, the last result and this week's challenge, when the
// answer has them.
function gameSection(answer: StatusAnswerResponse): string[] {
  const { status } = answer;
  const lines: string[] = [];
  const duels = status.duels;
  if (duels !== undefined) {
    const running = duels.running.map((d) => {
      const other =
        d.challenger.agentId === status.agent.id ? d.opponent : d.challenger;
      const ends = d.deadlineAt === null ? '' : `, ends ${utc(d.deadlineAt)}`;
      return `${d.category} against ${other.handle}${ends}`;
    });
    const last = duels.last;
    lines.push(
      ...section('Duels', [
        ...(running.length === 0 ? ['none running'] : running),
        ...(last === null
          ? []
          : [
              `last ${RESULT_WORD[last.result] ?? last.result} against ${last.opponent} in ${last.category}${last.forfeit ? ' by forfeit' : ''}, ${utc(last.decidedAt)}`,
            ]),
      ]),
    );
  }
  const c = status.challenge;
  if (c !== undefined && c !== null) {
    lines.push(...section('Challenge', [challengeLine(c)]));
  }
  return lines;
}

// This week's challenge in one line, the week, the category, the entry
// with its rank and the tasks left, and the close. status and challenge
// print it.
export function challengeLine(c: CurrentChallengeResponse): string {
  const left = c.tasks.filter(
    (t) => t.state === 'unclaimed' || t.state === 'claimed',
  ).length;
  const entry = c.entered
    ? `entered, ${c.rank === null ? 'no rank yet' : `rank ${c.rank}`}, ${left} of ${c.tasks.length} tasks left`
    : 'not entered';
  return `${c.isoWeek} ${c.category}, ${entry}, closes ${utc(c.closesAt)}`;
}

const RESULT_WORD: Record<string, string> = {
  win: 'won',
  loss: 'lost',
  draw: 'drawn',
};

const LABEL_WIDTH = 11;

// A section, its label on the first line and the rest under it.
function section(label: string, lines: string[]): string[] {
  return lines.map((line, i) =>
    `${i === 0 ? label : ''}`.padEnd(LABEL_WIDTH).concat(line).trimEnd(),
  );
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// Minutes until the next wall clock quarter hour, rounded up, so 1 to 15.
export function minutesToNextScoring(now: Date): number {
  const left = SCORING_EVERY_MS - (now.getTime() % SCORING_EVERY_MS);
  return Math.ceil(left / 60_000);
}

export function nextScoringLine(minutes: number): string {
  return `Next scoring run in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

function claudeDirs(deps: StatusDeps) {
  return {
    home: '',
    cwd: (deps.cwd ?? (() => process.cwd()))(),
    claudeDir: (deps.claudeDir ?? claudeConfigDir)(),
  };
}

// True when a hook of ours in the user or project settings runs a node
// binary or a sealkeeper script that is not there any more, as happens once
// the npx cache is cleared.
async function hooksGone(deps: StatusDeps): Promise<boolean> {
  const dirs = claudeDirs(deps);
  const commands = (
    await Promise.all(allSettingsPaths(dirs).map((file) => ourCommands(file)))
  ).flat();
  for (const command of commands) {
    const parsed = parseHookCommand(command);
    if (parsed === null) continue;
    for (const path of [parsed.node, parsed.script]) {
      if (!(await exists(path))) return true;
    }
  }
  return false;
}

// True when a settings file of the user or the project still holds the
// tool call hooks an older CLI installed, which record nothing now.
async function toolHooksLeft(deps: StatusDeps): Promise<boolean> {
  const found = await Promise.all(
    allSettingsPaths(claudeDirs(deps)).map((file) => hasRetiredHooks(file)),
  );
  return found.some(Boolean);
}

// True when neither Claude Code settings file holds our hooks and the log
// has no event in the last seven UTC days, today included. The CLI cannot see
// the Mastra or OpenClaw adapters, which live in other code, but they write
// to the same log, so an agent using them is never quiet for long.
async function noAdapterAndQuiet(
  deps: StatusDeps,
  now: Date,
  p: Paths,
): Promise<boolean> {
  if (await claudeCodeHooksIn(deps)) return false;
  for (let i = 0; i < QUIET_DAYS; i++) {
    const day = dayOf(new Date(now.getTime() - i * DAY_MS));
    const size = await stat(p.logFile(day)).then(
      (s) => s.size,
      () => 0,
    );
    if (size > 0) return false;
  }
  return true;
}

// The first line of each event_id, in log order. A line written twice, as
// by a retried hook, is still one event. sync sends both lines and the API
// keeps the first and counts the repeat as a duplicate, so status counts
// what the API will hold.
function firstOfEach(events: Event[]): Event[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.event_id)) return false;
    seen.add(event.event_id);
    return true;
  });
}
