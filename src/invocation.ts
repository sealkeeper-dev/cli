// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { realpathSync } from 'node:fs';
import { basename, delimiter, dirname, resolve } from 'node:path';

// How printed advice spells this CLI, such as the sync in "run npx
// sealkeeper sync". After npx sealkeeper init nothing is on PATH, so a bare
// sealkeeper would not run. The hooks and the /sealkeeper-prove command use
// the absolute node and script paths instead, see cliInvocation in
// claude-code-settings.ts. This is only for text a person or an agent reads
// and types.

export const BARE_INVOCATION = 'sealkeeper';
export const NPX_INVOCATION = 'npx sealkeeper';

// The npx cache lives under a directory named _npx.
const NPX_CACHE = /[\\/]_npx[\\/]/;
// A project's own bin directory. npm run and npx put it on PATH, a shell
// does not.
const LOCAL_BIN = /[\\/]node_modules[\\/]\.bin$/;

// sealkeeper when this run started from a bin named sealkeeper in a PATH
// directory, the way a global install runs, otherwise npx sealkeeper, which
// resolves through the npx cache the same way init did. Decided from argv1
// and where it really points, never by spawning anything or searching PATH
// for other copies. SEALKEEPER_INVOCATION overrides it when set.
export function detectInvocation(
  argv1: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.SEALKEEPER_INVOCATION?.trim();
  if (override) return override;
  if (argv1 === undefined || argv1.length === 0) return NPX_INVOCATION;
  if (basename(argv1) !== BARE_INVOCATION) return NPX_INVOCATION;
  // npx runs its copy through <cache>/node_modules/.bin/sealkeeper and puts
  // that directory on PATH for the run only.
  const script = realOrNull(argv1) ?? argv1;
  if (NPX_CACHE.test(argv1) || NPX_CACHE.test(script)) return NPX_INVOCATION;
  const dir = resolve(dirname(argv1));
  if (LOCAL_BIN.test(dir)) return NPX_INVOCATION;
  const onPath = (env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => resolve(entry) === dir);
  return onPath ? BARE_INVOCATION : NPX_INVOCATION;
}

let decided: string | undefined;

// The invocation for this run, decided once.
export function printedInvocation(): string {
  decided ??= detectInvocation();
  return decided;
}

// A full command for printed text. cli('sync --yes') gives npx sealkeeper
// sync --yes after an npx install and sealkeeper sync --yes after a global
// one.
export function cli(args: string): string {
  return `${printedInvocation()} ${args}`;
}

// For tests, so the next call decides again.
export function resetInvocation(): void {
  decided = undefined;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
