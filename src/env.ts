// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.

// The trimmed value of name, or undefined. An empty value counts as unset.
export function readEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[name]?.trim() || undefined;
}
