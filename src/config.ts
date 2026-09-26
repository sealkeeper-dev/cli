// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentId, agentHandle } from '@sealkeeper/schema';
import { z } from 'zod';
import { readEnv } from './env.js';
import { exists, readIfExists } from './files.js';

export const DEFAULT_API_URL = 'https://api.sealkeeper.run';
// The agent version init registers when --version is not given. emit also
// uses it when there is no config yet.
export const DEFAULT_AGENT_VERSION = '0.1.0';
const PROFILE_BASE_URL = 'https://sealkeeper.run/agents';
// The API gets the GitHub token at registration and every signed request, so
// it must be https. Plain http is allowed only to this machine, for a local
// API during development.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isSecureApiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))
  );
}

export const INSECURE_API_URL =
  'expected an https URL, or http only to localhost';

type Named = { operatorLogin: string; name: string };

// The agent's handle, login/name. The API sends it with every answer. The
// CLI builds its own only from config, for status and whoami, which work
// offline.
export function handleOf(config: Named): string {
  return agentHandle(config.operatorLogin, config.name);
}

// The public profile page, at the handle.
export function profileUrl(config: Named): string {
  return `${PROFILE_BASE_URL}/${handleOf(config)}`;
}

// The profile by agent id. It redirects to the handle and never changes, so
// the signed agent card links it.
export function idProfileUrl(agentId: string): string {
  return `${PROFILE_BASE_URL}/${agentId}`;
}

// The guardrails of sealkeeper routine (VOU-138). Set at routine install
// with these defaults and changed with config routine set. Caps count per
// UTC day from routine.jsonl. tokensPerRun counts what the headless agent
// reports, see routine-agent.ts. A routine run never posts tasks, so there
// is no post limit.
export const ROUTINE_LIMIT_DEFAULTS = {
  claimsPerDay: 10,
  confirmsPerDay: 10,
  minutesPerRun: 15,
  tokensPerRun: 300_000,
} as const;

// The largest value each limit takes. A limit of 0 turns that kind of work
// off for routine runs.
export const ROUTINE_LIMIT_MAX = {
  claimsPerDay: 100,
  confirmsPerDay: 100,
  minutesPerRun: 120,
  tokensPerRun: 10_000_000,
} as const;

export type RoutineLimitName = keyof typeof ROUTINE_LIMIT_DEFAULTS;

const limit = (name: RoutineLimitName, min = 0) =>
  z
    .number()
    .int()
    .min(min)
    .max(ROUTINE_LIMIT_MAX[name])
    .default(ROUTINE_LIMIT_DEFAULTS[name]);

// z.object drops keys it does not know, such as postsPerDay from the first
// routine release, and a missing limit reads as its default.
export const RoutineLimits = z.object({
  claimsPerDay: limit('claimsPerDay'),
  confirmsPerDay: limit('confirmsPerDay'),
  minutesPerRun: limit('minutesPerRun', 1),
  tokensPerRun: limit('tokensPerRun', 1_000),
});
export type RoutineLimits = z.infer<typeof RoutineLimits>;

export const SCHEDULERS = ['launchd', 'systemd', 'cron', 'schtasks'] as const;
export type SchedulerKind = (typeof SCHEDULERS)[number];

// What routine install wrote, so remove takes out exactly that. job is the
// launchd label, the systemd unit name, the cron block id or the Task
// Scheduler task name. files are the files it wrote.
export const RoutineSchedule = z.object({
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  scheduler: z.enum(SCHEDULERS),
  agent: z.literal('claude-code'),
  agentCommand: z.string().min(1),
  job: z.string().min(1),
  files: z.array(z.string()),
  installedAt: z.iso.datetime({ offset: true }),
});
export type RoutineSchedule = z.infer<typeof RoutineSchedule>;

// routine.json, next to config.json. Absent until routine install or
// config routine, and then read as the defaults.
export const RoutineConfig = z.object({
  limits: RoutineLimits.default(() => ({ ...ROUTINE_LIMIT_DEFAULTS })),
  // GitHub logins, lower case, whose addressed tasks and counterparty
  // submissions a routine run may take without a person.
  allow: z.array(z.string().min(1)).default(() => []),
  schedule: RoutineSchedule.optional(),
  // Set by routine pause, or by a third failed run in a row. Runs do
  // nothing until routine resume.
  paused: z
    .object({
      at: z.iso.datetime({ offset: true }),
      reason: z.string().min(1),
    })
    .optional(),
});
export type RoutineConfig = z.infer<typeof RoutineConfig>;

