// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { BaseDimension, type Event, EventType } from '@vouched-dev/schema';
import type { Command } from 'commander';
import { resolveApiUrl } from '../api.js';
import { type Config, handleOf, paths, profileUrl } from '../config.js';
import {
  CursorError,
  countPending,
  dayOf,
  readCursor,
  readDay,
} from '../log.js';
import { stdout, wantsJson } from '../output.js';
import { getScore, type ScoreCache } from '../score.js';
import { defaultSyncDeps, loadConfig } from './sync.js';
import { NOT_INITIALISED } from './whoami.js';

// A local dashboard of today's activity. Everything but the score comes from
// files under the Vouched home, so it works offline. The score comes from the
// score cache, which gives up on the network after two seconds.

export type StatusDeps = {
  fetch: typeof fetch;
};

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

      if (wantsJson(this)) {
        stdout(JSON.stringify(status));
        return;
      }
      printStatus(status);
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
  const [events, pending, cursor, score] = await Promise.all([
    readDay(day, p),
    countPending(p),
    readCursor(p),
    scorePromise,
  ]);

  return {
    agentId: config.agentId,
    handle: handleOf(config),
    profileUrl: profileUrl(config),
    day,
    ...countEvents(events),
    pending,
    lastSyncAt: cursor.lastSyncAt ?? null,
    autoSync: config.autoSync === true,
    scores: scoresFor(config.version, score),
    scoresFetchedAt: score?.fetchedAt ?? null,
    ...(show ? { events } : {}),
  };
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

  if (status.events) {
    stdout('');
    stdout(`today's events, ${status.events.length}, as they are sent`);
    for (const event of status.events) stdout(JSON.stringify(event));
  }
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
