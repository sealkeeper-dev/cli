// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// check and assertTrusted from sealkeeper/mastra, with a mocked fetch.
import type { SealCheckResponse } from '@sealkeeper/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertTrusted, check, SealKeeperCheckError } from './mastra.js';

const answer = (ok: boolean): SealCheckResponse => ({
  ok,
  id: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  handle: 'carelmeyer/claude-code',
  checks: [
    { name: 'minVerified', required: 5, actual: ok ? 7 : 2, ok },
    { name: 'maxIncidents', required: 0, actual: 0, ok: true },
  ],
  credential: 'eyJh.eyJi.c2ln',
  seal: 'eyJh.eyJi.c2ln',
});

function fakeFetch(res: () => Response) {
  const urls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input));
    return res();
  }) as unknown as typeof fetch;
  return { fn, urls };
}

describe('mastra check', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns the answer and sends only the thresholds given', async () => {
    const { fn, urls } = fakeFetch(() => Response.json(answer(false)));
    const result = await check(
      'carelmeyer/claude-code',
      { minVerified: 5, minReliability: 0.8 },
      { apiUrl: 'https://api.test/', fetch: fn },
    );
    expect(result).toEqual(answer(false));
    expect(urls).toEqual([
      'https://api.test/v1/check/carelmeyer/claude-code?minVerified=5&minReliability=0.8',
    ]);
  });

  it('uses SEALKEEPER_API_URL and the global fetch by default', async () => {
    vi.stubEnv('SEALKEEPER_API_URL', 'https://env.test');
    const { fn, urls } = fakeFetch(() => Response.json(answer(true)));
    vi.stubGlobal('fetch', fn);
    await check('carelmeyer/claude-code');
    expect(urls).toEqual(['https://env.test/v1/check/carelmeyer/claude-code']);
  });

  it('assertTrusted resolves when every check passed', async () => {
    const { fn } = fakeFetch(() => Response.json(answer(true)));
    await expect(
      assertTrusted(
        'carelmeyer/claude-code',
        { minVerified: 5 },
        { apiUrl: 'https://api.test', fetch: fn },
      ),
    ).resolves.toEqual(answer(true));
  });

  it('assertTrusted throws with the failing checks listed', async () => {
    const { fn } = fakeFetch(() => Response.json(answer(false)));
    const error = await assertTrusted(
      'carelmeyer/claude-code',
      { minVerified: 5 },
      { apiUrl: 'https://api.test', fetch: fn },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SealKeeperCheckError);
    const e = error as SealKeeperCheckError;
    expect(e.message).toBe(
      [
        'carelmeyer/claude-code did not pass the SealKeeper check',
        'FAIL verified tasks 2, need at least 5',
      ].join('\n'),
    );
    expect(e.failed).toEqual([answer(false).checks[0]]);
    expect(e.result).toEqual(answer(false));
  });

  it('assertTrusted throws when the SEAL is withheld, with no SEAL on the answer', async () => {
    const withheld: SealCheckResponse = {
      ...answer(true),
      ok: false,
      checks: [
        { name: 'seal', required: 'present', actual: 'withheld', ok: false },
        ...answer(true).checks,
      ],
      credential: null,
      seal: null,
    };
    const { fn } = fakeFetch(() => Response.json(withheld));
    const error = await assertTrusted(
      'carelmeyer/claude-code',
      { minLevel: 'none' },
      { apiUrl: 'https://api.test', fetch: fn },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SealKeeperCheckError);
    const e = error as SealKeeperCheckError;
    expect(e.message).toBe(
      [
        'carelmeyer/claude-code did not pass the SealKeeper check',
        'FAIL no SEAL, withheld while the agent is dormant, need a current SEAL',
      ].join('\n'),
    );
    expect(e.result.seal).toBeNull();
  });

  it('rejects for an unknown agent, a bad handle and a bad threshold', async () => {
    const { fn, urls } = fakeFetch(() =>
      Response.json(
        { error: { code: 'not_found', message: 'Agent not found' } },
        { status: 404 },
      ),
    );
    const options = { apiUrl: 'https://api.test', fetch: fn };
    await expect(check('carelmeyer/nobody', {}, options)).rejects.toMatchObject(
      { code: 'not_found', status: 404 },
    );
    await expect(check('nobody', {}, options)).rejects.toMatchObject({
      code: 'invalid_handle',
    });
    await expect(
      assertTrusted('carelmeyer/x1', { minSafety: 2 }, options),
    ).rejects.toMatchObject({ code: 'invalid_threshold' });
    expect(urls).toEqual(['https://api.test/v1/check/carelmeyer/nobody']);
  });
});
