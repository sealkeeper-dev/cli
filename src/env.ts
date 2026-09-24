// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { stderr } from './output.js';

// Environment variables that were renamed with the package. The new name
// wins. For one release the old name is still read, with a one line warning
// naming the new one, printed once per process.
export const RENAMED_ENV = {
  SEALKEEPER_HOME: 'VOUCHED_HOME',
  SEALKEEPER_API_URL: 'VOUCHED_API_URL',
  SEALKEEPER_GITHUB_CLIENT_ID: 'VOUCHED_GITHUB_CLIENT_ID',
} as const;
export type EnvName = keyof typeof RENAMED_ENV;

const warned = new Set<string>();

export function oldEnvWarning(name: EnvName): string {
  return `warning: ${RENAMED_ENV[name]} is deprecated, use ${name}`;
}

// The value of the old name alone, trimmed, with no warning. For the home
// migration, which needs to know where the old directory was.
export function readOldEnv(
  name: EnvName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[RENAMED_ENV[name]]?.trim() || undefined;
}

// The trimmed value of name, else of its old name with a warning, else
// undefined. An empty value counts as unset.
export function readEnv(
  name: EnvName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[name]?.trim();
  if (value) return value;
  const legacy = readOldEnv(name, env);
  if (legacy === undefined) return undefined;
  if (!warned.has(name)) {
    warned.add(name);
    stderr(oldEnvWarning(name));
  }
  return legacy;
}

// For tests, so each one sees the warning once.
export function resetEnvWarnings(): void {
  warned.clear();
}
