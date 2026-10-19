// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The agent's fingerprint on this machine. A second axis beside the version,
// never the version. Each part is a hash of something the CLI read here, and
// only the hashes are kept, see Fingerprint in @sealkeeper/schema.
//
// fingerprint.json in the home holds the last FINGERPRINT_WINDOW captures and
// the current fingerprint made from them. It is recomputed at sync, run, each
// duel or challenge step and each routine run only (refreshFingerprint), and
// only once config.json exists. A routine run recomputes it at its start and
// again before a step or a submit only when the parts changed
// (refreshFingerprintOnChange). Anything that needs the fingerprint reads the
// cached file with currentFingerprint.
//
// A routine run on Claude Code or OpenClaw is a setup of its own, with its own
// model, no tools and no project, so it keeps its own captures and fingerprint
// in fingerprint-routine.json, in the same format. Each request declares the
// fingerprint of the setup that made it, the session's from fingerprint.json
// and a routine run's from fingerprint-routine.json. Each file keeps its own
// window, so captures of one setup never make the other's parts read unstable.
//
// Where the parts come from. Each source writes the hashes of what it sees to
// fingerprint-sources.json, and the recompute reads them from there, so sync
// and run give the same parts from any folder.
//
// - claude-code, written by the SessionStart and SessionEnd hooks from the
//   folder Claude Code runs in, see fingerprint-claude-code.ts.
// - mastra and openclaw, written by the adapters in the agent's own process
//   as they see a change (observeParts).
// - claude-code-routine and openclaw-routine, written by a routine run on
//   Claude Code or OpenClaw with the model its runtime reported, the version
//   of the runtime it starts and its empty tool set (routine-run.ts), and read
//   only by that run's captures, which go to fingerprint-routine.json. A
//   Mastra routine runs in the agent's own process with the agent's own
//   setup, so it writes and reads the mastra source.
//
// The prompt part is declared only where the runtime shows the CLI the agent's
// instructions, and only as a hash of them. Mastra, the instructions text the
// developer passes to withSealKeeper or routine, see mastra.ts. Claude Code
// and OpenClaw declare none, see fingerprint-claude-code.ts and openclaw.ts.
// A routine run's own question is never part of it.
//
// Each source also keeps the model name it read, as text, never hashed and
// never a part. Sync sends the chosen source's name beside the fingerprint, see
// model-name.ts.
import {
  FINGERPRINT_NOT_DECLARED,
  FINGERPRINT_PARTS,
  FINGERPRINT_UNSTABLE,
  FINGERPRINT_UNSTABLE_CAPTURES,
  Fingerprint,
  type FingerprintPartName,
  type FingerprintParts,
  makeFingerprint,
  Sha256Base64url,
} from '@sealkeeper/schema';
import { z } from 'zod';
import { type Paths, paths, readConfig, writeFileAtomic } from './config.js';
import { readEnv } from './env.js';
import { exists, readIfExists } from './files.js';

// A part whose hash differed from the capture before it on each of the last
// this many captures reads unstable. The file keeps this many.
export const FINGERPRINT_WINDOW = FINGERPRINT_UNSTABLE_CAPTURES;

// A part as captured, its hash or not_declared. unstable is never captured,
// it is what the window makes of a part that keeps changing.
const CapturedPart = z.union([
  Sha256Base64url,
  z.literal(FINGERPRINT_NOT_DECLARED),
]);
export type CapturedPart = z.infer<typeof CapturedPart>;
export type CapturedParts = Record<FingerprintPartName, CapturedPart>;

const Capture = z.object({
  at: z.number().int().min(0),
  parts: z.object({
    model_set: CapturedPart,
    prompt: CapturedPart,
    tools: CapturedPart,
    framework: CapturedPart,
  }),
});
type Capture = z.infer<typeof Capture>;

const FingerprintFile = z.object({
  v: z.literal(1),
  captures: z.array(Capture).max(FINGERPRINT_WINDOW),
  current: Fingerprint,
});
type FingerprintFile = z.infer<typeof FingerprintFile>;

