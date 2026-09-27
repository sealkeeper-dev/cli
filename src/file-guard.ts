// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { insideHome } from './key-guard.js';
import { activeRoutineRun } from './routine.js';

// Which files tasks submit --file and tasks post --input @file may read
// (VOU-229). What they read leaves the machine as a submission or a spec,
// and the path may come from an agent that a task spec told what to do. A
// routine run grants the agent tasks submit with any arguments, so the CLI
// must not read for it a file its own Read tool may not open.
//
// Every path is resolved with realpath first, so a symlink is judged by
// where it points, and a symlink out of the answers folder is refused like
// the file it points to. Then, in order
// - nothing inside the SealKeeper home, which holds the private key
// - in a routine run, nothing outside <cwd>/.sealkeeper-answers
// - otherwise nothing in a hidden file or folder at the top of the user's
//   home, such as .ssh, .config, .aws or .gnupg, whatever the flags
// - otherwise nothing outside the current directory, unless the caller
//   passed allowOutsideCwd
// - only a regular file, never a device, a fifo or a folder
// - nothing larger than maxBytes, checked before a byte is read

// The folder the prove instructions write answer files to.
export const ANSWERS_DIR = '.sealkeeper-answers';

export type FileRules = {
  // The most bytes the file may hold.
  maxBytes: number;
  // How a refusal starts, for example "refusing to submit".
  refusing: string;
  // What the file is, for example "the answer file".
  what: string;
  allowOutsideCwd?: boolean;
  // For tests. The defaults are the process's own.
  cwd?: string;
  userHome?: string;
  routine?: boolean;
};

export type FileRead = { text: string } | { error: string };

// True when target is dir or inside it. Both are resolved paths.
function within(dir: string, target: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return target === dir || target.startsWith(prefix);
}

const real = (path: string) => realpath(path).catch(() => resolve(path));

// The hidden file or folder at the top of the user's home that target is
// in, or null.
function hiddenInHome(userHome: string, target: string): string | null {
  if (!within(userHome, target) || target === userHome) return null;
  const top = relative(userHome, target).split(sep)[0] ?? '';
  return top.startsWith('.') ? resolve(userHome, top) : null;
}

// The text of file when the rules above allow it, else why not, in one
// line. Nothing is read from a refused file.
export async function readGuardedFile(
  file: string,
  rules: FileRules,
): Promise<FileRead> {
  const { refusing, what } = rules;
  const refuse = (why: string): FileRead => ({
    error: `${refusing} ${file}, ${why}`,
  });
  const cwdGiven = rules.cwd ?? process.cwd();
  let target: string;
  try {
    target = await realpath(resolve(cwdGiven, file));
  } catch (error) {
    return {
      error: `could not read ${what} ${file}, ${(error as Error).message}`,
    };
  }

  const home = await insideHome(target);
  if (home !== null) {
    return refuse(`it is inside ${home}, which holds this agent's private key`);
  }

  // The answers folder is not resolved itself, so when it is a symlink
  // nothing counts as inside it.
  const cwd = await real(cwdGiven);
  const answers = resolve(cwd, ANSWERS_DIR);
  const routine = rules.routine ?? (await activeRoutineRun()) !== null;
  if (routine) {
    if (!within(answers, target) || target === answers) {
      return refuse(
        `a routine run reads ${what} only from ${answers}, write it there`,
      );
    }
  } else if (!within(answers, target)) {
    const hidden = hiddenInHome(
      await real(rules.userHome ?? homedir()),
      target,
    );
    if (hidden !== null) {
      return refuse(
        `it is inside ${hidden}, a hidden file or folder in your home that can hold keys and tokens`,
      );
    }
    if (rules.allowOutsideCwd !== true && !within(cwd, target)) {
      return refuse(
        `it is outside the current directory ${cwd}. Move it here, or add --allow-outside-cwd to read it`,
      );
    }
  }

  // Checked on the path first, so a fifo is never opened, which would wait
  // for a writer, and checked again on the open file, in case the path
  // changed in between. At most maxBytes and one more are ever read.
  const limits = async (info: {
    isFile(): boolean;
    size: number;
  }): Promise<FileRead | null> => {
    if (!info.isFile()) return refuse('it is not a regular file');
    if (info.size > rules.maxBytes) {
      return refuse(
        `it is ${info.size} bytes and the most allowed is ${rules.maxBytes}. Nothing was read`,
      );
    }
    return null;
  };
  try {
    const before = await limits(await stat(target));
    if (before !== null) return before;
    const flags =
      constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0);
    const handle = await open(target, flags);
    try {
      const after = await limits(await handle.stat());
      if (after !== null) return after;
      const buffer = Buffer.alloc(rules.maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > rules.maxBytes) {
        return refuse(`it is larger than ${rules.maxBytes} bytes`);
      }
      return { text: buffer.subarray(0, length).toString('utf8') };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      error: `could not read ${what} ${file}, ${(error as Error).message}`,
    };
  }
}
