// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  agentIdFromPublicKey,
  base64urlEncode,
  decodeHeader,
  verify,
} from '@sealkeeper/schema';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { paths } from './config.js';
import {
  createKey,
  decodeBroughtKey,
  KEY_FILE_INVALID,
  KEY_FILE_MISMATCH,
  KEY_FILE_NOT_REGULAR,
  KEY_FILE_UNREADABLE,
  KeyError,
  loadKey,
  loadSigner,
  NO_KEY,
  readBroughtKey,
  readKeyStream,
  signEnvelope,
} from './identity.js';

const API = 'https://api.sealkeeper.run';

const hex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

// Copied from the agent id tests in @sealkeeper/schema. RFC 8032 section 7.1 tests
// 1 and 2. The CLI and the API must agree on these ids.
const VECTORS = [
  {
    secretKey:
      '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey:
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    agentId: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  },
  {
    secretKey:
      '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey:
      '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    agentId: 'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw',
  },
];

describe('identity', () => {
  let root: string;
  let home: string;
  let savedHome: string | undefined;
  let err: MockInstance<typeof process.stderr.write>;
  let out: MockInstance<typeof process.stdout.write>;

  const printed = () =>
    [...err.mock.calls, ...out.mock.calls].map((c) => String(c[0])).join('');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sealkeeper-identity-'));
    home = join(root, 'home');
    savedHome = process.env.SEALKEEPER_HOME;
    process.env.SEALKEEPER_HOME = home;
    err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.SEALKEEPER_HOME;
    else process.env.SEALKEEPER_HOME = savedHome;
    await rm(root, { recursive: true, force: true });
  });

  it('writes the key with mode 600 and the home with mode 700', async () => {
    await createKey();
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(paths().key)).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(['key']);
    expect(await readFile(paths().key, 'utf8')).toMatch(
      /^[A-Za-z0-9_-]{43}\n$/,
    );
  });

  it('returns an agent id derived from the public key', async () => {
    const { agentId, publicKey } = await createKey();
    expect(publicKey).toHaveLength(32);
    expect(agentId).toBe(agentIdFromPublicKey(publicKey));

    const loaded = await loadKey();
    expect(loaded?.agentId).toBe(agentId);
    expect(loaded?.publicKey).toEqual(publicKey);
  });

  it('refuses to overwrite an existing key unless forced', async () => {
    const first = await createKey();
    await expect(createKey()).rejects.toThrow(KeyError);
    await expect(createKey()).rejects.toThrow(/already exists/);
    expect((await loadKey())?.agentId).toBe(first.agentId);

    const second = await createKey({ force: true });
    expect(second.agentId).not.toBe(first.agentId);
    expect((await loadKey())?.agentId).toBe(second.agentId);
    expect((await stat(paths().key)).mode & 0o777).toBe(0o600);

    // The replaced key is kept, readable only by the owner, and still loads.
    const backup = second.backup ?? '';
    expect(backup).toMatch(/\/key\.[0-9T-]+Z\.bak$/);
    expect((await readdir(home)).sort()).toEqual(
      ['key', basename(backup)].sort(),
    );
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect((await loadKey({ ...paths(), key: backup }))?.agentId).toBe(
      first.agentId,
    );
  });

  it('returns null when there is no key', async () => {
    expect(await loadKey()).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not base64url', `${'!'.repeat(43)}\n`],
    ['too short', `${'A'.repeat(42)}\n`],
    ['too long', `${'A'.repeat(44)}\n`],
    ['two lines', `${'A'.repeat(43)}\n${'A'.repeat(43)}\n`],
    ['non canonical', `${'A'.repeat(42)}B\n`],
  ])('throws a clear error for a malformed key (%s)', async (_, content) => {
    await createKey();
    await writeFile(paths().key, content);
    await expect(loadKey()).rejects.toThrow(KeyError);
    await expect(loadKey()).rejects.toThrow(/Invalid key at .*32 byte/);
  });

  it('warns on stderr when the key file mode is 644', async () => {
    const { agentId } = await createKey();
    await loadKey();
    expect(err).not.toHaveBeenCalled();

    await chmod(paths().key, 0o644);
    const loaded = await loadKey();
    expect(loaded?.agentId).toBe(agentId);
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0]?.[0]);
    expect(line).toMatch(/^warning: key file .* has mode 644, run chmod 600 /);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
  });

  it('skips the mode check on Windows, where every file reads as 666', async () => {
    const { agentId } = await createKey();
    await chmod(paths().key, 0o666);
    const loaded = await loadKey(paths(), 'win32');
    expect(loaded?.agentId).toBe(agentId);
    expect(err).not.toHaveBeenCalled();
    // Any other platform still warns.
    await loadKey(paths(), 'linux');
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('signs an envelope that verifies against the loaded public key', async () => {
    const { agentId } = await createKey();
    const payload = { issuedAt: '2026-10-05T00:00:00.000Z' };
    const jws = await signEnvelope(payload, `${API}/`, 'agent.status');

    const key = await loadKey();
    if (key === null) throw new Error('expected a key');
    expect(decodeHeader(jws)).toEqual({ alg: 'EdDSA', kid: agentId });
    expect(await verify(jws, key.publicKey)).toEqual({
      header: { alg: 'EdDSA', kid: agentId },
      payload: { ...payload, aud: API, purpose: 'agent.status' },
    });
  });

  it('sets aud to the origin of the API URL', async () => {
    await createKey();
    const signer = await loadSigner('http://localhost:8080/some/path');
    expect(signer.aud).toBe('http://localhost:8080');
    const key = await loadKey();
    if (key === null) throw new Error('expected a key');
    const { payload } = await verify(
      await signer.sign({ a: 1 }, 'agent.delete'),
      key.publicKey,
    );
    expect(payload).toEqual({
      a: 1,
      aud: 'http://localhost:8080',
      purpose: 'agent.delete',
    });
  });

  // An event and the sync's fingerprint declaration name no
  // purpose, and every request names its route's.
  it('signs an event with aud and no purpose', async () => {
    await createKey();
    const signer = await loadSigner(API);
    const key = await loadKey();
    if (key === null) throw new Error('expected a key');
    const event = { event_id: 'x', type: 'tool.call', n: 1 };
    const { payload } = await verify(
      await signer.signEvent(event),
      key.publicKey,
    );
    expect(payload).toEqual({ ...event, aud: API });
  });

  it('refuses to sign for an insecure API URL', async () => {
    await createKey();
    await expect(loadSigner('http://api.example.com')).rejects.toThrow(
      /refusing the SealKeeper API/,
    );
  });

  it('refuses to sign without a key', async () => {
    await expect(signEnvelope({ a: 1 }, API, 'agent.status')).rejects.toThrow(
      NO_KEY,
    );
  });

  it.each(VECTORS)(
    'derives the fixed vector id $agentId from a hand written key file',
    async (v) => {
      await mkdir(home, { mode: 0o700 });
      await writeFile(paths().key, `${base64urlEncode(hex(v.secretKey))}\n`, {
        mode: 0o600,
      });
      const key = await loadKey();
      expect(key?.privateKey).toEqual(hex(v.secretKey));
      expect(key?.publicKey).toEqual(hex(v.publicKey));
      expect(key?.agentId).toBe(v.agentId);

      const jws = await signEnvelope({ ok: true }, API, 'agent.status');
      expect(decodeHeader(jws).kid).toBe(v.agentId);
    },
  );

  it('never prints the private key', async () => {
    await createKey();
    const seed = (await readFile(paths().key, 'utf8')).trim();
    await chmod(paths().key, 0o644);
    await loadKey();
    await signEnvelope({ a: 1 }, API, 'agent.status');
    await expect(createKey()).rejects.toThrow();
    await writeFile(paths().key, `${seed}x\n`);
    const error = await loadKey().catch((e: Error) => e);
    expect(String(error)).not.toContain(seed);
    expect(printed()).not.toContain(seed);
  });
});

