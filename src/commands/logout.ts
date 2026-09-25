// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { access, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { type Paths, paths, readConfig } from '../config.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';

// Removes the local session. config.json, cursor.json, credential.json and
// score.json go. The log stays, and so does the key unless --delete-key and
// --yes are both given. There is no prompt, the --yes flag is the
// confirmation.

export const NOT_INITIALISED_LOGOUT = 'not initialised, nothing to log out';

type LogoutOptions = {
  deleteKey?: boolean;
  yes?: boolean;
};

export function register(parent: Command): Command {
  return parent
    .command('logout')
    .description('Remove the local session for this agent, keeping the key')
    .option(
      '--delete-key',
      'also delete the private key, the identity is gone for good',
    )
    .option('--yes', 'confirm --delete-key')
    .action(async function (this: Command, options: LogoutOptions) {
      const p = paths();
      const json = wantsJson(this);
      const deleteKey = options.deleteKey === true && options.yes === true;
      if (!(await exists(p.config))) {
        // After a plain logout only the key and the log are left. The key
        // must still be deletable then, or no command could remove it.
        if (deleteKey && (await exists(p.key))) {
          const removed = await removeSession(p, true);
          if (json) {
            stdout(
              JSON.stringify({ loggedOut: false, removed, keyDeleted: true }),
            );
          } else {
            stdout(
              `deleted the key at ${p.key}, the identity of this agent is gone for good`,
            );
          }
          return;
        }
        stdout(
          json
            ? JSON.stringify({ loggedOut: false, removed: [] })
            : NOT_INITIALISED_LOGOUT,
        );
        return;
      }

      // Only used to name the identity in messages. A broken config must not
      // stop logout, so any error here is ignored.
      const agentId = await readConfig(p)
        .then((config) => config?.agentId ?? null)
        .catch(() => null);
      const identity = agentId ? `agent ${agentId}` : 'this agent';

      if (options.deleteKey && !options.yes) {
        this.error(
          [
            `--delete-key would delete the key at ${p.key} along with the local session.`,
            `The identity of ${identity} would be gone for good and its track record could not be extended.`,
            `Nothing was deleted. Run ${cli('logout --delete-key --yes')} to go ahead.`,
          ].join('\n'),
        );
      }

      const removed = await removeSession(p, deleteKey);

      if (json) {
        stdout(
          JSON.stringify({
            loggedOut: true,
            removed,
            keyDeleted: deleteKey,
          }),
        );
        return;
      }
      stdout(`logged out, removed ${removed.join(', ')}`);
      if (deleteKey) {
        stdout(
          `deleted the key at ${p.key}, the identity of ${identity} is gone for good`,
        );
      } else {
        stdout(
          `kept the key at ${p.key} and the log at ${p.log}, run ${cli('init')} to sign in again`,
        );
      }
    });
}

// Removes the session files and, when asked, the key. config.json goes last
// so a run cut short can be repeated. Returns the names of the files that
// existed.
async function removeSession(p: Paths, deleteKey: boolean): Promise<string[]> {
  const targets = [
    p.cursor,
    p.credential,
    p.score,
    ...(deleteKey ? [p.key] : []),
    p.config,
  ];
  const removed: string[] = [];
  for (const target of targets) {
    if (await exists(target)) removed.push(basename(target));
    await rm(target, { force: true });
  }
  return removed;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