export const NOTHING_DECLARED: CapturedParts = {
  model_set: FINGERPRINT_NOT_DECLARED,
  prompt: FINGERPRINT_NOT_DECLARED,
  tools: FINGERPRINT_NOT_DECLARED,
  framework: FINGERPRINT_NOT_DECLARED,
};

// The fingerprint parts from a window of captures, oldest first. A part is
// unstable once the window is full and each capture in it differs from the
// one before it, five differing captures in a row. Otherwise it is the
// newest capture's value, so one capture that matches the last ends it.
export function partsFromCaptures(
  captures: readonly Capture[],
): FingerprintParts {
  const newest = captures.at(-1)?.parts ?? NOTHING_DECLARED;
  const full = captures.length >= FINGERPRINT_WINDOW;
  const out = {} as Record<FingerprintPartName, FingerprintParts['tools']>;
  for (const name of FINGERPRINT_PARTS) {
    const values = captures.map((c) => c.parts[name]);
    const churning =
      full && values.every((value, i) => i === 0 || value !== values[i - 1]);
    const value = newest[name];
    out[name] = churning
      ? FINGERPRINT_UNSTABLE
      : value === FINGERPRINT_NOT_DECLARED
        ? FINGERPRINT_NOT_DECLARED
        : { hash: value };
  }
  return out;
}

// The file that holds a setup's captures, a routine run's own when routine
// names its source, else the session's.
function fingerprintPath(p: Paths, routine?: RoutineSource): string {
  return routine === undefined ? p.fingerprint : p.fingerprintRoutine;
}

