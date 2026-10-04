// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AgentId,
  AgentName,
  agentHandle,
  ROUTINE_LIMIT_DEFAULTS,
  ROUTINE_LIMIT_MAX,
  type RoutineLimitName,
} from '@sealkeeper/schema';
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

// The agent's handle, slug/name. The API sends it with every answer. The
// CLI builds its own for status and the other commands that work
// offline, from the operator slug the API last sent, see operator-slug.ts.
// The login stands in only while no slug is known.
export function handleOf(config: Named, slug?: string | null): string {
  return agentHandle(slug ?? config.operatorLogin, config.name);
}

// The public profile page, at the handle.
export function profileUrl(config: Named, slug?: string | null): string {
  return handleUrl(handleOf(config, slug));
}

// The public profile page at a handle as the API sent it.
export function handleUrl(handle: string): string {
  return `${PROFILE_BASE_URL}/${handle}`;
}

// The profile by agent id. It redirects to the handle and never changes, so
// the signed agent card links it.
export function idProfileUrl(agentId: string): string {
  return `${PROFILE_BASE_URL}/${agentId}`;
}

// The guardrails of sealkeeper routine (VOU-138). Set with the defaults
// and changed with routine set. The defaults and the largest values live in
// @sealkeeper/schema (routine.ts), which the API's routine route reads them
// from too (VOU-594). The four daily limits go to the API with every call
// of a run, which counts the day from its own records. minutesPerRun and
// tokensPerRun hold the agent on this machine, tokensPerRun counting what
// the agent reports, see routine-agent.ts. A limit of 0 turns that kind of
// work off for routine runs.
export { ROUTINE_LIMIT_DEFAULTS, ROUTINE_LIMIT_MAX, type RoutineLimitName };

// The smallest value each limit takes here. A run needs a minute and a
// thousand tokens to answer anything.
export const ROUTINE_LIMIT_MIN: Record<RoutineLimitName, number> = {
  claimsPerDay: 0,
  networkClaimsPerDay: 0,
  confirmsPerDay: 0,
  postsPerDay: 0,
  minutesPerRun: 1,
  tokensPerRun: 1_000,
};

const limit = (name: RoutineLimitName) =>
  z
    .number()
    .int()
    .min(ROUTINE_LIMIT_MIN[name])
    .max(ROUTINE_LIMIT_MAX[name])
    .default(ROUTINE_LIMIT_DEFAULTS[name]);

// z.object drops keys it does not know, and a missing limit reads as its
// default. postsPerDay was dropped after an unreleased first build and is
// back since POST-7, so a routine.json written in between reads it as 3.
export const RoutineLimits = z.object({
  claimsPerDay: limit('claimsPerDay'),
  networkClaimsPerDay: limit('networkClaimsPerDay'),
  confirmsPerDay: limit('confirmsPerDay'),
  postsPerDay: limit('postsPerDay'),
  minutesPerRun: limit('minutesPerRun'),
  tokensPerRun: limit('tokensPerRun'),
});
export type RoutineLimits = z.infer<typeof RoutineLimits>;

export const SCHEDULERS = ['launchd', 'systemd', 'cron', 'schtasks'] as const;
export type SchedulerKind = (typeof SCHEDULERS)[number];

// The agents the routine's job can start, found on PATH as claude and
// openclaw (VOU-601). A Mastra routine runs in the operator's own process
// and has no job.
export const SCHEDULED_AGENTS = ['claude-code', 'openclaw'] as const;
export type ScheduledAgent = (typeof SCHEDULED_AGENTS)[number];

