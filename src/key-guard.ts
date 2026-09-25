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

// The private key as the CLI stores it, loaded once per key file for the
// run, so a key file with loose permissions warns once and not on every
// check. null when there is no key or it cannot be read.
const loaded = new Map<string, Promise<string | null>>();
function storedKey(): Promise<string | null> {
  const file = paths().key;
  let key = loaded.get(file);
  if (key === undefined) {
    key = loadKey()
      .then((k) => (k === null ? null : base64urlEncode(k.privateKey)))
      .catch(() => null);
    loaded.set(file, key);
  }
  return key;
}

// True when text holds this agent's private key, also when it was split
// across lines or spaced out, since whitespace is taken out first.
export async function containsPrivateKey(text: string): Promise<boolean> {
  const key = await storedKey();
  return key !== null && text.replace(/\s+/g, '').includes(key);
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
