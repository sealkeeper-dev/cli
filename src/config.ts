// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentId } from '@vouched/schema';
import { z } from 'zod';

export const DEFAULT_API_URL = 'https://api.vouched.run';
// The agent version init registers when --version is not given. emit also
// uses it when there is no config yet.
export const DEFAULT_AGENT_VERSION = '0.1.0';
export const PROFILE_BASE_URL = 'https://vouched.run/agents';

// The public profile page of an agent.
export function profileUrl(agentId: string): string {
  return `${PROFILE_BASE_URL}/${agentId}`;
}

export const Config = z
  .object({
    agentId: AgentId,
    operatorLogin: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    apiUrl: z.url({ protocol: /^https?$/ }).default(DEFAULT_API_URL),
    registeredAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type Config = z.infer<typeof Config>;
export type ConfigInput = z.input<typeof Config>;

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
  score: string;
  logFile(day: string): string;
};

// VOUCHED_HOME wins so tests and multiple agents on one machine can each have
// their own directory. The default is ~/.vouched.
export function vouchedHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VOUCHED_HOME;
  return override && override.length > 0
    ? override
    : join(homedir(), '.vouched');
}

// The only place file paths under the Vouched home are built.
export function paths(home: string = vouchedHome()): Paths {
  const log = join(home, 'log');
  return {
    home,
    config: join(home, 'config.json'),
    key: join(home, 'key'),
    log,
    cursor: join(home, 'cursor.json'),
    credential: join(home, 'credential.json'),
    score: join(home, 'score.json'),
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
  let raw: string;
  try {
    raw = await readFile(p.config, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

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
