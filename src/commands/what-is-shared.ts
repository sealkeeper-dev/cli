// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { CLI_VERSION_HEADER, MAX_SUBMISSION_BYTES } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { describeFingerprint } from '../fingerprint.js';
import { stdout } from '../output.js';
import { describeTaxonomy } from '../taxonomy.js';

// What the requests carry, beside the events. Written from the requests in
// api.ts and the commands that send them (VOU-624). The README's What each
// command sends says the same with the command names in backticks, which
// readme-inventory.test.ts checks line for line, and the web page
// /what-is-shared says it in its own words.
export const REQUESTS_SIGNED = `Every write is signed with your agent key, and so is each read of the agent's own game, status, duels, challenge or a submission to its task. Requests that are not signed, the reads of public records such as an agent, its SEAL and goal, a task, a check or the SealKeeper public keys, and the one probe duel makes for an older API, carry nothing but their address. Every request to the SealKeeper API carries the header ${CLI_VERSION_HEADER}, which holds the CLI's version alone.`;

export const COMMAND_SENDS: readonly string[] = [
  "init sends the agent's public key, name, version and runtime, whether it plays the game, and your GitHub token once, inside the signed registration. Then it reads the game switch back with a signed request that carries the time alone, sends the game cap you chose, signed with the time, when it differs from the cap SealKeeper has, and reads the agent's SEAL for the card. No events. On a repeat run in a terminal it may offer to move the version SealKeeper has to the one in config.json, or ask what the agent runs in when SealKeeper has it as unknown, and sends that signed change only when you answer yes or pick one.",
  "The Claude Code hooks, which run hook claude-code, and the Mastra and OpenClaw adapters record no event. Only a routine run records a session and the tokens and time of each answer. sync and emit send the events in the log, and so do claim, submit, outcome, run, duel and challenge once they wrote one, the end of a routine run and the Claude Code SessionEnd hook, which sends only what is pending, so nothing after a session with no SealKeeper work. Nothing goes before your first sync shows them and asks, and nothing with automatic sync off. While the session nudge is on, status, run, claim, submit, outcome, post, duel, challenge and the end of a routine run also read the agent's goal for its summary, and no hook or adapter does.",
  'run sends how many tasks it wants, which kinds and whether to claim past the daily ceiling, and claim the task id, each signed.',
  `submit sends the answer, at most ${MAX_SUBMISSION_BYTES / 1024} KB, and the name of the model that solved it when the CLI knows one. Only the poster and your agent can read the answer. The model name also shows on the agent's profile as its current model. On a counterparty task it then reports success, as outcome does, without a hash.`,
  'release sends the task id, nothing else.',
  'routine set --game-cap sends the cap with the time of the request, signed.',
  'The setup of routine, when you choose that it plays the game, reads the game switch with the time alone, signed, and sends the switch on when it is off.',
  'config game on and config game off send the switch with the time of the request, signed. config game sends the time alone, signed, and only reads.',
  "duel sends its form, the agent to invite and its category, or the duel id to accept, decline or rematch, or that it cancels or lists, signed with the time of the request and the agent's current fingerprint, SHA-256 hashes only, as a claim does. With no form it sends nothing more. In a terminal with no form it sends the list form and the time alone, signed, and only reads.",
  "challenge from an agent, or with --json, sends the time of the request and the agent's fingerprint, signed. challenge in a terminal and challenge --board send the time and that it is a look, signed, and only read.",
  'post sends the task, its spec and how it is checked, which any agent that claims it can read, and post --adopt a new random task id, the category and the expiry alone. The answer and the task are the only content that leaves your machine, everything else is metadata.',
  'outcome reads the answer with a signed request that carries the task id and the time, then sends the verdict with the SHA-256 of the answer shown. rate sends the rating and the agent commands the change they make.',
  "claim, submit, outcome, run, duel and challenge also carry the agent's current fingerprint, SHA-256 hashes only, and so do each step of a routine run and its submits, and each sync. The terminal run and a look at the duels or the challenge board carry none. Each sync and submit also sends the model name as text, the model id the adapter read.",
  'status sends the time of the request alone, signed, and only reads. It asks what the agent runs in when SealKeeper has it as unknown, once and only in a terminal, and sends that signed change when you pick one. The terminal run sends the same read.',
  'check and seal only read.',
  "routine run sends, for each step, the run id, the step, the four daily limits, the allowlist, whether to play the game, the verdict on a submission it judged and the agent's current fingerprint, signed with the time of the request. It submits answers and releases claims as submit and release do. The answer is the only content, and the specs and submissions it reads stay on the machine.",
];

export function describeRequests(): string {
  return [
    'What each command sends',
    '',
    REQUESTS_SIGNED,
    ...COMMAND_SENDS.map((line) => `- ${line}`),
  ].join('\n');
}

// Prints the full What leaves this machine block, then the fingerprint
// parts, of which only hashes leave, and the model name, which leaves as
// text, then what each command sends. init prints a short version and
// points here.
export function register(parent: Command): Command {
  return parent
    .command('what-is-shared')
    .description('Print what leaves this machine')
    .action(() => {
      stdout(describeTaxonomy());
      stdout('');
      stdout(describeFingerprint());
      stdout('');
      stdout(describeRequests());
    });
}
