// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  type Paths,
  paths,
  readRoutineConfig,
  writeFileAtomic,
} from './config.js';
import { exists, readIfExists } from './files.js';
import { cli } from './invocation.js';
import { VERSION } from './version.js';

// The copy of this CLI the daily job runs (RS-2). routine install copies the
// running bundle, one file with no runtime dependencies since VOU-227, to
// <home>/routine/cli.js and points the job at it, so the job keeps working
// when npm clears the npx cache or a global install moves. A package.json
// beside it says the file is an ES module and records the version copied,
// so status can compare without running it. A repeat init or routine
// install refreshes the copy when that version differs from the running
// CLI, and routine remove deletes it.
//
// The same folder keeps last-run.jsonl, the last run's Claude Code
// transcript, which goes with the copy (RS-10).

export type CopyPaths = {
  dir: string;
  script: string;
  // The package.json beside the script, with type module and the version.
  meta: string;
  // The last routine run's stream-json as Claude Code wrote it, mode 600,
  // replaced at each run and never printed (RS-10).
  transcript: string;
};

export function copyPaths(p: Paths = paths()): CopyPaths {
  const dir = join(p.home, 'routine');
  return {
    dir,
    script: join(dir, 'cli.js'),
    meta: join(dir, 'package.json'),
    transcript: join(dir, 'last-run.jsonl'),
  };
}

const Meta = z.looseObject({ version: z.string().min(1) });

// The version the copy records, or null when there is no copy or its
// package.json does not read.
export async function copyVersion(p: Paths = paths()): Promise<string | null> {
  const c = copyPaths(p);
  try {
    if (!(await exists(c.script))) return null;
    const raw = await readIfExists(c.meta);
    if (raw === null) return null;
    const parsed = Meta.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

export type CopyResult =
  // The copy was written, new or refreshed.
  | 'copied'
  // The copy was there with this version already.
  | 'current'
  // The running CLI is the copy, which is never copied over itself.
  | 'self';

// Copies the bundle at source to the copy, unless the copy already has
// version or source is the copy itself. The folder gets mode 700 and the
// files mode 600, as the other files in the home. The script goes first
// and the version after, so a copy cut short reads as out of date.
export async function writeCopy(
  source: string,
  p: Paths = paths(),
  version: string = VERSION,
): Promise<CopyResult> {
  const c = copyPaths(p);
  if (samePath(source, c.script)) return 'self';
  if ((await copyVersion(p)) === version) return 'current';
  const text = await readFile(source, 'utf8');
  await mkdir(c.dir, { recursive: true, mode: 0o700 });
  await chmod(c.dir, 0o700);
  await writeFileAtomic(c.script, text, 0o600);
  await writeFileAtomic(
    c.meta,
    `${JSON.stringify({ type: 'module', version }, null, 2)}\n`,
    0o600,
  );
  return 'copied';
}

// Deletes the copy, the last run's transcript and their folder when that is
// left empty. Returns the paths it removed.
export async function removeCopy(p: Paths = paths()): Promise<string[]> {
  const c = copyPaths(p);
  const removed: string[] = [];
  for (const path of [c.script, c.meta, c.transcript]) {
    if (!(await exists(path))) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  await rmdir(c.dir).catch(() => undefined);
  return removed;
}

// Whether a job's command runs the copy of this home.
export function runsCopy(program: string[], p: Paths = paths()): boolean {
  const script = program[1];
  return script !== undefined && samePath(script, copyPaths(p).script);
}

function samePath(a: string, b: string): boolean {
  return real(a) === real(b);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Said by status and routine status when the copy the job runs is not the
// version of the CLI running.
export const copyOutdatedLine = (copy: string, running: string): string =>
  `Routine runs ${copy}, this CLI is ${running}, run ${cli('routine install')} to update it.`;

// Said by status and routine status when node or the script the job runs
// is gone, as the hooks warning says for the hooks.
export const jobMissingLine = (): string =>
  `The daily routine job points at a sealkeeper that is no longer there. Run ${cli('routine install')} again.`;

// The warnings about the installed job's command, none when no job is
// installed, an earlier CLI installed it or routine.json does not read.
export async function routineJobWarnings(
  p: Paths = paths(),
  running: string = VERSION,
): Promise<string[]> {
  let program: string[] | undefined;
  try {
    program = (await readRoutineConfig(p)).schedule?.program;
  } catch {
    return [];
  }
  if (program === undefined) return [];
  const [node, script] = program;
  if (
    node === undefined ||
    script === undefined ||
    !(await exists(node)) ||
    !(await exists(script))
  ) {
    return [jobMissingLine()];
  }
  if (!runsCopy(program, p)) return [];
  const copied = await copyVersion(p);
  return copied !== null && copied !== running
    ? [copyOutdatedLine(copied, running)]
    : [];
}
