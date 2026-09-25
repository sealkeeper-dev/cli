// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentId, agentHandle } from '@sealkeeper/schema';
import { z } from 'zod';
import { readEnv } from './env.js';
import { readIfExists } from './files.js';

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

export const Config = z
  .object({
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
  })
  .strict();
export type Config = z.infer<typeof Config>;
type ConfigInput = z.input<typeof Config>;

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
  // Start time markers for hook adapters, one small file per session or tool
  // call, so a later hook can compute a duration.
  sessions: string;
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
    sessions: join(home, 'sessions'),
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
// exists but is not valid JSON or does not match the schema.
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

// Validates, then writes config.json atomically.
export async function writeConfig(
  input: ConfigInput,
  p: Paths = paths(),
): Promise<Config> {
  const config = Config.parse(input);
  await ensureHome(p);
  await writeFileAtomic(p.config, `${JSON.stringify(config, null, 2)}\n`);
  return config;
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
