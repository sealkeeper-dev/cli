// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOME_DIR_NAME } from './config.js';
import { readOldEnv } from './env.js';
import { stderr } from './output.js';

// The package was called vouched before 0.4.0 and kept its settings in
// ~/.vouched. The first command after the upgrade copies that directory to
// ~/.sealkeeper, so the key, the registration, the log and the cursor carry
// over. The old directory is only ever read, never changed or deleted.

export const OLD_HOME_DIR_NAME = '.vouched';

export function movedLine(from: string, to: string): string {
  return `settings moved from ${from} to ${to}, the key and registration carry over`;
}

export class HomeMigrationError extends Error {
  override name = 'HomeMigrationError';
}

// Where to copy from and to, or null when there is nothing to consider.
// With no env set, ~/.vouched to ~/.sealkeeper. With SEALKEEPER_HOME set, only
// from the old VOUCHED_HOME when that is set too, so a SEALKEEPER_HOME chosen
// on purpose never picks up ~/.vouched. With only VOUCHED_HOME set, that
// directory is the home and nothing moves.
export function migrationPlan(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { from: string; to: string } | null {
  const oldHome = readOldEnv('SEALKEEPER_HOME', env);
  const newHome = env.SEALKEEPER_HOME?.trim();
  if (newHome) {
    return oldHome && oldHome !== newHome
      ? { from: oldHome, to: newHome }
      : null;
  }
  if (oldHome) return null;
  return {
    from: join(home, OLD_HOME_DIR_NAME),
    to: join(home, HOME_DIR_NAME),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Copies from to to when to does not exist and from is a directory. The copy
// goes to a temp directory next to to and is renamed into place only once it
// is whole, so a failure part way leaves no half home behind and the old one
// as it was. The home is 0700 and the key 0600 afterwards, as ensureHome and
// createKey leave them. Returns whether it moved anything. Throws
// HomeMigrationError when the copy fails.
export async function migrateHome(
  from: string,
  to: string,
  log: (line: string) => void = stderr,
): Promise<boolean> {
  if (await exists(to)) return false;
  if (!(await isDirectory(from))) return false;

  const tmp = `${to}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, tmp, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await chmod(tmp, 0o700);
    if (await exists(join(tmp, 'key'))) await chmod(join(tmp, 'key'), 0o600);
    // Another process may have made the home meanwhile. Keep that one.
    if (await exists(to)) {
      await rm(tmp, { recursive: true, force: true });
      return false;
    }
    try {
      await rename(tmp, to);
    } catch (error) {
      // Two commands that start together, such as hooks firing at once,
      // can both get this far. The one that renames second finds the home
      // made by the other and keeps it, as above.
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'ENOTEMPTY' || code === 'EEXIST') && (await exists(to))) {
        await rm(tmp, { recursive: true, force: true });
        return false;
      }
      throw error;
    }
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new HomeMigrationError(
      `could not copy the settings from ${from} to ${to}, ${(error as Error).message}. ${from} is unchanged. Fix the cause and run the command again`,
    );
  }
  log(movedLine(from, to));
  return true;
}

// The migration as the environment asks for it. Every command calls it
// before it reads config, through the preAction hook in program.ts, and so
// does emit in lib.ts for the adapters. Once the new home exists it is one
// lstat and nothing else.
export function migrateHomeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = stderr,
): Promise<boolean> {
  const plan = migrationPlan(env);
  return plan ? migrateHome(plan.from, plan.to, log) : Promise.resolve(false);
}
