// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.

import { stat } from 'node:fs/promises';
import {
  BaseDimension,
  DORMANCY,
  type Event,
  EventType,
  Level,
} from '@vouched-dev/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { resolveApiUrl } from '../api.js';
import {
  claudeConfigDir,
  hasHooks,
  ourCommands,
  parseHookCommand,
  settingsPath,
} from '../claude-code-settings.js';
import {
  type Config,
  handleOf,
  type Paths,
  paths,
  profileUrl,
} from '../config.js';
import {
  CursorError,
  countPending,
  dayOf,
  readCursor,
  readDay,
} from '../log.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { getScore, SCORE_TIMEOUT_MS, type ScoreCache } from '../score.js';
import { unsubmittedClaims } from '../tasks.js';
import { INSTALL_COMMAND } from './adapter.js';
import { defaultSyncDeps, loadConfig } from './sync.js';
import { NOT_INITIALISED } from './whoami.js';

// A local dashboard of today's activity. Everything but the score comes from
// files under the Vouched home, so it works offline. The score comes from the
// score cache, which gives up on the network after two seconds.

// claudeDir and cwd say where to look for the Claude Code settings, and
// default to CLAUDE_CONFIG_DIR or ~/.claude and the working directory.
export type StatusDeps = {
  fetch: typeof fetch;
  claudeDir?: () => string;
  cwd?: () => string;
};

export const NO_ADAPTER = `No adapter installed and nothing recorded in 7 days. Run ${INSTALL_COMMAND}.`;
export const HOOKS_MISSING =
  'The Claude Code hooks point at a vouched that is no longer there. Run vouched adapter claude-code install again, or npm i -g vouched for a stable path.';
const QUIET_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// The scoring job runs every 15 minutes, on the quarter hours.
const SCORING_EVERY_MS = 15 * 60 * 1000;

export type Status = {
  agentId: string;
  // login/name, from config.
  handle: string;
  profileUrl: string;
  // Today's UTC day, YYYY-MM-DD.
  day: string;
  counts: Record<EventType, number>;
  toolCalls: { total: number; ok: number; okRatio: number | null };
  tasks: { claimed: number; submitted: number };
  // Live from the API, the count on the public profile. null when the API
  // did not answer.
  verifiedTasks: number | null;
  // The SEAL standard level of the current version, live from the API. null
  // when the API did not answer or has not scored this version yet.
  level: Level | null;
  // Whole days since the API last accepted an event from this agent. null
  // when unknown or when it has accepted none.
  dormantDays: number | null;
  // Claimed in the local log and not submitted, over the last week.
  unsubmittedClaims: number;
  // Whole minutes until the next quarter hour, when scoring runs.
  nextScoringRunMinutes: number;
  pending: number;
  lastSyncAt: string | null;
  // Whether emit sends events on its own. See vouched config auto-sync.
  autoSync: boolean;
  // Score per dimension for the configured version. null when there is no
  // score for that dimension or the score could not be fetched.
  scores: Record<string, number | null>;
  scoresFetchedAt: string | null;
  // Today's events in full, only with --show.
  events?: Event[];
};

export function register(
  parent: Command,
  deps: StatusDeps = defaultSyncDeps,
): Command {
  return parent
    .command('status')
    .description("Show today's activity from the local log, works offline")
    .option('--show', "also list today's events in full, as they are sent")
    .action(async function (
      this: Command,
      options: { show?: boolean },
    ): Promise<void> {
      const config = await loadConfig(this);
      if (config === null) this.error(NOT_INITIALISED);

      let status: Status;
      try {
        status = await readStatus(config, deps, new Date(), options.show);
      } catch (error) {
        if (error instanceof CursorError) this.error(error.message);
        throw error;
      }

      if (wantsJson(this)) stdout(JSON.stringify(status));
      else printStatus(status);
      // On stderr, so --json output stays one object.
      if (await noAdapterAndQuiet(deps, new Date())) stderr(NO_ADAPTER);
      if (await hooksGone(deps)) stderr(HOOKS_MISSING);
    });
}

export async function readStatus(
  config: Config,
  deps: StatusDeps,
  now: Date,
  show = false,
): Promise<Status> {
  const p = paths();
  const day = dayOf(now);
  // The score request runs while the log is read.
  const scorePromise = getScore({
    agentId: config.agentId,
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
    now,
    paths: p,
  });
  const [events, pending, cursor, score, live, unsubmitted] = await Promise.all(
    [
      readDay(day, p),
      countPending(p),
      readCursor(p),
      scorePromise,
      liveAgent(config, deps),
      unsubmittedClaims(now, p),
    ],
  );

  return {
    agentId: config.agentId,
    handle: handleOf(config),
    profileUrl: profileUrl(config),
    day,
    ...countEvents(events),
    verifiedTasks: live?.counts?.verifiedTasks ?? null,
    level: live?.level ?? null,
    dormantDays: live?.standing?.dormant_days ?? null,
    unsubmittedClaims: unsubmitted.length,
    nextScoringRunMinutes: minutesToNextScoring(now),
    pending,
    lastSyncAt: cursor.lastSyncAt ?? null,
    autoSync: config.autoSync === true,
    scores: scoresFor(config.version, score),
    scoresFetchedAt: score?.fetchedAt ?? null,
    ...(show ? { events } : {}),
  };
}

