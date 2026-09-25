// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { readFile, stat } from 'node:fs/promises';

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
