// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { link, open, rename, rm, stat } from 'node:fs/promises';
import { getPublicKeyAsync } from '@noble/ed25519';
import {
  type AgentId,
  agentIdFromPublicKey,
  base64urlDecode,
  base64urlEncode,
  generateKeypair,
  sign,
} from '@sealkeeper/schema';
import { ensureHome, type Paths, paths } from './config.js';
import { readIfExists } from './files.js';
import { cli } from './invocation.js';
import { stderr } from './output.js';

// The key file holds the 32 byte Ed25519 private seed as one base64url line.
// Nothing in this module prints or logs the seed, and error messages never
// include the file contents.

export class KeyError extends Error {
  override name = 'KeyError';
}

export const NO_KEY = `no key found, run ${cli('init')}`;

export type Identity = {
  agentId: AgentId;
  publicKey: Uint8Array;
};

export type LoadedKey = Identity & {
  privateKey: Uint8Array;
};

// Writes a temp file with mode 600 in the home directory, then moves it into
// place. Without force the move is a hard link, which fails when a key already
// exists, so two concurrent runs can never both win. With force it is a rename
// over the old key, which is first kept as key.<time>.bak, since a lost key
// can never be recovered. backup names that file when there was an old key.
export async function createKey(
  options: { force?: boolean } = {},
  p: Paths = paths(),
): Promise<Identity & { backup?: string }> {
  await ensureHome(p);
  const { privateKey, publicKey, agentId } = await generateKeypair();

  const tmp = `${p.key}.${randomUUID()}.tmp`;
  let backup: string | undefined;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(`${base64urlEncode(privateKey)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    if (options.force) {
      backup = await backupKey(p);
      await rename(tmp, p.key);
    } else {
      await link(tmp, p.key).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') {
          throw new KeyError(
            `A key already exists at ${p.key}. Refusing to overwrite it`,
          );
        }
        throw error;
      });
    }
  } finally {
    await rm(tmp, { force: true });
  }
  return backup === undefined
    ? { agentId, publicKey }
    : { agentId, publicKey, backup };
}

// A hard link to the current key under a new name, so the bytes and the 600
// mode carry over. undefined when there is no key.
async function backupKey(p: Paths): Promise<string | undefined> {
  const backup = `${p.key}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  try {
    await link(p.key, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return backup;
}

// Returns null when there is no key file. Throws KeyError when the file is not
// one base64url line holding a 32 byte seed. Prints one warning line on stderr
// when group or others have any permission on the file.
export async function loadKey(p: Paths = paths()): Promise<LoadedKey | null> {
  const raw = await readIfExists(p.key);
  if (raw === null) return null;

  const mode = (await stat(p.key)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    stderr(
      `warning: key file ${p.key} has mode ${mode.toString(8)}, run chmod 600 ${p.key}`,
    );
  }

  const privateKey = decodeSeed(raw);
  if (privateKey === null) {
    throw new KeyError(
      `Invalid key at ${p.key}: expected one base64url line holding a 32 byte Ed25519 seed`,
    );
  }
  const publicKey = await getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, agentId: agentIdFromPublicKey(publicKey) };
}

export type Signer = {
  agentId: AgentId;
  sign(payload: unknown): Promise<string>;
};

// The only place the CLI signs. It loads the local key once and hands every
// payload to the schema helper, with kid set to the agent id. sync uses one
// signer per run so a batch of 500 reads the key file once.
export async function loadSigner(p: Paths = paths()): Promise<Signer> {
  const key = await loadKey(p);
  if (key === null) throw new KeyError(NO_KEY);
  return {
    agentId: key.agentId,
    sign: (payload) => sign(payload, key.privateKey, key.agentId),
  };
}

export async function signEnvelope(
  payload: unknown,
  p: Paths = paths(),
): Promise<string> {
  return (await loadSigner(p)).sign(payload);
}

// Accepts exactly 43 base64url characters with at most one trailing newline.
// base64urlDecode rejects non canonical trailing bits.
function decodeSeed(raw: string): Uint8Array | null {
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{43}$/.test(line)) return null;
  try {
    return base64urlDecode(line);
  } catch {
    return null;
  }
}
