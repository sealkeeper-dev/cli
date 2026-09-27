// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { execFile } from 'node:child_process';

// The repository name init suggests as the agent's name, from the URL of
// the origin remote. Shells out to git, so there is no new dependency, and
// any failure, git missing, no repository or no origin, reads as no name.

// Short, so a slow or hung git never holds up init.
const GIT_TIMEOUT_MS = 2_000;

// The URL of the origin remote in cwd, or null.
export function originUrl(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const url = String(stdout).trim();
        resolve(url.length > 0 ? url : null);
      },
    );
  });
}

// The last path segment of a remote URL without .git, as in sealkeeper
// from git@github.com:sealkeeper-dev/sealkeeper.git,
// https://github.com/sealkeeper-dev/sealkeeper or /srv/git/sealkeeper.git.
// null when there is no segment left.
export function repoNameOf(url: string): string | null {
  const path = url
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/[/\\]+$/, '');
  const segment = path.split(/[/\\:]/).pop() ?? '';
  const name = segment.replace(/\.git$/i, '');
  return name.length > 0 ? name : null;
}

// The repository name of the origin remote in cwd, or null.
export async function repoName(cwd: string): Promise<string | null> {
  const url = await originUrl(cwd);
  return url === null ? null : repoNameOf(url);
}
