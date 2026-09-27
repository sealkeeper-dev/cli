// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { EVENT_MAX_AGE_DAYS, type Event } from '@sealkeeper/schema';
import { type Paths, paths } from './config.js';
import { cli } from './invocation.js';
import { type LogPosition, pendingEvents } from './log.js';
import { pendingText, staleCutoff } from './sync.js';
import { WIRE_FORM } from './taxonomy.js';

// The pending events exactly as sync would send them. sync signs the JSON
// of each event as it is read from the log, so JSON.stringify of the same
// event is the payload inside the signature, byte for byte. Events older
// than the API accepts are left out, since sync drops them without sending.

// How many events the summary before a sync prints in full.
export const PREVIEW_SAMPLE = 3;

export type Preview = {
  count: number;
  // Per day file in send order, how many events of each type.
  days: { file: string; count: number; types: [string, number][] }[];
  // The first PREVIEW_SAMPLE events, in send order.
  sample: Event[];
  // Every event grouped by the day file it is in, in send order. Only a
  // full preview (--dry-run) keeps them, else it is empty.
  groups: { file: string; events: Event[] }[];
  // The last event read, so a confirmed send stops there. It can be one
  // left out as too old, which that send drops. Null when nothing is pending.
  last: LogPosition | null;
};

type PreviewOptions = {
  // Keep every event, for --dry-run.
  full?: boolean;
  // The clock, for which events are too old. Tests set it.
  now?: Date;
};

export async function readPreview(
  p: Paths = paths(),
  options: PreviewOptions = {},
): Promise<Preview> {
  const now = options.now ?? new Date();
  const cutoff = staleCutoff(now.getTime());
  const preview: Preview = {
    count: 0,
    days: [],
    sample: [],
    groups: [],
    last: null,
  };
  const types: Map<string, number>[] = [];
  for await (const { event, position } of pendingEvents(p, { now })) {
    preview.last = position;
    if (Date.parse(event.occurred_at) < cutoff) continue;
    preview.count++;

    let day = preview.days.at(-1);
    if (!day || day.file !== position.file) {
      day = { file: position.file, count: 0, types: [] };
      preview.days.push(day);
      types.push(new Map());
    }
    day.count++;
    const byType = types.at(-1) as Map<string, number>;
    byType.set(event.type, (byType.get(event.type) ?? 0) + 1);

    if (preview.sample.length < PREVIEW_SAMPLE) preview.sample.push(event);
    if (options.full) {
      const group = preview.groups.at(-1);
      if (group && group.file === position.file) group.events.push(event);
      else preview.groups.push({ file: position.file, events: [event] });
    }
  }
  for (const [i, day] of preview.days.entries()) {
    day.types = [...(types[i] ?? [])];
  }
  return preview;
}

// For --dry-run. One JSON line per event under the path of its day file,
// then the count and what goes on the wire. Needs a full preview.
export function previewLines(preview: Preview, p: Paths = paths()): string[] {
  if (preview.count === 0) return ['nothing pending, nothing to send'];
  const lines: string[] = [];
  for (const group of preview.groups) {
    lines.push(`${p.logFile(group.file.slice(0, 10))}`);
    for (const event of group.events) lines.push(JSON.stringify(event));
    lines.push('');
  }
  lines.push(`${pendingText(preview.count)}, nothing sent yet.`, WIRE_FORM);
  return lines;
}

// For the question before a sync. The count per day and type, then the
// first few events as they are sent, then where to see every one.
export function summaryLines(preview: Preview, p: Paths = paths()): string[] {
  if (preview.count === 0) return ['nothing pending, nothing to send'];
  const lines = [`pending events by day, in ${p.log}`];
  for (const day of preview.days) {
    const types = day.types.map(([type, n]) => `${type} ${n}`).join(', ');
    lines.push(
      `  ${day.file.slice(0, 10)}  ${day.count} event${day.count === 1 ? '' : 's'}  ${types}`,
    );
  }
  lines.push('');
  const shown = preview.sample.length;
  lines.push(
    shown < preview.count
      ? `the first ${shown} of ${preview.count}, as sent`
      : 'as sent',
  );
  for (const event of preview.sample) lines.push(JSON.stringify(event));
  lines.push('');
  if (shown < preview.count) {
    lines.push(`run ${cli('sync --dry-run')} to see every event`, '');
  }
  lines.push(
    `${pendingText(preview.count)}, nothing sent yet. Events older than ${EVENT_MAX_AGE_DAYS} days are not sent.`,
    WIRE_FORM,
  );
  return lines;
}