export function defaultRoutineConfig(): RoutineConfig {
  return { limits: { ...ROUTINE_LIMIT_DEFAULTS }, allow: [] };
}

// config.json. Read loosely, so a key a newer CLI wrote is kept, and
// written back with it. CLI 0.4.4 and earlier read this file strictly and
// fail on any key they do not know, and adapters pinned to them would drop
// every event, so settings added since then live in files of their own,
// nudge.json and routine.json, which those versions never read.
export const Config = z.looseObject({
  agentId: AgentId,
  operatorLogin: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  apiUrl: z
    .url({ protocol: /^https?$/ })
    .refine(isSecureApiUrl, INSECURE_API_URL)
    .default(DEFAULT_API_URL),
  registeredAt: z.iso.datetime({ offset: true }),
  // Whether emit and the hook adapters send events on their own. Unset
  // means no sync has been confirmed yet, and the first confirmed sync turns
  // it on. false means the operator turned it off with config auto-sync
  // off, so every sync previews and asks and it stays off. Only true sends
  // on its own. A config written before this field existed reads as unset.
  autoSync: z.boolean().optional(),
});
export type Config = z.infer<typeof Config>;
type ConfigInput = z.input<typeof Config>;

// Keys an earlier build of this release wrote to config.json, which now
// live in their own files. readConfig moves them out once.
const MOVED_KEYS = ['nudge', 'routine'] as const;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type Paths = {
  home: string;
  config: string;
  key: string;
  log: string;
  cursor: string;
  credential: string;
  // The SealKeeper public keys seal verify last fetched, with the fetch time.
  wellKnown: string;
  score: string;
  // How many tasks wait for this agent, a fifteen minute cache like score.
  inbox: string;
  // When prove last offered to post a task, so it asks at most once a week.
  postPrompt: string;
  // Start time markers for hook adapters, one small file per session or tool
  // call, so a later hook can compute a duration.
  sessions: string;
  // The goal answer, a cache the session nudge reads, see goal.ts.
  goal: string;
  // Whether the session nudge is on, see nudge.ts.
  nudge: string;
  // The routine's limits, allowlist, schedule and pause, see routine.ts.
  routine: string;
  logFile(day: string): string;
};

const HOME_DIR_NAME = '.sealkeeper';

// SEALKEEPER_HOME wins so tests and multiple agents on one machine can each
// have their own directory. The default is ~/.sealkeeper.
export function sealkeeperHome(env: NodeJS.ProcessEnv = process.env): string {
  return readEnv('SEALKEEPER_HOME', env) ?? join(homedir(), HOME_DIR_NAME);
}

// The only place file paths under the SealKeeper home are built.
export function paths(home: string = sealkeeperHome()): Paths {
  const log = join(home, 'log');
  return {
    home,
    config: join(home, 'config.json'),
    key: join(home, 'key'),
    log,
    cursor: join(home, 'cursor.json'),
    credential: join(home, 'credential.json'),
    wellKnown: join(home, 'well-known.json'),
    score: join(home, 'score.json'),
    inbox: join(home, 'inbox.json'),
    postPrompt: join(home, 'post-prompt.json'),
    sessions: join(home, 'sessions'),
    goal: join(home, 'goal.json'),
    nudge: join(home, 'nudge.json'),
    routine: join(home, 'routine.json'),
    logFile: (day) => join(log, `${day}.jsonl`),
  };
}

// Creates the home directory if needed and makes sure only the owner can read
// it, since it holds the private key.
export async function ensureHome(p: Paths = paths()): Promise<void> {
  await mkdir(p.home, { recursive: true, mode: 0o700 });
  await chmod(p.home, 0o700);
}

// Returns null when there is no config yet. Throws ConfigError when the file
// exists but is not valid JSON or does not match the schema. Keys this
// version does not know are kept. A nudge or routine key an earlier build
// wrote is moved to its own file first, see moveSettings.
export async function readConfig(p: Paths = paths()): Promise<Config | null> {
  const raw = await readIfExists(p.config);
  if (raw === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Invalid config at ${p.config}: not valid JSON`);
  }

  const result = Config.safeParse(json);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config at ${p.config}:\n${z.prettifyError(result.error)}`,
    );
  }
  return moveSettings(result.data, p);
}

