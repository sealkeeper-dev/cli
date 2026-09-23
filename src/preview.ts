// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Event } from '@vouched-dev/schema';
import { type Paths, paths } from './config.js';
import { type LogPosition, readPending } from './log.js';
import { pendingText } from './sync.js';
import { WIRE_FORM } from './taxonomy.js';

// The pending events exactly as sync would send them. sync signs the JSON
// of each event as it is read from the log, so JSON.stringify of the same
// event is the payload inside the signature, byte for byte.

export type Preview = {
  count: number;
  // Pending events grouped by the day file they are in, in send order.
  groups: { file: string; events: Event[] }[];
  // The last event shown, so a confirmed send stops there. Null when empty.
  last: LogPosition | null;
};

export async function readPreview(p: Paths = paths()): Promise<Preview> {
  const pending = await readPending(Number.POSITIVE_INFINITY, p);
  const groups: Preview['groups'] = [];
  for (const [i, event] of pending.events.entries()) {
    const file = pending.positions[i]?.file ?? '';
    const last = groups.at(-1);
    if (last && last.file === file) last.events.push(event);
    else groups.push({ file, events: [event] });
  }
  return { count: pending.events.length, groups, last: pending.last };
}

// One JSON line per event under the path of its day file, then the count
// and what goes on the wire.
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
