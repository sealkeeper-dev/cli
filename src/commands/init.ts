// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { type RegisterAgentRequest, Version } from '@vouched-dev/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { ApiError, createApiClient, resolveApiUrl } from '../api.js';
import {
  Config,
  ConfigError,
  DEFAULT_AGENT_VERSION,
  paths,
  profileUrl as profileUrlOf,
  readConfig,
  writeConfig,
} from '../config.js';
import {
  DeviceFlowError,
  deviceFlow,
  githubClientId,
  MISSING_CLIENT_ID,
  type Sleep,
  sleep,
} from '../github-device.js';
import { createKey, KeyError, loadKey, signEnvelope } from '../identity.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { describeTaxonomy } from '../taxonomy.js';
import { printIdentity } from './whoami.js';

export const ALREADY_INITIALISED = 'already initialised';
export const NOTHING_SENT =
  'No events have been sent yet. Run vouched sync to review them and send.';
export { DEFAULT_AGENT_VERSION } from '../config.js';

// fetch and sleep are injectable so tests can drive GitHub and the API
// without a network or real waits.
export type InitDeps = {
  fetch: typeof fetch;
  sleep: Sleep;
};

type InitOptions = {
  name?: string;
  version: string;
  apiUrl?: string;
  force?: boolean;
};

const AgentName = z.string().min(1).max(64);

// One line per API error code the operator can act on. Anything else falls
// back to the code and the message the API sent.
const API_MESSAGES: Record<string, (message: string) => string> = {
  account_too_new: (m) =>
    `registration refused, your GitHub account is too new (${m})`,
  operator_cap_reached: (m) =>
    `registration refused, your GitHub account has reached its agent limit (${m})`,
  conflict: () =>
    'this key is already registered by another operator, run vouched init --force to create a new key',
  invalid_signature: () =>
    'the API rejected the registration signature, check the key file or run vouched init --force',
  github_token_rejected: () =>
    'the API could not verify your GitHub login, run vouched init again',
  network_error: (m) => m,
  bad_response: (m) => m,
};

function apiErrorMessage(error: ApiError): string {
  const known = API_MESSAGES[error.code];
  return known
    ? known(error.message)
    : `registration failed with ${error.code}, ${error.message}`;
}

export function register(
  parent: Command,
  deps: InitDeps = { fetch: (...args) => fetch(...args), sleep },
): Command {
  return parent
    .command('init')
    .description('Create a keypair, register via GitHub, write config')
    .option('--name <name>', 'agent name (default: current directory name)')
    .option('--version <version>', 'agent version', DEFAULT_AGENT_VERSION)
    .option('--api-url <url>', 'Vouched API base URL')
    .option('--force', 'regenerate the key and register again')
    .action(async function (this: Command, options: InitOptions) {
      try {
        await init(this, options, deps);
      } catch (error) {
        if (
          error instanceof ApiError ||
          error instanceof DeviceFlowError ||
          error instanceof KeyError ||
          error instanceof ConfigError
        ) {
          this.error(
            error instanceof ApiError ? apiErrorMessage(error) : error.message,
          );
        }
        throw error;
      }
    });
}

async function init(
  cmd: Command,
  options: InitOptions,
  deps: InitDeps,
): Promise<void> {
  const json = wantsJson(cmd);
  const p = paths();

  // Without --force an existing config ends the command here. With --force it
  // is read only for its apiUrl, so a re-register goes to the same API. A
  // broken config is no reason to block --force, so it counts as none.
  let previous: Config | null = null;
  if (options.force) {
    previous = await readConfig(p).catch((error: unknown) => {
      if (error instanceof ConfigError) return null;
      throw error;
    });
  } else {
    const existing = await readConfig(p);
    if (existing !== null) {
      if (!json) stdout(ALREADY_INITIALISED);
      printIdentity(existing, json);
      return;
    }
  }

  const clientId = githubClientId();
  if (clientId === null) cmd.error(MISSING_CLIENT_ID);

  const name = options.name ?? basename(process.cwd());
  if (!AgentName.safeParse(name).success) {
    cmd.error('agent name must be 1 to 64 characters, pass --name');
  }
  if (!Version.safeParse(options.version).success) {
    cmd.error('agent version must be 1 to 32 characters');
  }
  const apiUrl = resolveApiUrl({
    flag: options.apiUrl,
    config: previous?.apiUrl,
  });
  if (!Config.shape.apiUrl.safeParse(apiUrl).success) {
    cmd.error(`invalid API URL ${apiUrl}, expected an http or https URL`);
  }

  // With --force the old config describes the old key, so it goes as soon as
  // the new key exists. A failed registration then leaves a key and no
  // config, and a plain init picks up from there.
  let agentId: string;
  if (options.force) {
    agentId = (await createKey({ force: true }, p)).agentId;
    await rm(p.config, { force: true });
  } else {
    agentId = ((await loadKey(p)) ?? (await createKey({}, p))).agentId;
  }

  const githubToken = await deviceFlow({
    clientId,
    fetch: deps.fetch,
    sleep: deps.sleep,
  });

  const request: RegisterAgentRequest = {
    publicKey: agentId,
    githubToken,
    name,
    version: options.version,
  };
  const envelope = await signEnvelope(request, p);
  const api = createApiClient({ apiUrl, fetch: deps.fetch });
  const agent = await api.registerAgent(envelope);
  if (agent.id !== agentId) {
    throw new ApiError(
      0,
      'bad_response',
      'the API registered a different agent id than the local key',
    );
  }

  const config = await writeConfig(
    {
      agentId: agent.id,
      operatorLogin: agent.operator.login,
      name: agent.name,
      version: agent.version,
      apiUrl: api.apiUrl,
      registeredAt: agent.createdAt,
    },
    p,
  );

  const profileUrl = profileUrlOf(config.agentId);
  // On stderr, so --json output stays one object.
  const printShared = () => {
    stderr('');
    stderr(describeTaxonomy());
    stderr('');
    stderr(NOTHING_SENT);
  };
  if (json) {
    stdout(
      JSON.stringify({
        agentId: config.agentId,
        operatorLogin: config.operatorLogin,
        name: config.name,
        version: config.version,
        apiUrl: config.apiUrl,
        profileUrl,
      }),
    );
    printShared();
    return;
  }
  stdout(`registered agent ${config.agentId}`);
  stdout(`operator ${config.operatorLogin}`);
  stdout(`profile ${profileUrl}`);
  printShared();
}