// Validates, then writes config.json atomically. Keys the config was read
// with are kept, except nudge and routine, which move to their own files
// first, see moveOut. A key whose file could not be written stays, so it
// is never lost.
export async function writeConfig(
  input: ConfigInput,
  p: Paths = paths(),
): Promise<Config> {
  await ensureHome(p);
  const config = await moveOut(Config.parse(input), p);
  await writeFileAtomic(p.config, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

// Where each key that lives in a file of its own goes.
const MOVED_FILE = {
  nudge: (p: Paths) => p.nudge,
  routine: (p: Paths) => p.routine,
} as const satisfies Record<(typeof MOVED_KEYS)[number], (p: Paths) => string>;

// Writes nudge and routine from config to nudge.json and routine.json,
// each created exclusively, so a file already there always wins. The
// routine goes as it was, and readRoutineConfig says what is wrong with it
// when it does not read. Returns the config without the keys whose file
// now exists. A key whose file could not be written is kept.
async function moveOut(config: Config, p: Paths): Promise<Config> {
  const out: Config = { ...config };
  for (const key of MOVED_KEYS) {
    if (!(key in out)) continue;
    const file = MOVED_FILE[key](p);
    const value = key === 'nudge' ? { on: out.nudge } : out.routine;
    const valid = key !== 'nudge' || typeof out.nudge === 'boolean';
    try {
      if (valid && !(await exists(file))) {
        await createFile(file, `${JSON.stringify(value, null, 2)}\n`);
      }
    } catch {
      // Kept in config.json, and the next read tries again.
    }
    if (!valid || (await exists(file))) delete out[key];
  }
  return out;
}

// Creates file with mode 600, failing when it is already there. Another
// process that wrote it first wins.
async function createFile(file: string, text: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// The one time move of nudge and routine out of config.json, for a home an
// earlier build of this release wrote. config.json is rewritten only after
// the new files are in place, and a key that could not move stays where it
// was, so nothing is lost and the next read tries again.
async function moveSettings(config: Config, p: Paths): Promise<Config> {
  if (!MOVED_KEYS.some((key) => key in config)) return config;
  try {
    const moved = await moveOut(config, p);
    if (MOVED_KEYS.every((key) => key in moved)) return config;
    await writeFileAtomic(p.config, `${JSON.stringify(moved, null, 2)}\n`);
    return moved;
  } catch {
    return config;
  }
}

const NudgeFile = z.looseObject({ on: z.boolean() });

// Whether the session nudge is on, from nudge.json. undefined when the
// operator was never asked, or the file does not read.
export async function readNudge(
  p: Paths = paths(),
): Promise<boolean | undefined> {
  try {
    const raw = await readIfExists(p.nudge);
    if (raw === null) return undefined;
    const parsed = NudgeFile.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.on : undefined;
  } catch {
    return undefined;
  }
}

export async function writeNudge(
  on: boolean,
  p: Paths = paths(),
): Promise<void> {
  await ensureHome(p);
  await writeFileAtomic(p.nudge, `${JSON.stringify({ on })}\n`);
}

// The routine settings from routine.json, or the defaults when there is
// none. Throws ConfigError when the file is there and does not read, so a
// broken file never reads as an empty allowlist or the default limits.
export async function readRoutineConfig(
  p: Paths = paths(),
): Promise<RoutineConfig> {
  const raw = await readIfExists(p.routine);
  if (raw === null) return defaultRoutineConfig();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `Invalid routine settings at ${p.routine}: not valid JSON`,
    );
  }
  const result = RoutineConfig.safeParse(json);
  if (!result.success) {
    throw new ConfigError(
      `Invalid routine settings at ${p.routine}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export async function writeRoutineConfig(
  routine: RoutineConfig,
  p: Paths = paths(),
): Promise<RoutineConfig> {
  const parsed = RoutineConfig.parse(routine);
  await ensureHome(p);
  await writeFileAtomic(p.routine, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

// Writes to a temp file in the same directory with mode 600 (or the given
// mode), syncs it and renames it over the target, so a crash never leaves a
// half written file.
export async function writeFileAtomic(
  target: string,
  text: string,
  mode = 0o600,
): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', mode);
    try {
      await file.chmod(mode);
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
