// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { base64urlEncode } from '@sealkeeper/schema';
import { paths } from './config.js';
import { loadKey } from './identity.js';

// What keeps the agent's private key out of anything that leaves the
// machine as text, a task submission or a task spec. A spec or an answer
// may be written by an agent that another agent's spec told what to do, so
// both ask here before they send.

// The SealKeeper home, resolved, when file is inside it, else null. Paths
// are compared after realpath, so a symlink into the home is caught too.
export async function insideHome(file: string): Promise<string | null> {
  const home = await realpath(paths().home).catch(() => paths().home);
  const target = await realpath(file).catch(() => file);
  return target === home || target.startsWith(`${home}${sep}`) ? home : null;
}

// The forms of the private key an agent might write out, loaded once per
// key file for the run, so a key file with loose permissions warns once and
// not on every check. null when there is no key or it cannot be read.
type KeyForms = {
  // Compared with the text as it is. Each base64 and base64url form is only
  // the aligned prefix of the encoding, see alignedPrefix.
  exact: string[];
  // Compared with the text in lower case, for hex in either case.
  lower: string[];
};

const loaded = new Map<string, Promise<KeyForms | null>>();
function storedKey(): Promise<KeyForms | null> {
  const file = paths().key;
  let key = loaded.get(file);
  if (key === undefined) {
    key = loadKey()
      .then((k) => (k === null ? null : keyForms(k.privateKey)))
      .catch(() => null);
    loaded.set(file, key);
  }
  return key;
}

// The part of the base64 or base64url encoding of bytes that stays the same
// whatever follows them. Each 4 characters carry 3 bytes, and the last,
// partial group also carries bits of the next bytes when more follow, as in
// the 64 byte ed25519 secret key (seed then public key). So only the whole
// groups are kept, the first 40 characters (30 bytes, 240 bits) for the 32
// byte seed. Padding falls in the partial group, so it goes too.
function alignedPrefix(bytes: Buffer, encoding: 'base64' | 'base64url') {
  return bytes.toString(encoding).slice(0, Math.floor(bytes.length / 3) * 4);
}

// The seed as base64url (the key file line), as standard base64, as hex,
// and the key file line itself in base64 and base64url. The line with and
// without its line break shares the same aligned prefix.
export function keyForms(seed: Uint8Array): KeyForms {
  const bytes = Buffer.from(seed);
  const line = Buffer.from(base64urlEncode(seed), 'utf8');
  const exact = [
    alignedPrefix(bytes, 'base64url'),
    alignedPrefix(bytes, 'base64'),
    alignedPrefix(line, 'base64'),
    alignedPrefix(line, 'base64url'),
  ];
  return { exact: [...new Set(exact)], lower: [bytes.toString('hex')] };
}

// True when text holds this agent's private key in any of the forms above,
// also when it was split across lines or spaced out, since whitespace is
// taken out first.
export async function containsPrivateKey(text: string): Promise<boolean> {
  const forms = await storedKey();
  if (forms === null) return false;
  const flat = text.replace(/\s+/g, '');
  if (forms.exact.some((form) => flat.includes(form))) return true;
  const lower = flat.toLowerCase();
  return forms.lower.some((form) => lower.includes(form));
}

// True when any string inside value, however deep, holds the private key.
// The strings are read as they are, not as JSON, which would escape the
// line breaks a split key may carry.
export async function holdsPrivateKey(value: unknown): Promise<boolean> {
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        strings.push(k);
        walk(x);
      }
    }
  };
  walk(value);
  for (const s of strings) if (await containsPrivateKey(s)) return true;
  return false;
}