describe('a brought key', () => {
  const one = VECTORS[0] as (typeof VECTORS)[number];
  const two = VECTORS[1] as (typeof VECTORS)[number];
  const seed = Buffer.from(one.secretKey, 'hex');
  const pair = Buffer.concat([seed, Buffer.from(one.publicKey, 'hex')]);
  const crossed = Buffer.concat([seed, Buffer.from(two.publicKey, 'hex')]);

  it.each([
    ['hex', one.secretKey],
    ['upper case hex', one.secretKey.toUpperCase()],
    ['base64url', seed.toString('base64url')],
    ['padded base64', seed.toString('base64')],
    ['unpadded base64', seed.toString('base64').replace(/=+$/, '')],
    ['64 byte hex', pair.toString('hex')],
    ['64 byte base64', pair.toString('base64')],
    ['64 byte base64url', pair.toString('base64url')],
    ['whitespace around it', `  \n${seed.toString('base64url')}\r\n\n`],
  ])('reads the seed from %s', async (_, text) => {
    const decoded = await decodeBroughtKey(text);
    expect(Buffer.from(decoded).toString('hex')).toBe(one.secretKey);
  });

  it('refuses a 64 byte key whose second half is another public key', async () => {
    for (const text of [crossed.toString('hex'), crossed.toString('base64')]) {
      const error = await decodeBroughtKey(text).catch((e: Error) => e);
      expect(error).toBeInstanceOf(KeyError);
      expect((error as Error).message).toBe(KEY_FILE_MISMATCH);
      expect((error as Error).message).not.toContain(text);
    }
  });

  it.each([
    ['empty', ''],
    ['a word', 'not-a-key'],
    ['31 bytes', seed.subarray(0, 31).toString('base64url')],
    ['33 bytes', Buffer.concat([seed, Buffer.from([1])]).toString('base64url')],
    ['48 bytes', Buffer.alloc(48, 7).toString('base64')],
    ['63 hex digits', one.secretKey.slice(1)],
    ['two values', `${one.secretKey} ${one.secretKey}`],
    ['trailing bits set', `${seed.toString('base64url').slice(0, 42)}B`],
    ['bad padding', `${seed.toString('base64url')}==`],
    [
      'a PEM block',
      `-----BEGIN PRIVATE KEY-----\n${seed.toString('base64')}\n-----END PRIVATE KEY-----`,
    ],
  ])('refuses %s without echoing it', async (_, text) => {
    const error = await decodeBroughtKey(text).catch((e: Error) => e);
    expect(error).toBeInstanceOf(KeyError);
    expect((error as Error).message).toBe(KEY_FILE_INVALID);
    if (text.trim() !== '') {
      expect((error as Error).message).not.toContain(text.trim());
    }
  });

  it('reads a key file or the input for -, and gives the agent id of its public key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sealkeeper-brought-'));
    try {
      const file = join(root, 'agent.key');
      await writeFile(file, `${one.secretKey}\n`);
      const fromFile = await readBroughtKey(file, async () => '');
      expect(fromFile.agentId).toBe(one.agentId);
      const fromInput = await readBroughtKey('-', async () =>
        seed.toString('base64'),
      );
      expect(fromInput.agentId).toBe(one.agentId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing file, a folder, a fifo and a large file without naming the path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sealkeeper-brought-'));
    try {
      const big = join(root, 'big');
      await writeFile(big, 'A'.repeat(5000));
      const missing = seed.toString('base64url');
      const cases: [string, string][] = [
        [missing, KEY_FILE_UNREADABLE],
        [root, KEY_FILE_NOT_REGULAR],
        [big, KEY_FILE_INVALID],
      ];
      if (process.platform !== 'win32') {
        const { execFileSync } = await import('node:child_process');
        const fifo = join(root, 'fifo');
        execFileSync('mkfifo', [fifo]);
        cases.push([fifo, KEY_FILE_NOT_REGULAR]);
      }
      for (const [path, message] of cases) {
        const error = await readBroughtKey(path, async () => '').catch(
          (e: Error) => e,
        );
        expect(error).toBeInstanceOf(KeyError);
        expect((error as Error).message).toBe(message);
        expect((error as Error).message).not.toContain(path);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a stream to its end and refuses one past 4096 bytes', async () => {
    expect(await readKeyStream(Readable.from(['ab', Buffer.from('cd')]))).toBe(
      'abcd',
    );
    await expect(
      readKeyStream(Readable.from([Buffer.alloc(5000, 65)])),
    ).rejects.toThrow(KEY_FILE_INVALID);
  });

  it('writes a brought seed as the key file a new key would be', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sealkeeper-brought-'));
    const p = paths(join(root, 'home'));
    try {
      const made = await createKey({ seed }, p);
      expect(made.agentId).toBe(one.agentId);
      expect(await readFile(p.key, 'utf8')).toBe(
        `${seed.toString('base64url')}\n`,
      );
      expect((await stat(p.key)).mode & 0o777).toBe(0o600);
      await expect(createKey({ seed }, p)).rejects.toThrow(/already exists/);
      const replaced = await createKey(
        { force: true, seed: Buffer.from(two.secretKey, 'hex') },
        p,
      );
      expect(replaced.agentId).toBe(two.agentId);
      expect(
        (await loadKey({ ...p, key: replaced.backup ?? '' }))?.agentId,
      ).toBe(one.agentId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
