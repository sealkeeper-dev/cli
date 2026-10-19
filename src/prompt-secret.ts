// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The prompt secret, 32 random bytes kept in the home beside the key as one
// base64url line, readable by the owner alone (mode 600). It is the first
// line of what the prompt part of the fingerprint is hashed from, so the
// prompt hash cannot be matched by guessing the instructions text. Only init
// and the fingerprint observer read it. Nothing sends, prints or logs it, and
// error messages never include the file contents.
import { randomBytes, randomUUID } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';
import { base64urlEncode } from '@sealkeeper/schema';
import { type Paths, paths } from './config.js';
import { readIfExists } from './files.js';
import { decodeSeed } from './identity.js';

export class PromptSecretError extends Error {
  override name = 'PromptSecretError';
}

// The secret as its base64url line, read from the file, or created when the
// file is missing. A file that exists is never replaced. The new file is
// written to a temp file with mode 600 and moved into place with a hard
// link, which fails when the file already exists, so two processes that
// create it at once both end with the one that won. Throws when the home
// does not exist or the file is not one base64url line of 32 bytes.
export async function ensurePromptSecret(p: Paths = paths()): Promise<string> {
  const existing = await readSecret(p);
  if (existing !== null) return existing;

  const line = base64urlEncode(randomBytes(32));
  const tmp = `${p.promptSecret}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(`${line}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(tmp, p.promptSecret);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const won = await readSecret(p);
      if (won === null) throw error;
      return won;
    }
  } finally {
    await rm(tmp, { force: true });
  }
  return line;
}

// null when there is no file. Throws PromptSecretError when it does not read.
async function readSecret(p: Paths): Promise<string | null> {
  const raw = await readIfExists(p.promptSecret);
  if (raw === null) return null;
  if (decodeSeed(raw) === null) {
    throw new PromptSecretError(
      `Invalid prompt secret at ${p.promptSecret}: expected one base64url line holding 32 bytes`,
    );
  }
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}
