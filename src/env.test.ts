// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveApiUrl } from './api.js';
import { sealkeeperHome } from './config.js';
import { readEnv } from './env.js';
import { githubClientId } from './github-device.js';

describe('env vars', () => {
  it('reads the trimmed value', () => {
    expect(
      readEnv('SEALKEEPER_API_URL', { SEALKEEPER_API_URL: ' http://new ' }),
    ).toBe('http://new');
  });

  it('treats empty values as unset', () => {
    expect(
      readEnv('SEALKEEPER_HOME', { SEALKEEPER_HOME: ' ' }),
    ).toBeUndefined();
    expect(readEnv('SEALKEEPER_HOME', {})).toBeUndefined();
  });

  it('home is SEALKEEPER_HOME, else ~/.sealkeeper', () => {
    expect(sealkeeperHome({ SEALKEEPER_HOME: '/x/y' })).toBe('/x/y');
    expect(sealkeeperHome({})).toBe(join(homedir(), '.sealkeeper'));
  });

  it('ignores the old VOUCHED_* names', () => {
    expect(sealkeeperHome({ VOUCHED_HOME: '/old' })).toBe(
      join(homedir(), '.sealkeeper'),
    );
    expect(
      resolveApiUrl({ config: 'http://c' }, { VOUCHED_API_URL: 'http://o' }),
    ).toBe('http://c');
    expect(githubClientId({ VOUCHED_GITHUB_CLIENT_ID: 'old' })).toBeNull();
  });

  it('reads the GitHub client id trimmed', () => {
    expect(githubClientId({ SEALKEEPER_GITHUB_CLIENT_ID: ' abc ' })).toBe(
      'abc',
    );
  });
});
