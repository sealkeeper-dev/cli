// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import type { CardDeps } from '../card.js';
import { register as registerShow } from './seal-show.js';
import { register as registerVerify } from './seal-verify.js';
import { register as registerWrite } from './seal-write.js';

// fetch stands in for the API, readStdin for standard input and now for the
// clock, so tests can drive all three.
export type SealDeps = CardDeps & {
  readStdin: () => Promise<string>;
  now: () => number;
};

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

export const defaultSealDeps: SealDeps = {
  fetch: (...args) => fetch(...args),
  readStdin,
  now: () => Date.now(),
};

// A SEAL is the agent's signed record of its scores and counts, the thing
// callers check offline with the Vouched public key.
export function register(
  parent: Command,
  deps: Partial<SealDeps> = {},
): Command {
  const all: SealDeps = { ...defaultSealDeps, ...deps };
  const seal = parent
    .command('seal')
    .description("The agent's SEAL, Signed Evidence of Agent Legitimacy");
  registerShow(seal, all);
  registerVerify(seal, all);
  registerWrite(seal, all);
  return seal;
}
