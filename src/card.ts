// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  credentialExtension,
} from '@vouched-dev/schema';
import type { Command } from 'commander';
import { ApiError, createApiClient, resolveApiUrl } from './api.js';
import { loadConfig } from './commands/sync.js';
import { NOT_INITIALISED } from './commands/whoami.js';
import type { Config } from './config.js';
import { PROFILE_BASE_URL } from './config.js';
import {
  type Credential,
  CredentialError,
  getCredential,
} from './credential.js';
import { stderr } from './output.js';

// card show and card write build the same card. fetch is injectable so tests
// can stand in for the API.
export type CardDeps = {
  fetch: typeof fetch;
};

export const defaultCardDeps: CardDeps = {
  fetch: (...args) => fetch(...args),
};

// Short, so a scheduled card write never hangs on a slow network.
const CARD_TIMEOUT_MS = 10_000;

export const NO_CREDENTIAL =
  'warning: could not get a Vouched credential, the card carries no credential extension';

const CardUrl = AgentCard.shape.url.unwrap();

export function buildCard(
  config: Config,
  credential: Credential | null,
  url?: string,
): AgentCard {
  const profile = `${PROFILE_BASE_URL}/${config.agentId}`;
  return AgentCard.parse({
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: config.name,
    description: `Vouched agent ${config.agentId}. Verified track record at ${profile}`,
    ...(url === undefined ? {} : { url }),
    version: config.version,
    capabilities: {
      extensions: credential
        ? [credentialExtension(credential.credential)]
        : [],
    },
    skills: [],
  });
}

// Everything card show and card write share. Ends the command with the init
// hint when there is no config, and with the reason when the API sent
// something unusable.
export async function loadCard(
  cmd: Command,
  deps: CardDeps,
  url: string | undefined,
): Promise<AgentCard> {
  if (url !== undefined && !CardUrl.safeParse(url).success) {
    cmd.error(`--url must be an https URL, got ${url}`);
  }
  const config = await loadConfig(cmd);
  if (config === null) cmd.error(NOT_INITIALISED);

  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
    timeoutMs: CARD_TIMEOUT_MS,
  });
  let credential: Credential | null;
  try {
    credential = await getCredential({ api, agentId: config.agentId });
  } catch (error) {
    if (error instanceof CredentialError || error instanceof ApiError) {
      cmd.error(error.message);
    }
    throw error;
  }
  if (credential === null) stderr(NO_CREDENTIAL);
  return buildCard(config, credential, url);
}
