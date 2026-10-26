// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  link,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getPublicKeyAsync } from '@noble/ed25519';
import {
  type AgentId,
  agentIdFromPublicKey,
  audienceOf,
  base64urlDecode,
  base64urlEncode,
  generateKeypair,
  type RequestPurpose,
  signRequest,
} from '@sealkeeper/schema';
import { ApiError } from './api.js';
import {
  ensureHome,
  INSECURE_API_URL,
  isSecureApiUrl,
  type Paths,
  paths,
} from './config.js';
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

type Identity = {
  agentId: AgentId;
  publicKey: Uint8Array;
};

type LoadedKey = Identity & {
  privateKey: Uint8Array;
};

// Writes a temp file with mode 600 in the home directory, then moves it into
// place. Without force the move is a hard link, which fails when a key already
// exists, so two concurrent runs can never both win. With force it is a rename
// over the old key, which is first kept as key.<time>.bak, since a lost key
// can never be recovered. backup names that file when there was an old key.
// seed is a key brought from elsewhere, written in place of a new one.
export async function createKey(
  options: { force?: boolean; seed?: Uint8Array } = {},
  p: Paths = paths(),
): Promise<Identity & { backup?: string }> {
  await ensureHome(p);
  const { privateKey, publicKey, agentId } =
    options.seed === undefined
      ? await generateKeypair()
      : await seedIdentity(options.seed);

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

// The public key and agent id of a given seed.
export async function seedIdentity(privateKey: Uint8Array) {
  const publicKey = await getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, agentId: agentIdFromPublicKey(publicKey) };
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

// The copies of the key createKey leaves beside it, key.<time>.bak from
// --force and key.<uuid>.tmp from a run cut short, as full paths in name
// order. Each holds a private seed, so deleting the key deletes them too.
export async function keyCopies(p: Paths = paths()): Promise<string[]> {
  const dir = dirname(p.key);
  const name = basename(p.key);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter(
      (n) =>
        n.startsWith(`${name}.`) && (n.endsWith('.bak') || n.endsWith('.tmp')),
    )
    .sort()
    .map((n) => join(dir, n));
}

// Deletes the key and every copy keyCopies finds. Returns the full paths of
// the copies that were there, so the caller can name them.
export async function deleteKey(p: Paths = paths()): Promise<string[]> {
  const copies = await keyCopies(p);
  for (const file of [...copies, p.key]) await rm(file, { force: true });
  return copies;
}

// Returns null when there is no key file. Throws KeyError when the file is not
// one base64url line holding a 32 byte seed. Prints one warning line on stderr
// when group or others have any permission on the file, except on Windows.
export async function loadKey(
  p: Paths = paths(),
  platform: NodeJS.Platform = process.platform,
): Promise<LoadedKey | null> {
  const raw = await readIfExists(p.key);
  if (raw === null) return null;

  // Windows reports every file as mode 666 and chmod does nothing there, so the
  // check is skipped.
  const mode = (await stat(p.key)).mode & 0o777;
  if (platform !== 'win32' && (mode & 0o077) !== 0) {
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
  return seedIdentity(privateKey);
}

export type Signer = {
  agentId: AgentId;
  // The origin of the API URL. Every payload is signed with it as aud.
  aud: string;
  // A request to one route, signed with that route's purpose too.
  sign(payload: object, purpose: RequestPurpose): Promise<string>;
  // An event, or the fingerprint declaration a sync sends beside its
  // events. Neither names a purpose.
  signEvent(payload: object): Promise<string>;
};

// The only place the CLI signs. It loads the local key once and hands every
// payload to the schema helper, with kid set to the agent id and aud set to
// the origin of apiUrl. sync uses one signer per run so a batch of 500 reads
// the key file once.
export async function loadSigner(
  apiUrl: string,
  p: Paths = paths(),
): Promise<Signer> {
  // The same refusal the API client gives, so a bad apiUrl reads the same
  // whether it is caught here or at the first request.
  if (!isSecureApiUrl(apiUrl)) {
    throw new ApiError(
      0,
      'insecure_api_url',
      `refusing the SealKeeper API at ${apiUrl}, ${INSECURE_API_URL}`,
    );
  }
  const aud = audienceOf(apiUrl);
  const key = await loadKey(p);
  if (key === null) throw new KeyError(NO_KEY);
  return {
    agentId: key.agentId,
    aud,
    sign: (payload, purpose) =>
      signRequest(payload, key.privateKey, key.agentId, aud, purpose),
    signEvent: (payload) =>
      signRequest(payload, key.privateKey, key.agentId, aud),
  };
}

export async function signEnvelope(
  payload: object,
  apiUrl: string,
  purpose: RequestPurpose,
  p: Paths = paths(),
): Promise<string> {
  return (await loadSigner(apiUrl, p)).sign(payload, purpose);
}

// Accepts exactly 43 base64url characters with at most one trailing newline.
// base64urlDecode rejects non canonical trailing bits.
export function decodeSeed(raw: string): Uint8Array | null {
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!/^[A-Za-z0-9_-]{43}$/.test(line)) return null;
  try {
    return base64urlDecode(line);
  } catch {
    return null;
  }
}

// A key brought to init --key-file. Neither the messages nor anything else
// here ever includes the text read or the path it came from, since a key
// pasted in place of a path would show.
export const KEY_FILE_UNREADABLE = 'cannot read the key file';
export const KEY_FILE_NOT_REGULAR =
  'the key path is not a regular file, give a file, or pipe the key to --key-file -';
export const KEY_FILE_INVALID =
  'the key is not an Ed25519 private key, expected a 32 byte seed or a 64 byte seed followed by its public key, in base64url, base64 or hex';
export const KEY_FILE_MISMATCH =
  'the key is 64 bytes but its second half is not the public key of its first half';

// More than any accepted form, with room for whitespace around it.
const KEY_FILE_MAX = 4096;

// The brought key read from a file, or from input when source is -, as the
// seed with its public key and agent id.
export async function readBroughtKey(
  source: string,
  input: () => Promise<string>,
): Promise<LoadedKey> {
  let raw: string;
  if (source === '-') {
    raw = await input();
  } else {
    try {
      const info = await stat(source);
      if (!info.isFile()) throw new KeyError(KEY_FILE_NOT_REGULAR);
      if (info.size > KEY_FILE_MAX) throw new KeyError(KEY_FILE_INVALID);
      raw = await readFile(source, 'utf8');
    } catch (error) {
      if (error instanceof KeyError) throw error;
      throw new KeyError(KEY_FILE_UNREADABLE);
    }
  }
  return seedIdentity(await decodeBroughtKey(raw));
}

// All of a stream as text, refused past KEY_FILE_MAX bytes.
export async function readKeyStream(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += bytes.length;
    if (size > KEY_FILE_MAX) throw new KeyError(KEY_FILE_INVALID);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The seed of a brought key. One value, whitespace around it trimmed, of 32
// bytes, the seed, or 64 bytes, the seed followed by its public key. Hex is
// 64 or 128 hex digits. Anything else is read as base64 or base64url, padded
// or not, and must decode to 32 or 64 bytes and encode back to the same
// text, so stray characters or trailing bits are refused. The second half of
// a 64 byte key must be the public key of its first half.
export async function decodeBroughtKey(raw: string): Promise<Uint8Array> {
  const bytes = decodeKeyText(raw.trim());
  if (bytes === null) throw new KeyError(KEY_FILE_INVALID);
  const seed = bytes.slice(0, 32);
  if (bytes.length === 64) {
    const publicKey = await getPublicKeyAsync(seed);
    if (!Buffer.from(publicKey).equals(Buffer.from(bytes.subarray(32)))) {
      throw new KeyError(KEY_FILE_MISMATCH);
    }
  }
  return seed;
}

function decodeKeyText(text: string): Uint8Array | null {
  if (/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(text)) {
    return new Uint8Array(Buffer.from(text, 'hex'));
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  if (text.includes('=') && text.length % 4 !== 0) return null;
  const url = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const bytes = Buffer.from(url, 'base64url');
  if (bytes.length !== 32 && bytes.length !== 64) return null;
  if (bytes.toString('base64url') !== url) return null;
  return new Uint8Array(bytes);
}
