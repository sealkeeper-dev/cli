// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from './config.js';
import { loadKey } from './identity.js';
import { containsPrivateKey, holdsPrivateKey } from './key-guard.js';

describe('containsPrivateKey (cli-core-8)', () => {
  let home: string;
  let line: string;
  let seed: Buffer;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'sealkeeper-kg-')));
    vi.stubEnv('SEALKEEPER_HOME', home);
    // A fixed seed whose standard base64 has + and / in it, so that form
    // differs from base64url.
    seed = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xf0 + (i % 16)));
    await writeFile(paths(home).key, `${seed.toString('base64url')}\n`, {
      mode: 0o600,
    });
    line = (await readFile(paths(home).key, 'utf8')).trim();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');

  it('finds the base64url seed, also split and spaced', async () => {
    expect(await containsPrivateKey(`key ${line} here`)).toBe(true);
    const spaced = line.replace(/(.{8})/g, '$1 \n');
    expect(await containsPrivateKey(spaced)).toBe(true);
  });

  it('finds the seed as standard base64 with padding', async () => {
    const padded = seed.toString('base64');
    expect(padded).toMatch(/[+/].*=$/);
    expect(await containsPrivateKey(`x ${padded} y`)).toBe(true);
  });

  it('finds the seed as standard base64 without padding', async () => {
    const bare = seed.toString('base64').replace(/=+$/, '');
    expect(await containsPrivateKey(`x${bare}y`)).toBe(true);
  });

  it('finds the seed as lower case hex', async () => {
    expect(await containsPrivateKey(seed.toString('hex'))).toBe(true);
  });

  it('finds the seed as upper case hex, also spaced', async () => {
    const upper = seed.toString('hex').toUpperCase();
    expect(await containsPrivateKey(`0x${upper}`)).toBe(true);
    expect(await containsPrivateKey(upper.replace(/(..)/g, '$1 '))).toBe(true);
  });

  it('finds the key file line as base64, with and without its line break', async () => {
    expect(await containsPrivateKey(b64(`${line}\n`))).toBe(true);
    expect(await containsPrivateKey(b64(line))).toBe(true);
    const url = Buffer.from(`${line}\n`).toString('base64url');
    expect(await containsPrivateKey(url)).toBe(true);
  });

  it('finds the 64 byte secret key, seed then public key, in base64 and base64url', async () => {
    const key = await loadKey(paths(home));
    expect(key).not.toBeNull();
    const secret = Buffer.concat([seed, Buffer.from(key?.publicKey ?? [])]);
    expect(secret).toHaveLength(64);
    // The seed's last character changes when the public key follows it, so
    // the full encoding of the seed alone is not in these.
    const std = secret.toString('base64');
    const url = secret.toString('base64url');
    expect(std).not.toContain(seed.toString('base64').replace(/=+$/, ''));
    expect(url).not.toContain(line);
    expect(await containsPrivateKey(`secret ${std}`)).toBe(true);
    expect(await containsPrivateKey(`secret ${url}`)).toBe(true);
  });

  it('finds the key file line in base64 with more text after it', async () => {
    expect(await containsPrivateKey(b64(`${line}\n# a comment\n`))).toBe(true);
    const url = Buffer.from(`${line} and more`).toString('base64url');
    expect(await containsPrivateKey(url)).toBe(true);
  });

  it('finds a form deep inside a value', async () => {
    expect(
      await holdsPrivateKey({ a: [{ b: seed.toString('hex').toUpperCase() }] }),
    ).toBe(true);
  });

  it('passes text that holds no form of the key', async () => {
    expect(await containsPrivateKey('an ordinary answer')).toBe(false);
    expect(await containsPrivateKey(line.slice(0, 20))).toBe(false);
    expect(await containsPrivateKey(seed.toString('hex').slice(0, 40))).toBe(
      false,
    );
  });
});
