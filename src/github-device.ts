// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { z } from 'zod';
import { readEnv } from './env.js';
import { cli } from './invocation.js';
import { stderr } from './output.js';

// GitHub OAuth device flow. The operator opens a URL, types a short code and
// approves the app. The CLI polls until GitHub hands back an access token.
// No scope is requested, so the token can read only public profile data,
// which is all the API needs to find the operator's login and account age.
// The token is returned to the caller and never printed or written here.

export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const CLIENT_ID_ENV = 'SEALKEEPER_GITHUB_CLIENT_ID';
export const MISSING_CLIENT_ID = `missing GitHub OAuth client id, set ${CLIENT_ID_ENV}`;
export const CODE_EXPIRED = `the GitHub code expired, run ${cli('init')} again`;
export const ACCESS_DENIED = 'GitHub authorisation was denied';

const SLOW_DOWN_SECONDS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

// Replaced at build time by tsup from GITHUB_CLIENT_ID and at test time by
// vitest with the empty string.
declare const __GITHUB_CLIENT_ID__: string;

// The runtime env var wins over the value baked into the bundle. Returns
// null when neither is set.
export function githubClientId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = readEnv(CLIENT_ID_ENV, env);
  if (fromEnv) return fromEnv;
  const built = __GITHUB_CLIENT_ID__.trim();
  return built.length > 0 ? built : null;
}

export class DeviceFlowError extends Error {
  override name = 'DeviceFlowError';
}

export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

type DeviceFlowOptions = {
  clientId: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  out?: (line: string) => void;
  // Shows the URL and the code. Without it the two plain lines below go to
  // out, which is what --json runs print.
  prompt?: (url: string, code: string) => void;
};

const DeviceCodeResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().nonnegative(),
});

const TokenResponse = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({
    error: z.string().min(1),
    error_description: z.string().optional(),
  }),
]);

async function post(
  fetchFn: typeof fetch,
  url: string,
  params: Record<string, string>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DeviceFlowError(
      `could not reach GitHub: ${(error as Error).message}`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new DeviceFlowError(
      `GitHub returned an unreadable response (HTTP ${res.status})`,
    );
  }
}

// Runs the whole flow and returns the access token.
export async function deviceFlow(options: DeviceFlowOptions): Promise<string> {
  const fetchFn = options.fetch ?? fetch;
  const wait = options.sleep ?? sleep;
  const out = options.out ?? stderr;

  const code = DeviceCodeResponse.safeParse(
    await post(fetchFn, DEVICE_CODE_URL, { client_id: options.clientId }),
  );
  if (!code.success) {
    throw new DeviceFlowError(
      'GitHub did not start the device flow, check the OAuth client id',
    );
  }
  const { device_code, user_code, verification_uri, expires_in } = code.data;

  if (options.prompt) {
    options.prompt(verification_uri, user_code);
  } else {
    out(`Open ${verification_uri}`);
    out(`Enter code ${user_code}`);
  }

  let intervalSeconds = code.data.interval;
  let waitedSeconds = 0;
  for (;;) {
    if (waitedSeconds >= expires_in) {
      throw new DeviceFlowError(CODE_EXPIRED);
    }
    await wait(intervalSeconds * 1000);
    waitedSeconds += intervalSeconds;

    const token = TokenResponse.safeParse(
      await post(fetchFn, ACCESS_TOKEN_URL, {
        client_id: options.clientId,
        device_code,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    );
    if (!token.success) {
      throw new DeviceFlowError('GitHub returned an unexpected token response');
    }
    if ('access_token' in token.data) return token.data.access_token;

    switch (token.data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalSeconds += SLOW_DOWN_SECONDS;
        continue;
      case 'expired_token':
        throw new DeviceFlowError(CODE_EXPIRED);
      case 'access_denied':
        throw new DeviceFlowError(ACCESS_DENIED);
      default:
        throw new DeviceFlowError(
          `GitHub device flow failed: ${token.data.error_description ?? token.data.error}`,
        );
    }
  }
}
