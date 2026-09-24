// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApiUrl } from './api.js';
import { sealkeeperHome } from './config.js';
import { oldEnvWarning, readEnv, resetEnvWarnings } from './env.js';
import { githubClientId } from './github-device.js';

describe('renamed env vars', () => {
  let err: string;
  beforeEach(() => {
    err = '';
    resetEnvWarnings();
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the new name without a warning, and it wins over the old one', () => {
    expect(
      readEnv('SEALKEEPER_API_URL', {
        SEALKEEPER_API_URL: ' http://new ',
        VOUCHED_API_URL: 'http://old',
      }),
    ).toBe('http://new');
    expect(err).toBe('');
  });

  it('reads the old name with one warning naming the new one', () => {
    const env = { VOUCHED_API_URL: 'http://old' };
    expect(readEnv('SEALKEEPER_API_URL', env)).toBe('http://old');
    expect(readEnv('SEALKEEPER_API_URL', env)).toBe('http://old');
    expect(err).toBe(
      'warning: VOUCHED_API_URL is deprecated, use SEALKEEPER_API_URL\n',
    );
    expect(err).toBe(`${oldEnvWarning('SEALKEEPER_API_URL')}\n`);
  });

  it('treats empty values as unset', () => {
    expect(
      readEnv('SEALKEEPER_HOME', { SEALKEEPER_HOME: '', VOUCHED_HOME: ' ' }),
    ).toBeUndefined();
    expect(err).toBe('');
  });

  it('home is SEALKEEPER_HOME, else the old VOUCHED_HOME, else ~/.sealkeeper', () => {
    expect(sealkeeperHome({ SEALKEEPER_HOME: '/x/y' })).toBe('/x/y');
    expect(sealkeeperHome({ VOUCHED_HOME: '/old' })).toBe('/old');
    expect(err).toBe(
      'warning: VOUCHED_HOME is deprecated, use SEALKEEPER_HOME\n',
    );
    expect(sealkeeperHome({})).toBe(join(homedir(), '.sealkeeper'));
  });

  it('the API URL falls back to VOUCHED_API_URL with a warning', () => {
    expect(
      resolveApiUrl({ config: 'http://c' }, { VOUCHED_API_URL: 'http://o' }),
    ).toBe('http://o');
    expect(err).toContain('use SEALKEEPER_API_URL');
  });

  it('the GitHub client id falls back to VOUCHED_GITHUB_CLIENT_ID with a warning', () => {
    expect(githubClientId({ SEALKEEPER_GITHUB_CLIENT_ID: ' abc ' })).toBe(
      'abc',
    );
    expect(err).toBe('');
    expect(githubClientId({ VOUCHED_GITHUB_CLIENT_ID: 'old' })).toBe('old');
    expect(err).toBe(
      'warning: VOUCHED_GITHUB_CLIENT_ID is deprecated, use SEALKEEPER_GITHUB_CLIENT_ID\n',
    );
  });
});
