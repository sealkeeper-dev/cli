// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

// How long a cached read of the agent's standing is fresh, and how long a quick
// read waits for the API. The goal cache (goal.ts) and the quick agent reads
// use them.
export const SCORE_TTL_MS = 15 * 60 * 1000;
export const SCORE_TIMEOUT_MS = 2_000;
