// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { type Paths, paths, readConfig } from '../config.js';
import { exists } from '../files.js';
import { deleteKey as removeKey } from '../identity.js';
import { cli } from '../invocation.js';
import { stdout, wantsJson } from '../output.js';
import { SchedulerError } from '../routine-scheduler.js';
import { releaseFolders, unboundLines } from './agent.js';
import {
  defaultRoutineDeps,
  jobLines,
  type RoutineDeps,
  uninstallJob,
} from './routine.js';

// Removes the local session. config.json, credential.json, score.json,
// inbox.json, post-prompt.json, goal.json and operator-slug.json go, and the
// daily routine job when one is installed, since it would run for nobody.
// nudge.json and the routine's limits and allowlist stay. The key, the log,
// the cursor and the fingerprint files stay too, so a later init brings the
// same identity back and sync goes on where it was.
//
// --delete-key with --yes also deletes the key, every copy of it
// (key.<time>.bak and key.<id>.tmp), the log, the cursor and the
// fingerprint files, which go with the key, as agent delete does, so a new
// key never signs the events the old one logged. There is no prompt, the
// --yes flag is the confirmation, and everything removed is printed. With
// the key gone the folders init bound to this agent are unbound too, and a
// named home left empty is removed. A plain logout keeps them, since the
// key stays.

const NOT_INITIALISED_LOGOUT = 'not initialised, nothing to log out';

type LogoutOptions = {
  deleteKey?: boolean;
  yes?: boolean;
};

export function register(
  parent: Command,
  deps: RoutineDeps = defaultRoutineDeps,
): Command {
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
          const { removed, keyCopies } = await removeSession(p, true);
          const folders = await releaseFolders(p);
          if (json) {
            stdout(
              JSON.stringify({
                loggedOut: false,
                removed,
                keyDeleted: true,
                keyCopies,
                folders,
              }),
            );
          } else {
            for (const line of deletedKeyLines(p, 'this agent', keyCopies)) {
              stdout(line);
            }
            for (const line of unboundLines(folders)) stdout(line);
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
            `--delete-key would delete the key at ${p.key}, any copies of it and the log at ${p.log} along with the local session.`,
            `The identity of ${identity} would be gone for good and its track record could not be extended.`,
            `Nothing was deleted. Run ${cli('logout --delete-key --yes')} to go ahead.`,
          ].join('\n'),
        );
      }

      // The job first, so a scheduler that refuses stops logout with
      // everything still in place.
      let routineJob: { removed: string[]; kept: string[] } | null;
      try {
        routineJob = await uninstallJob(deps, p);
      } catch (error) {
        if (error instanceof SchedulerError) {
          this.error(
            `nothing removed. The daily routine job could not be removed: ${error.message}`,
          );
        }
        throw error;
      }
      const { removed, keyCopies } = await removeSession(p, deleteKey);
      const folders = deleteKey ? await releaseFolders(p) : [];

      if (json) {
        stdout(
          JSON.stringify({
            loggedOut: true,
            removed,
            keyDeleted: deleteKey,
            ...(deleteKey ? { keyCopies } : {}),
            routineJob,
            folders,
          }),
        );
        return;
      }
      stdout(`logged out, removed ${removed.join(', ')}`);
      if (routineJob !== null) {
        for (const line of jobLines(routineJob)) stdout(line);
      }
      if (deleteKey) {
        for (const line of deletedKeyLines(p, identity, keyCopies)) {
          stdout(line);
        }
        for (const line of unboundLines(folders)) stdout(line);
      } else {
        stdout(
          `kept the key at ${p.key} and the log at ${p.log}, run ${cli('init')} to sign in again`,
        );
      }
    });
}

// What logout --delete-key says it deleted. Each copy of the key is named
// by its full path, since each held the private seed.
function deletedKeyLines(
  p: Paths,
  identity: string,
  keyCopies: string[],
): string[] {
  return [
    `deleted the key at ${p.key}, the identity of ${identity} is gone for good`,
    ...keyCopies.map((file) => `deleted the key copy at ${file}`),
    `deleted the log at ${p.log}`,
  ];
}

// Removes the session files and, when asked, the key with its copies, the
// cursor and the log. A kept key keeps the cursor, so sync goes on where it
// was after the next init. config.json goes last so a run cut short can be
// repeated. removed names the files and folders that existed, keyCopies
// the full paths of the key copies deleted.
async function removeSession(
  p: Paths,
  deleteKey: boolean,
): Promise<{ removed: string[]; keyCopies: string[] }> {
  const targets = [
    p.credential,
    p.score,
    p.inbox,
    p.postPrompt,
    p.goal,
    p.operatorSlug,
    ...(deleteKey
      ? [p.cursor, p.cursorOffset, p.log, p.fingerprint, p.fingerprintSources]
      : []),
  ];
  const removed: string[] = [];
  const remove = async (target: string) => {
    if (await exists(target)) removed.push(basename(target));
    await rm(target, { recursive: true, force: true });
  };
  for (const target of targets) await remove(target);
  let keyCopies: string[] = [];
  if (deleteKey) {
    const hadKey = await exists(p.key);
    keyCopies = await removeKey(p);
    if (hadKey) removed.push(basename(p.key));
    removed.push(...keyCopies.map((file) => basename(file)));
  }
  await remove(p.config);
  return { removed, keyCopies };
}
