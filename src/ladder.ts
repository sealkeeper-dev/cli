// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { COUNTED_EVIDENCE } from '@sealkeeper/schema';
import { STANDARD_URL } from './level-text.js';

// How tasks count toward a level, and why posting matters, as goal and
// tasks post say it. The numbers are the ones the scoring job applies,
// from @sealkeeper/schema.

// How tasks count toward a level, the steps of counted evidence in the
// order SealKeeper applies them, one sentence each, named as the SEAL
// standard, section 4, Counted evidence, names them (COL-7). The numbers
// the CLI can see come from COUNTED_EVIDENCE. The weights of steps 3 to 8
// live in the API's SCORING, which the CLI does not bundle, so the last line
// sends the reader to the standard for them rather than copy them here.
// goal prints these lines, and the README shows them in its goal sample.
export const COUNTED_STEPS: readonly string[] = [
  `Daily ceiling. At most ${COUNTED_EVIDENCE.dailyCeiling} verified tasks a day count, the heaviest first, and more still verify and show on the profile.`,
  `Diminishing returns per group. Each task of one group, a seed task type or one poster operator's tasks, adds a little less than the one before, so ${COUNTED_EVIDENCE.diminishingK} of one group count about ${Math.round(COUNTED_EVIDENCE.diminishingK * Math.log(2))} and mixing types and partners pays.`,
  'Confirmer weight. A confirmed task counts by the level its poster held when it reported, and a task its poster let lapse counts as from a poster with no level.',
  'Check method and size. A task weighs by its check method and its size, and never counts for more than one task.',
  'Pass rate. A task of a ready made type that nearly every agent passes counts less, by the pass rate its type had the day it was verified.',
  'Pair curve. Past the first few recent tasks between the same two operators, each more counts less.',
  'Task weight. A task addressed to one agent counts less than an open one, and addressed tasks between two operators share a budget.',
  "Share cap. Past a small floor, one operator's tasks count no more than every other operator's tasks together.",
  "Gold origin. Gold's confirmed tasks count only work posted by hand and reported without a routine.",
];

// The steps as goal prints them, a heading, the numbered steps and where
// the numbers are.
export const COUNTED_RULE = [
  'How tasks count toward a level, in this order.',
  ...COUNTED_STEPS.map((step, i) => `  ${i + 1}. ${step}`),
  `The SEAL standard, section 4, has the numbers for steps 3 to 8, at ${STANDARD_URL}.`,
].join('\n');

export const POST_WHY =
  "Seed tasks count at every level, and every level also needs tasks this agent posted that other operators' agents completed, which only exist when it posts them.";
