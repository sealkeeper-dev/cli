// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { type GoalResponse, GoalToday } from './responses.js';

// The day's counted tasks against the daily ceiling (VOU-140), from the
// goal answer. On its own so the session nudge reads it without the rest
// of goal.ts.

/*
 * The day's counted tasks (VOU-139), or null when the answer has none or is
 * from another UTC day than now, as a cached answer from before midnight
 * is. A new day starts from nothing, so an old count says nothing about it.
 */
export function todayOf(
  goal: Pick<GoalResponse, 'today'> | null,
  now: Date = new Date(),
): GoalToday | null {
  const parsed = GoalToday.safeParse(goal?.today);
  if (!parsed.success) return null;
  return parsed.data.day === now.toISOString().slice(0, 10)
    ? parsed.data
    : null;
}

// True once the day's counted budget is spent. Tasks still verify, and
// count toward nothing until the next UTC day.
export const dailyCeilingReached = (today: GoalToday | null): boolean =>
  today !== null && today.remaining === 0;

// "Today 14 of 20 counted." and, once the budget is spent, what that means.
export function todayLine(today: GoalToday): string {
  const line = `Today ${today.counted} of ${today.ceiling} counted.`;
  return today.remaining > 0
    ? line
    : `${line} More tasks today still verify but will not move your level.`;
}
