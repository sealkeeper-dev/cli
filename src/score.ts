// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

// How long a read of the agent's standing is fresh, and how long a quick
// read waits for the API. Standing changes when the scoring job runs,
// every fifteen minutes, so a fifteen minute cache is fresh enough. The
// goal cache (goal.ts) and the quick agent reads use them.
export const SCORE_TTL_MS = 15 * 60 * 1000;
export const SCORE_TIMEOUT_MS = 2_000;
