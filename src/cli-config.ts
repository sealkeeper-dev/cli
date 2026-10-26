// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Reading the config from a command, where a problem ends the command.
import type { Command } from 'commander';
import { ApiUrlEnvError, savedApiUrl } from './api.js';
import {
  type Config,
  ConfigError,
  type RoutineConfig,
  readConfig,
  readRoutineConfig,
} from './config.js';
import { cli } from './invocation.js';

const NOT_INITIALISED = `not initialised, run ${cli('init')}`;

// The config, or null when not initialised. A broken config ends the command
// with the reason.
export async function loadConfig(cmd: Command): Promise<Config | null> {
  try {
    return await readConfig();
  } catch (error) {
    if (error instanceof ConfigError) cmd.error(error.message);
    throw error;
  }
}

// The config. No config ends the command with the init hint, and
// SEALKEEPER_API_URL naming another API than the saved one ends it with the
// line of commandApiUrl, before anything is sent.
export async function requireConfig(cmd: Command): Promise<Config> {
  const config = await loadConfig(cmd);
  if (config === null) cmd.error(NOT_INITIALISED);
  commandApiUrl(cmd, config.apiUrl);
  return config;
}

// The API a command talks to, see savedApiUrl, saved null when there is no
// config. SEALKEEPER_API_URL naming another API than the saved one ends the
// command with one line.
export function commandApiUrl(
  cmd: Command,
  saved: string | null | undefined,
): string {
  try {
    return savedApiUrl(saved);
  } catch (error) {
    if (error instanceof ApiUrlEnvError) cmd.error(error.message);
    throw error;
  }
}

// The routine settings from routine.json, the defaults when there is none.
// A broken file ends the command with the reason.
export async function loadRoutineConfig(cmd: Command): Promise<RoutineConfig> {
  try {
    return await readRoutineConfig();
  } catch (error) {
    if (error instanceof ConfigError) cmd.error(error.message);
    throw error;
  }
}