// The model an OpenClaw routine names on every question (VOU-623), a model
// ref as OpenClaw writes one, provider/model, such as
// google/gemini-3-flash-preview. The model part may hold more slashes, as
// an OpenRouter ref does. Every part starts with a letter or a digit, so it
// never reads as a flag, and the set has no space, quote or shell character.
// The one check, for the setup, routine set and the run alike, which pass
// it to openclaw as its own argument after --model, never through a shell.
export const OPENCLAW_MODEL_MAX = 128;
const MODEL_PART = '[A-Za-z0-9][A-Za-z0-9._:@+-]*';
const OPENCLAW_MODEL = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]*/${MODEL_PART}(?:/${MODEL_PART})*$`,
);
export const OpenClawModel = z
  .string()
  .max(OPENCLAW_MODEL_MAX)
  .regex(OPENCLAW_MODEL);

// value as an OpenClaw model, or null when it is not one.
export function openclawModelOf(value: unknown): string | null {
  const parsed = OpenClawModel.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// What routine on wrote, so off takes out exactly that. job is the
// launchd label, the systemd unit name, the cron block id or the Task
// Scheduler task name. files are the files it wrote.
// A local time of day on a 24 hour clock, HH:MM.
export const ROUTINE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const RoutineSchedule = z.object({
  time: z.string().regex(ROUTINE_TIME),
  scheduler: z.enum(SCHEDULERS),
  // A CLI from before VOU-601 reads only claude-code here.
  agent: z.enum(SCHEDULED_AGENTS),
  agentCommand: z.string().min(1),
  job: z.string().min(1),
  files: z.array(z.string()),
  installedAt: z.iso.datetime({ offset: true }),
  // What the job runs, node, the script and routine run. Since RS-2 the
  // script is the copy under <home>/routine. Absent for a job an earlier
  // CLI installed.
  program: z.array(z.string()).optional(),
});
export type RoutineSchedule = z.infer<typeof RoutineSchedule>;

// routine.json, next to config.json. Absent until the routine is set up or
// set, and then read as the defaults.
export const RoutineConfig = z.object({
  limits: RoutineLimits.default(() => ({ ...ROUTINE_LIMIT_DEFAULTS })),
  // The operators whose addressed tasks and counterparty submissions a
  // routine run may take without a person, sent to the API with every
  // call, which matches them. allow holds GitHub logins, lower case, added
  // by CLI 0.4.8 and earlier, and the API still matches them by login
  // only. allowSlugs holds operator slugs, added since VOU-196, matched by
  // slug. Two keys, so a CLI from before VOU-196 that reads this file never
  // takes a slug for a login. A slug is chosen on the web and freed 90 days
  // after a change, so a login entry matched by slug would let whoever
  // takes that slug in. Those CLIs drop allowSlugs when they write the
  // file, which leaves fewer operators allowed, never more.
  allow: z.array(z.string().min(1)).default(() => []),
  allowSlugs: z.array(z.string().min(1)).default(() => []),
  // The local time the job runs at. routine set --time changes it and
  // writes an installed job again. A file from before VOU-599 reads it
  // from its schedule, see readRoutineConfig. Absent until a time is set
  // or a job is written, and a new routine then takes the local time of
  // its setup, so routines spread over the day (VOU-612).
  time: z.string().regex(ROUTINE_TIME).optional(),
  // Whether a run plays the game after its task work (VOU-599), sent to
  // the API as game with every call. false is tasks only. The game is
  // played only while it is on for the agent, which a routine never turns
  // on.
  game: z.boolean().default(false),
  // The model the OpenClaw routine names, set by the setup, routine on or
  // routine set --model. Absent in a file from before VOU-623, and then an
  // OpenClaw run fails before its first step until one is set.
  model: OpenClawModel.optional(),
  // The job routine on wrote, absent while the routine is off.
  schedule: RoutineSchedule.optional(),
  // Written by routine pause of CLI 0.4.14 and earlier, or by a third
  // failed run in a row there. A routine that has it runs nothing, as it
  // did, until routine on or off clears it.
  paused: z
    .object({
      at: z.iso.datetime({ offset: true }),
      reason: z.string().min(1),
    })
    .optional(),
});
export type RoutineConfig = z.infer<typeof RoutineConfig>;

export function defaultRoutineConfig(): RoutineConfig {
  return RoutineConfig.parse({});
}

// config.json. Read loosely, so a key a newer CLI wrote is kept, and
// written back with it. CLI 0.4.4 and earlier read this file strictly and
// fail on any key they do not know, and adapters pinned to them would drop
// every event, so settings added since then live in files of their own,
// nudge.json, routine.json and operator-slug.json, which those versions
// never read.
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

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Files older CLIs kept in the SealKeeper home and nothing writes now.
// post-prompt.json was prove's weekly offer to post, CLI 0.4.14 and
// earlier. score.json and inbox.json were the scores and the addressed
// task count the status of CLI 0.4.14 and earlier cached, before status
// read the status route (VOU-596). routine-claim.lock, routine-confirm.lock
// and routine-post.lock held a routine run's claims, reports and posts to
// its daily limits on this machine, until the API took the limits over
// (VOU-599). logout and agent delete still remove them, so a named home
// ends up empty. They can go once no such CLI is in use.
export const LEGACY_FILES = [
  'post-prompt.json',
  'score.json',
  'inbox.json',
  'routine-claim.lock',
  'routine-confirm.lock',
  'routine-post.lock',
  'model.json',
] as const;

export type Paths = {
  home: string;
  config: string;
  key: string;
  log: string;
  cursor: string;
  // The byte offset of the cursor's line, kept apart from cursor.json so
  // older CLIs still parse that, see log.ts.
  cursorOffset: string;
  credential: string;
  // The A2A agent card init writes, and where it wrote it, so the daily
  // routine refreshes that file and no other, see card.ts.
  card: string;
  cardWrite: string;
  // The SealKeeper public keys seal verify last fetched, with the fetch time.
  wellKnown: string;
  // The last status answer, which status shows offline and labels as
  // cached, see status-answer.ts.
  status: string;
  // Where a CLI before 0.5.0 kept a start time marker per Claude Code
  // session. None is written now, and SessionEnd and agent delete remove
  // the folder.
  sessions: string;
  // The goal answer, a cache the session nudge reads, see goal.ts.
  goal: string;
  // Whether the session nudge is on, see nudge.ts.
  nudge: string;
  // The routine's limits, allowlist, schedule and pause, see routine.ts.
  routine: string;
  // Which agent was asked the one time runtime question, see
  // agent-runtime.ts.
  runtimeQuestion: string;
  // The operator slug the API last sent, for the handle offline, see
  // operator-slug.ts.
  operatorSlug: string;
  // The last captures of the agent's fingerprint and the fingerprint they
  // make, see fingerprint.ts.
  fingerprint: string;
  // The part hashes the Mastra and OpenClaw adapters observed in the
  // agent's process, for the next capture, see fingerprint.ts.
  fingerprintSources: string;
  logFile(day: string): string;
};

const HOME_DIR_NAME = '.sealkeeper';
const AGENTS_DIR_NAME = 'agents';
const FOLDER_MAP_FILE = 'agents.json';

// The root of every agent on this machine, ~/.sealkeeper. It holds the
// folder map, agents.json, the named homes under agents/, and is itself the
// home of the default agent. SEALKEEPER_HOME does not move it.
// SEALKEEPER_ROOT is for tests only, so a test can point the root at a temp
// directory without touching HOME.
export function sealkeeperRoot(env: NodeJS.ProcessEnv = process.env): string {
  return readEnv('SEALKEEPER_ROOT', env) ?? join(homedir(), HOME_DIR_NAME);
}

// The home of the agent this command acts for. SEALKEEPER_HOME wins and
// reads no map. Otherwise the folder map picks it, by the nearest folder
// at or above cwd that init bound to an agent, see agents.json below. A
// folder no agent is bound to gets the root, the default agent. The map is
// read on every call, it is tiny, and a broken one counts as empty here so
// no command dies on it. readFolderMap says what is wrong with it.
export function sealkeeperHome(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const home = readEnv('SEALKEEPER_HOME', env);
  if (home !== undefined) return home;
  const root = sealkeeperRoot(env);
  return boundHome(cwd, root) ?? root;
}

// The home the nearest folder at or above cwd is bound to, or null when no
// folder there is bound. Unlike sealkeeperHome it tells a folder bound to
// the root apart from one bound to nothing, so init knows when to offer the
// choice. It reads no SEALKEEPER_HOME, and a broken map counts as empty.
export function boundHome(
  cwd: string,
  root: string = sealkeeperRoot(),
): string | null {
  const folders = readFolderMapSync(root).folders;
  let dir = realFolder(cwd);
  for (;;) {
    if (Object.hasOwn(folders, dir)) {
      return join(root, folders[dir] as string);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function realFolder(folder: string): string {
  const absolute = resolve(folder);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

// agents.json in the root. Which folder uses which agent, so one machine
// holds several. Keys are folders after realpath. Values are homes relative
// to the root, '.' for the root itself, the default agent, and
// agents/<name> for a named home. The value is a path and not the agent's
// name, so agent rename never moves a directory.
const HomeValue = z.union([
  z.literal('.'),
  z
    .string()
    .refine(
      (value) =>
        value.startsWith(`${AGENTS_DIR_NAME}/`) &&
        AgentName.safeParse(value.slice(AGENTS_DIR_NAME.length + 1)).success,
      `expected . or ${AGENTS_DIR_NAME}/<agent name>`,
    ),
]);

const FolderMapSchema = z.strictObject({
  version: z.literal(1),
  folders: z.record(
    z.string().refine(isAbsolute, 'expected an absolute folder'),
    HomeValue,
  ),
});
export type FolderMap = { version: 1; folders: Record<string, string> };

const emptyMap = (): FolderMap => ({ version: 1, folders: {} });

export function agentsMapPath(root: string = sealkeeperRoot()): string {
  return join(root, FOLDER_MAP_FILE);
}

// The map for sealkeeperHome, which must not throw. Anything that does not
// read counts as empty.
function readFolderMapSync(root: string): FolderMap {
  try {
    const parsed = FolderMapSchema.safeParse(
      JSON.parse(readFileSync(agentsMapPath(root), 'utf8')),
    );
    return parsed.success ? parsed.data : emptyMap();
  } catch {
    return emptyMap();
  }
}

// The folder map. A missing file is an empty map. Throws ConfigError when
// the file is not valid JSON or does not match the schema.
export async function readFolderMap(
  root: string = sealkeeperRoot(),
): Promise<FolderMap> {
  const file = agentsMapPath(root);
  const raw = await readIfExists(file);
  if (raw === null) return emptyMap();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Invalid agent folders at ${file}: not valid JSON`);
  }
  const result = FolderMapSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(
      `Invalid agent folders at ${file}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

async function writeFolderMap(map: FolderMap, root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writeFileAtomic(
    agentsMapPath(root),
    `${JSON.stringify(FolderMapSchema.parse(map), null, 2)}\n`,
  );
}

// The home of the agent called name, under the root.
export function namedHome(
  name: string,
  root: string = sealkeeperRoot(),
): string {
  return join(root, AGENTS_DIR_NAME, name);
}

// home as the map stores it. '.' for the root, agents/<name> for a named
// home, null for anything else, such as a SEALKEEPER_HOME elsewhere.
export function relativeHome(
  home: string,
  root: string = sealkeeperRoot(),
): string | null {
  const rel = relative(resolve(root), resolve(home));
  if (rel === '') return '.';
  const parts = rel.split(sep);
  if (
    parts.length === 2 &&
    parts[0] === AGENTS_DIR_NAME &&
    AgentName.safeParse(parts[1]).success
  ) {
    return `${AGENTS_DIR_NAME}/${parts[1]}`;
  }
  return null;
}

// Binds folder to home, so every command run in it or below it acts for
// that agent. A folder already bound is bound again. Returns the folder as
// stored, after realpath. Throws ConfigError when home is not the root or
// a named home under it, or the map does not read.
export async function bindFolder(
  folder: string,
  home: string,
  root: string = sealkeeperRoot(),
): Promise<string> {
  const real = await realpath(resolve(folder));
  const value = relativeHome(home, root);
  if (value === null) {
    throw new ConfigError(
      `${home} is not ${root} or a home under ${join(root, AGENTS_DIR_NAME)}, so no folder can use it`,
    );
  }
  const map = await readFolderMap(root);
  map.folders[real] = value;
  await writeFolderMap(map, root);
  return real;
}

// The folders bound to home. Throws ConfigError when the map does not
// read.
export async function boundFolders(
  home: string,
  root: string = sealkeeperRoot(),
): Promise<string[]> {
  return foldersIn(await readFolderMap(root), home, root);
}

function foldersIn(map: FolderMap, home: string, root: string): string[] {
  const target = resolve(home);
  return Object.keys(map.folders).filter(
    (folder) => join(root, map.folders[folder] as string) === target,
  );
}

// Takes every folder bound to home out of the map. Returns the folders
// taken out. Writes only when something changed.
export async function unbindHome(
  home: string,
  root: string = sealkeeperRoot(),
): Promise<string[]> {
  const map = await readFolderMap(root);
  const removed = foldersIn(map, home, root);
  if (removed.length === 0) return [];
  for (const folder of removed) delete map.folders[folder];
  await writeFolderMap(map, root);
  return removed;
}

// For agent delete and logout --delete-key, once the agent's files are
// gone. Takes every folder bound to home out of the map, and removes a named
// home when nothing is left in it. The root, and a SEALKEEPER_HOME
// elsewhere, always stay. Returns the folders taken out.
export async function releaseHome(
  home: string,
  root: string = sealkeeperRoot(),
): Promise<string[]> {
  const folders = await unbindHome(home, root);
  if (relativeHome(home, root)?.startsWith(`${AGENTS_DIR_NAME}/`)) {
    // rmdir removes only an empty directory, so a home with files left in
    // it, such as the log after logout, stays.
    await rmdir(home).catch(() => undefined);
  }
  return folders;
}

export type MachineAgent = {
  home: string;
  // As the map stores it, '.' or agents/<name>.
  relative: string;
  // null when there is no config or it does not read.
  config: Config | null;
  folders: string[];
  isDefault: boolean;
};

// Every agent on this machine. The default agent in the root first, when it
// has a config.json or a folder bound to it. Then each named home in the
// map, in the order it first appears, and last any home under agents/ that
// holds a config.json and has no folder bound, so a stale one still shows.
// Throws ConfigError when the map does not read.
export async function listMachineAgents(
  root: string = sealkeeperRoot(),
): Promise<MachineAgent[]> {
  const map = await readFolderMap(root);
  const byHome = new Map<string, string[]>();
  for (const [folder, value] of Object.entries(map.folders)) {
    const list = byHome.get(value) ?? [];
    list.push(folder);
    byHome.set(value, list);
  }

  const agents: MachineAgent[] = [];
  const add = async (value: string, isDefault: boolean) => {
    const home = value === '.' ? root : join(root, value);
    agents.push({
      home,
      relative: value,
      config: await readConfigOrNull(paths(home)),
      folders: byHome.get(value) ?? [],
      isDefault,
    });
  };

  if (byHome.has('.') || (await exists(paths(root).config))) {
    await add('.', true);
  }
  for (const value of byHome.keys()) {
    if (value !== '.') await add(value, false);
  }
  const named = await readdir(join(root, AGENTS_DIR_NAME), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of named.sort((a, b) => a.name.localeCompare(b.name))) {
    const value = `${AGENTS_DIR_NAME}/${entry.name}`;
    if (!entry.isDirectory() || byHome.has(value)) continue;
    if (await exists(paths(join(root, value)).config)) await add(value, false);
  }
  return agents;
}

async function readConfigOrNull(p: Paths): Promise<Config | null> {
  try {
    return await readConfig(p);
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
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
    cursorOffset: join(home, 'cursor-offset.json'),
    credential: join(home, 'credential.json'),
    card: join(home, 'agent-card.json'),
    cardWrite: join(home, 'card-write.json'),
    wellKnown: join(home, 'well-known.json'),
    status: join(home, 'status.json'),
    sessions: join(home, 'sessions'),
    goal: join(home, 'goal.json'),
    nudge: join(home, 'nudge.json'),
    routine: join(home, 'routine.json'),
    runtimeQuestion: join(home, 'runtime-question.json'),
    operatorSlug: join(home, 'operator-slug.json'),
    fingerprint: join(home, 'fingerprint.json'),
    fingerprintSources: join(home, 'fingerprint-sources.json'),
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
// version does not know are kept.
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
  return result.data;
}

// Validates, then writes config.json atomically. Keys the config was read
// with are kept.
export async function writeConfig(
  input: ConfigInput,
  p: Paths = paths(),
): Promise<Config> {
  await ensureHome(p);
  const config = Config.parse(input);
  await writeFileAtomic(p.config, `${JSON.stringify(config, null, 2)}\n`);
  return config;
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
  const result = RoutineConfig.safeParse(withTime(json));
  if (!result.success) {
    throw new ConfigError(
      `Invalid routine settings at ${p.routine}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

// A routine.json from before VOU-599 keeps the time only in its schedule,
// which is where the time is read from then, and so does a write that
// gives a schedule and no time.
function withTime(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || 'time' in json) {
    return json;
  }
  const schedule = (json as { schedule?: { time?: unknown } }).schedule;
  return typeof schedule?.time === 'string'
    ? { ...json, time: schedule.time }
    : json;
}

// Takes the input shape, so a key left out is written as its default.
export async function writeRoutineConfig(
  routine: z.input<typeof RoutineConfig>,
  p: Paths = paths(),
): Promise<RoutineConfig> {
  const parsed = RoutineConfig.parse(withTime(routine));
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
