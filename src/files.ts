// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sep } from 'node:path';

// The file as UTF-8 text, or null when it does not exist. Any other error
// is thrown.
export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Whether anything is at path. An unreadable path counts as nothing.
export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

// A path under the home directory, as ~/rest.
export function tildePath(path: string, home: string = homedir()): string {
  if (home === '' || home === sep) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}${sep}`)
    ? `~${path.slice(home.length)}`
    : path;
}