// The part of GET /v1/agents/<id> status reads. level and standing are
// optional on the answer, since a version the scoring job has not reached
// has neither. Read loosely here, so a field that fails to parse costs only
// that field.
const LiveAgent = z.object({
  counts: z
    .object({ verifiedTasks: z.int().min(0) })
    .optional()
    .catch(undefined),
  level: Level.optional().catch(undefined),
  standing: z
    .object({ dormant_days: z.int().min(0).nullable() })
    .optional()
    .catch(undefined),
});
type LiveAgent = z.infer<typeof LiveAgent>;

// The agent answer, with the same two second limit as the score. null when
// the API does not answer or answers with something else.
async function liveAgent(
  config: Config,
  deps: StatusDeps,
): Promise<LiveAgent | null> {
  const apiUrl = resolveApiUrl({ config: config.apiUrl }).replace(/\/+$/, '');
  try {
    const res = await deps.fetch(
      `${apiUrl}/v1/agents/${encodeURIComponent(config.agentId)}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
      },
    );
    if (res.status !== 200) return null;
    const parsed = LiveAgent.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Minutes until the next wall clock quarter hour, rounded up, so 1 to 15.
export function minutesToNextScoring(now: Date): number {
  const left = SCORING_EVERY_MS - (now.getTime() % SCORING_EVERY_MS);
  return Math.ceil(left / 60_000);
}

function claudeDirs(deps: StatusDeps) {
  return {
    home: '',
    cwd: (deps.cwd ?? (() => process.cwd()))(),
    claudeDir: (deps.claudeDir ?? claudeConfigDir)(),
  };
}

// True when a hook of ours in the user or project settings runs a node
// binary or a vouched script that is not there any more, as happens once
// the npx cache is cleared. The legacy bare and npx forms name no path, so
// there is nothing to check for them.
export async function hooksGone(deps: StatusDeps): Promise<boolean> {
  const dirs = claudeDirs(deps);
  const commands = (
    await Promise.all([
      ourCommands(settingsPath('user', dirs)),
      ourCommands(settingsPath('project', dirs)),
    ])
  ).flat();
  for (const command of commands) {
    const parsed = parseHookCommand(command);
    // A legacy form, bare or through npx, names no path and only works when
    // vouched is on the hook shell's PATH. 0.2.0 wrote it under npx where it
    // never is, so it counts as gone and gets the reinstall pointer.
    if (parsed === null) return true;
    for (const path of [parsed.node, parsed.script]) {
      if (!(await exists(path))) return true;
    }
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// True when neither Claude Code settings file holds our hooks and the log
// has no event in the last seven UTC days, today included. The CLI cannot see
// the Mastra or OpenClaw adapters, which live in other code, but they write
// to the same log, so an agent using them is never quiet for long.
export async function noAdapterAndQuiet(
  deps: StatusDeps,
  now: Date,
  p: Paths = paths(),
): Promise<boolean> {
  const dirs = claudeDirs(deps);
  const installed = await Promise.all([
    hasHooks(settingsPath('user', dirs)),
    hasHooks(settingsPath('project', dirs)),
  ]);
  if (installed.some(Boolean)) return false;
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

function countEvents(
  events: Event[],
): Pick<Status, 'counts' | 'toolCalls' | 'tasks'> {
  const counts = Object.fromEntries(
    EventType.options.map((type) => [type, 0]),
  ) as Record<EventType, number>;
  let ok = 0;
  for (const event of events) {
    counts[event.type]++;
    if (event.type === 'tool.call' && event.payload.ok) ok++;
  }
  const total = counts['tool.call'];
  return {
    counts,
    toolCalls: { total, ok, okRatio: total === 0 ? null : ok / total },
    tasks: {
      claimed: counts['task.claimed'],
      submitted: counts['task.submitted'],
    },
  };
}

// The base dimensions always, then any competence dimensions the API has for
// this version, in name order. A dimension with no score is null.
function scoresFor(
  version: string,
  cache: ScoreCache | null,
): Record<string, number | null> {
  const scores: Record<string, number | null> = Object.fromEntries(
    BaseDimension.options.map((dimension) => [dimension, null]),
  );
  const entries = (cache?.score.scores ?? [])
    .filter((entry) => entry.version === version)
    .sort((a, b) => a.dimension.localeCompare(b.dimension));
  for (const entry of entries) scores[entry.dimension] = entry.value;
  return scores;
}

function printStatus(status: Status): void {
  const rows: [string, string][] = [
    ['agent', status.agentId],
    ['handle', status.handle],
    ['profile', status.profileUrl],
    ['today', `${status.day} UTC`],
  ];
  printRows(rows);

  printRows(
    EventType.options.map((type) => [`  ${type}`, String(status.counts[type])]),
  );

  const { total, ok, okRatio } = status.toolCalls;
  const ratio = okRatio === null ? '-' : `${Math.round(okRatio * 100)}%`;
  printRows([
    ['tool calls', `${total}, ${ok} ok (${ratio})`],
    [
      'tasks',
      `${status.tasks.claimed} claimed, ${status.tasks.submitted} submitted`,
    ],
    [
      'verified tasks',
      status.verifiedTasks === null ? '-' : String(status.verifiedTasks),
    ],
    ['level', status.level ?? '-'],
    ...(status.dormantDays !== null && status.dormantDays > 0
      ? ([['dormant', days(status.dormantDays)]] as [string, string][])
      : []),
    ...(sealWithheld(status.dormantDays)
      ? ([['SEAL', 'no SEAL, withheld while dormant']] as [string, string][])
      : []),
    ['pending', String(status.pending)],
    ['last sync', status.lastSyncAt ?? 'never'],
    [
      'auto-sync',
      status.autoSync ? 'on' : 'off, run vouched sync to review and send',
    ],
    ['scores', status.scoresFetchedAt ? `as of ${status.scoresFetchedAt}` : ''],
  ]);
  printRows(
    Object.entries(status.scores).map(([dimension, value]) => [
      `  ${dimension}`,
      value === null ? '-' : formatScore(value),
    ]),
  );
  stdout('');
  stdout(nextScoringLine(status.nextScoringRunMinutes));
  const dormancy = dormancyLine(status.dormantDays);
  if (dormancy) stdout(dormancy);
  const hint = unsubmittedHint(status);
  if (hint) stdout(hint);

  if (status.events) {
    stdout('');
    stdout(`today's events, ${status.events.length}, as they are sent`);
    for (const event of status.events) stdout(JSON.stringify(event));
  }
}

export function nextScoringLine(minutes: number): string {
  return `Next scoring run in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

// At the 90 day rung the API withholds the SEAL until the next scoring run
// after a new event.
export const sealWithheld = (dormantDays: number | null): boolean =>
  dormantDays !== null && dormantDays >= DORMANCY.noneDays;

// Where the agent is on the dormancy ladder of the SEAL standard and the
// next rung, in plain words. Nothing when it is active today or unknown.
export function dormancyLine(dormantDays: number | null): string | null {
  if (dormantDays === null || dormantDays <= 0) return null;
  const d = DORMANCY;
  const n = days(dormantDays);
  if (dormantDays < d.quietDays) {
    return `No accepted event for ${n}. At ${d.quietDays} days the agent counts as quiet, with no level change.`;
  }
  if (dormantDays < d.dropOneDays) {
    return `Quiet for ${n}. At ${d.dropOneDays} days the level drops one step.`;
  }
  if (dormantDays < d.dropTwoDays) {
    return `Quiet for ${n}, the level is one step down. At ${d.dropTwoDays} days it drops one more.`;
  }
  if (dormantDays < d.noneDays) {
    return `Quiet for ${n}, the level is two steps down. At ${d.noneDays} days the level is none and no SEAL is issued.`;
  }
  return `Quiet for ${n}. No SEAL is issued and the level is none until the next scoring run after a new event.`;
}

// Only while nothing is verified yet, so it points at the one thing left to
// do. The count comes from the local log, so some may have expired.
export function unsubmittedHint(status: Status): string | null {
  if (status.verifiedTasks !== 0 || status.unsubmittedClaims === 0) return null;
  const n = status.unsubmittedClaims;
  return `${n} claimed task${n === 1 ? ' is' : 's are'} not submitted yet. Run vouched prove to print ${n === 1 ? 'it' : 'them'} again with the submit lines.`;
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const LABEL_WIDTH = 18;

// Labels padded to one column. A label too long for it, such as a long
// competence dimension, is followed by one space instead.
function printRows(rows: [string, string][]): void {
  for (const [label, value] of rows) {
    const padded =
      label.length < LABEL_WIDTH ? label.padEnd(LABEL_WIDTH) : `${label} `;
    stdout(`${padded}${value}`.trimEnd());
  }
}
