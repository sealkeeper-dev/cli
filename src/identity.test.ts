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
  KeyError,
  loadKey,
  NO_KEY,
  signEnvelope,
} from './identity.js';

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

  it('signs an envelope that verifies against the loaded public key', async () => {
    const { agentId } = await createKey();
    const payload = { event_id: 'x', type: 'tool.call', n: 1 };
    const jws = await signEnvelope(payload);

    const key = await loadKey();
    if (key === null) throw new Error('expected a key');
    expect(decodeHeader(jws)).toEqual({ alg: 'EdDSA', kid: agentId });
    expect(await verify(jws, key.publicKey)).toEqual({
      header: { alg: 'EdDSA', kid: agentId },
      payload,
    });
  });

  it('refuses to sign without a key', async () => {
    await expect(signEnvelope({ a: 1 })).rejects.toThrow(NO_KEY);
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

      const jws = await signEnvelope({ ok: true });
      expect(decodeHeader(jws).kid).toBe(v.agentId);
    },
  );

  it('never prints the private key', async () => {
    await createKey();
    const seed = (await readFile(paths().key, 'utf8')).trim();
    await chmod(paths().key, 0o644);
    await loadKey();
    await signEnvelope({ a: 1 });
    await expect(createKey()).rejects.toThrow();
    await writeFile(paths().key, `${seed}x\n`);
    const error = await loadKey().catch((e: Error) => e);
    expect(String(error)).not.toContain(seed);
    expect(printed()).not.toContain(seed);
  });
});
