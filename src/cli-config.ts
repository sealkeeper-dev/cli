// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Reading the config from a command, where a problem ends the command.
import type { Command } from 'commander';
import { type Config, ConfigError, readConfig } from './config.js';
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

// The config. No config ends the command with the init hint.
export async function requireConfig(cmd: Command): Promise<Config> {
  const config = await loadConfig(cmd);
  if (config === null) cmd.error(NOT_INITIALISED);
  return config;
}