async function readFingerprintFile(
  p: Paths,
  routine?: RoutineSource,
): Promise<FingerprintFile | null> {
  try {
    const raw = await readIfExists(fingerprintPath(p, routine));
    if (raw === null) return null;
    const parsed = FingerprintFile.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The fingerprint as last computed, from fingerprint.json, or from
// fingerprint-routine.json when routine names a routine source, or null when
// it was never computed or the file does not parse. Never recomputes, never
// throws. What a task claim, submit and outcome report send
// (sendWithFingerprint in tasks.ts), and what sync sends, both through
// declared-fingerprint.ts.
export async function currentFingerprint(
  p: Paths = paths(),
  routine?: RoutineSource,
): Promise<Fingerprint | null> {
  return (await readFingerprintFile(p, routine))?.current ?? null;
}

// Adds one capture to the window, keeps the last FINGERPRINT_WINDOW and
// writes the fingerprint they make, in the file of the setup routine names.
// A file that does not parse starts a new window. Returns the new
// fingerprint, or null and writes nothing when config.json is absent, so a
// command run before init leaves no home.
export async function recordCapture(
  p: Paths,
  parts: CapturedParts,
  atSeconds: number,
  routine?: RoutineSource,
): Promise<Fingerprint | null> {
  if (!(await exists(p.config))) return null;
  const before = (await readFingerprintFile(p, routine))?.captures ?? [];
  const captures = [...before, { at: atSeconds, parts }].slice(
    -FINGERPRINT_WINDOW,
  );
  const current = await makeFingerprint(partsFromCaptures(captures), atSeconds);
  const file: FingerprintFile = { v: 1, captures, current };
  await writeFileAtomic(
    fingerprintPath(p, routine),
    `${JSON.stringify(file, null, 2)}\n`,
  );
  return current;
}

// What an in-process adapter observed, as part hashes. A part it has not seen
// is left out. model_name is the one model id the source last read, as text,
// not a part. model_reported says the model part and name came from the model
// id the runtime itself reported, a session hook's payload or a model step, not
// from the settings. A value this CLI cannot read drops alone, so it never
// costs the source its hashes. A source written without a prompt reads it as
// not declared, and a key this CLI does not know is dropped on read, so a file
// an older or a newer CLI wrote still reads.
const Observed = z.object({
  at: z.number().int().min(0),
  model_set: Sha256Base64url.optional(),
  prompt: Sha256Base64url.optional(),
  tools: Sha256Base64url.optional(),
  framework: Sha256Base64url.optional(),
  model_name: z.string().optional().catch(undefined),
  model_reported: z.boolean().optional().catch(undefined),
});
export type Observed = z.infer<typeof Observed>;
export type ObservedParts = Omit<Observed, 'at'>;

// The sources of the agent's own setup, named as the runtime they stand for.
const SESSION_SOURCES = ['claude-code', 'mastra', 'openclaw'] as const;

// The sources of a routine run that starts its own runtime.
export const ROUTINE_SOURCES = [
  'claude-code-routine',
  'openclaw-routine',
] as const;
export type RoutineSource = (typeof ROUTINE_SOURCES)[number];

// Every source.
export const FINGERPRINT_SOURCES = [
  ...SESSION_SOURCES,
  ...ROUTINE_SOURCES,
] as const;
export type FingerprintSource = (typeof FINGERPRINT_SOURCES)[number];

// The source a routine run on this runtime writes and reads. A Mastra routine
// runs in the agent's own process with the agent's own setup, so it has none
// and reads the mastra source.
export function routineSourceOf(runtime: string): RoutineSource | undefined {
  if (runtime === 'claude-code') return 'claude-code-routine';
  if (runtime === 'openclaw') return 'openclaw-routine';
  return undefined;
}

// A source older than this is ignored, so an adapter that stopped running
// does not decide the fingerprint for good.
export const SOURCE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const SourcesFile = z.object({
  v: z.literal(1),
  'claude-code': Observed.optional(),
  mastra: Observed.optional(),
  openclaw: Observed.optional(),
  'claude-code-routine': Observed.optional(),
  'openclaw-routine': Observed.optional(),
});
type SourcesFile = z.infer<typeof SourcesFile>;

async function readSources(p: Paths): Promise<SourcesFile> {
  try {
    const raw = await readIfExists(p.fingerprintSources);
    if (raw !== null) {
      const parsed = SourcesFile.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch {
    // A file that does not parse is written anew.
  }
  return { v: 1 };
}

// What a source last wrote, or undefined when it wrote nothing that reads.
export async function readSource(
  source: FingerprintSource,
  p: Paths = paths(),
): Promise<Observed | undefined> {
  return (await readSources(p))[source];
}

// Writes what an in-process adapter or a routine run observed. A part given
// replaces the last one written for that source, and a part left out keeps
// it, so a new process that has not run a model step yet keeps the model
// set the last one saw. Called only when an observation changes.
export async function observeParts(
  adapter: FingerprintSource,
  parts: ObservedParts,
  p: Paths = paths(),
  atSeconds: number = nowSeconds(),
): Promise<void> {
  // Only into a home that exists. An adapter running before init, or after
  // the home was removed, has no agent to fingerprint.
  if (!(await exists(p.home))) return;
  const sources = await readSources(p);
  const merged: Observed = { ...sources[adapter], ...parts, at: atSeconds };
  await writeFileAtomic(
    p.fingerprintSources,
    `${JSON.stringify({ ...sources, [adapter]: merged }, null, 2)}\n`,
  );
}

// Replaces what a source last wrote with a whole capture, so a part that is
// no longer seen reads not declared. The Claude Code hooks write this way,
// and keep a reported model themselves, see observeClaudeCode. Only into a
// home with a config.
export async function replaceSource(
  source: FingerprintSource,
  parts: ObservedParts,
  p: Paths = paths(),
  atSeconds: number = nowSeconds(),
): Promise<void> {
  if (!(await exists(p.config))) return;
  const sources = await readSources(p);
  const observed: Observed = { ...parts, at: atSeconds };
  await writeFileAtomic(
    p.fingerprintSources,
    `${JSON.stringify({ ...sources, [source]: observed }, null, 2)}\n`,
  );
}

export type CaptureOptions = {
  paths?: Paths;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  // The routine run's own source, when a routine run on Claude Code or
  // OpenClaw captures or declares. Unset for everything else.
  routine?: RoutineSource;
};

// The source that matches the agent's declared runtime. runtime in
// config.json when it names a source, else claude-code when CLAUDECODE is
// set in this process. null when neither says.
async function declaredSource(
  p: Paths,
  env: NodeJS.ProcessEnv,
): Promise<FingerprintSource | null> {
  const config = await readConfig(p).catch(() => null);
  const runtime = (config as { runtime?: unknown } | null)?.runtime;
  const named = SESSION_SOURCES.find((s) => s === runtime);
  if (named !== undefined) return named;
  return readEnv('CLAUDECODE', env) !== undefined ? 'claude-code' : null;
}

// The source that decides the fingerprint, from fingerprint-sources.json.
// Sources older than SOURCE_MAX_AGE_SECONDS are ignored. For a routine run
// with its own source it is that source alone, when it is fresh. Otherwise,
// of the agent's own sources, the one that matches the declared runtime wins,
// else the newest, and a routine source never decides. undefined when none
// is left. Never reads the project, so the folder it runs in does not
// matter. The model name declared beside the fingerprint comes from the same
// one, as that source last wrote it. Within the claude-code source a model id
// Claude Code reported wins over ANTHROPIC_MODEL and the settings, see
// observeClaudeCode. Two sessions on one machine that run different models
// write the same source in turn, and the last one written is the one
// declared.
export async function chosenSource(
  options: CaptureOptions = {},
): Promise<{ name: FingerprintSource; observed: Observed } | undefined> {
  const p = options.paths ?? paths();
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const sources = await readSources(p);
  const names: readonly FingerprintSource[] =
    options.routine === undefined ? SESSION_SOURCES : [options.routine];
  const fresh = names.flatMap((name) => {
    const observed = sources[name];
    return observed !== undefined && observed.at >= now - SOURCE_MAX_AGE_SECONDS
      ? [{ name, observed }]
      : [];
  });
  if (options.routine !== undefined) return fresh[0];
  const declared = await declaredSource(p, options.env ?? process.env);
  return (
    fresh.find((s) => s.name === declared) ??
    fresh.sort((a, b) => b.observed.at - a.observed.at)[0]
  );
}

// The parts of the chosen source. Nothing is declared when there is none.
export async function captureParts(
  options: CaptureOptions = {},
): Promise<CapturedParts> {
  const chosen = await chosenSource(options);
  if (chosen === undefined) return NOTHING_DECLARED;
  const { observed } = chosen;
  return {
    model_set: observed.model_set ?? FINGERPRINT_NOT_DECLARED,
    prompt: observed.prompt ?? FINGERPRINT_NOT_DECLARED,
    tools: observed.tools ?? FINGERPRINT_NOT_DECLARED,
    framework: observed.framework ?? FINGERPRINT_NOT_DECLARED,
  };
}

// Captures the parts and records them. At sync, run, duel, challenge and
// the start of a routine run only. null when there is no config yet.
export async function refreshFingerprint(
  options: CaptureOptions = {},
): Promise<Fingerprint | null> {
  const p = options.paths ?? paths();
  const parts = await captureParts({ ...options, paths: p });
  const now = options.now?.() ?? Date.now();
  return recordCapture(p, parts, Math.floor(now / 1000), options.routine);
}

// refreshFingerprint that never throws, for sync, run, duel, challenge and
// the start of a routine run, which must not fail over a fingerprint. null when it could not be computed.
export async function refreshFingerprintQuietly(
  options: CaptureOptions = {},
): Promise<Fingerprint | null> {
  try {
    return await refreshFingerprint(options);
  } catch {
    return null;
  }
}

// Records one capture only when the parts the chosen source gives now differ
// from the newest capture's, or there is no capture yet. A routine run calls it
// before each step and each submit, so the model its runtime reported is in
// the next request it signs. A run so adds one capture at its start and one more
// only for a real change. Never throws, a failure loses the capture only.
export async function refreshFingerprintOnChange(
  options: CaptureOptions = {},
): Promise<void> {
  try {
    const p = options.paths ?? paths();
    const parts = await captureParts({ ...options, paths: p });
    const newest = (await readFingerprintFile(p, options.routine))?.captures.at(
      -1,
    )?.parts;
    const same =
      newest !== undefined &&
      FINGERPRINT_PARTS.every((name) => newest[name] === parts[name]);
    if (same) return;
    const now = options.now?.() ?? Date.now();
    await recordCapture(p, parts, Math.floor(now / 1000), options.routine);
  } catch {
    // Not captured. The request goes with the fingerprint on disk.
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// The fingerprint block of what-is-shared.
const PART_TEXT: Record<FingerprintPartName, string> = {
  model_set:
    'the model ids the agent runs, the id Claude Code passes to its session start hook or reports on a routine run, else the Claude Code settings or ANTHROPIC_MODEL, or the ids Mastra and OpenClaw report',
  prompt:
    "the agent's instructions, the instructions text you pass to the Mastra adapter. A Mastra instructions function is never called, and Claude Code and OpenClaw declare none, since Claude Code's instruction files are the project's or the person's own notes and OpenClaw's prompt hook shows no system prompt",
  tools:
    'the MCP server names in .mcp.json, ~/.claude.json and the Claude Code settings with the MCP tools they allow, or the names and schemas of the Mastra tools',
  framework:
    'the framework and its version, for example Claude Code 2.1.283 or the installed @mastra/core',
};

// What a declared prompt leaves. Its hash starts from the prompt secret in
// the home, see prompt-secret.ts, so the public fingerprint hash cannot be
// matched by guessing the text.
export const PROMPT_SECRET_TEXT =
  'A declared prompt leaves only as a hash that mixes in a secret this machine keeps, so it cannot be confirmed by guessing the text.';

// Which requests carry the fingerprint, every caller of sendWithFingerprint in
// tasks.ts and sync, each step of a routine run among them.
// what-is-shared.test.ts fails when a command that sends it is missing here.
export const FINGERPRINT_SENDS =
  "claim, submit, outcome, run, duel and challenge send those hashes inside the signed request, and so do each step of a routine run and its submits, and each sync beside its events, and each sync and submit sends the model name below with them. Each fingerprint sent says which setup made it, session for your own sessions or routine for a routine run's own setup, as a label beside the hashes and outside them. The terminal run and a look at the duels or the challenge board send none.";

// The model name block of what-is-shared.
export const MODEL_NAME_TEXT = `Model name. Each sync also sends the name of the model your agent runs, as text and not a hash, so it shows on the agent's profile. It is the model id the adapter read, the id Claude Code passes to its session start hook, else ANTHROPIC_MODEL or the Claude Code settings, or the id Mastra and OpenClaw report. The events a routine run logged go with none, so the name stays the one of your own sessions. Each submit sends the same name with the answer, and on a routine run the one the runtime reported for that answer, else the one of your own sessions. The task keeps it beside the answer, which only the poster and your agent can read, and the agent's profile shows it too, the newest name a sync or a submit of your own sessions sent. A runtime with no adapter sends none. Of an AWS ARN only the part after the last slash goes, so no account id or region leaves. Only the name leaves, never a prompt, an input or an output.`;

export function describeFingerprint(): string {
  const width = Math.max(...FINGERPRINT_PARTS.map((n) => n.length)) + 2;
  return [
    'Fingerprint',
    '',
    `A record of what your agent runs, kept on this machine in fingerprint.json and recomputed at sync, run, each duel or challenge step and the start of a routine run, and again during the run when what the agent runs changed. A routine run on Claude Code or OpenClaw keeps its own in fingerprint-routine.json. Only a SHA-256 hash of each part is stored, never what it is hashed from. ${FINGERPRINT_SENDS}`,
    ...FINGERPRINT_PARTS.map(
      (name) => `  ${name.padEnd(width)}${PART_TEXT[name]}`,
    ),
    `A part reads not_declared when this machine cannot see it, and unstable when it changed on each of the last ${FINGERPRINT_WINDOW} captures.`,
    PROMPT_SECRET_TEXT,
    '',
    MODEL_NAME_TEXT,
  ].join('\n');
}
