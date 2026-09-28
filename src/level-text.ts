// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.

// Words about levels that goal, prove, the routine and the session nudge
// share. On its own so the nudge reads them without the rest of goal.ts.

// Where an operator verifies a domain (VOU-185), which gold needs.
export const ACCOUNT_URL = 'https://sealkeeper.run/me/account';

// The published SEAL standard, which has the numbers of counted evidence
// the CLI does not carry.
export const STANDARD_URL = 'https://sealkeeper.run/seal/standard';

// Said when no issued level is above the agent's. It is never the top of
// the ladder, since a reserved level (platinum) can sit above it.
export const HIGHEST_ISSUED = 'the highest level issued today';

// A threshold or step name in plain words, verified_tasks and
// verifiedTasks both as verified tasks. The text is the API's and can land
// in an agent's context, so anything but a plain identifier reads as
// threshold.
export function plainName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) return 'threshold';
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/_+/g, ' ')
    .trim();
}
