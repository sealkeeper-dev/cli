// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  sealExtensions,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError, createApiClient, resolveApiUrl } from './api.js';
import { requireConfig } from './cli-config.js';
import type { Config } from './config.js';
import { idProfileUrl } from './config.js';
import {
  type Credential,
  CredentialError,
  getCredential,
} from './credential.js';
import { makeHandshakeQuietly } from './handshake.js';
import { stderr } from './output.js';

// card show and card write build the same card, and the seal commands read
// the same SEAL. fetch is injectable so tests can stand in for the API.
export type CardDeps = {
  fetch: typeof fetch;
};

export const defaultCardDeps: CardDeps = {
  fetch: (...args) => fetch(...args),
};

// Short, so a scheduled card write never hangs on a slow network.
const CARD_TIMEOUT_MS = 10_000;

export const NO_CREDENTIAL =
  "warning: could not get the agent's SEAL, the card carries no SEAL extension";

const CardUrl = AgentCard.shape.url.unwrap();

// handshake is the agent's signed handshake (VB-6), carried beside the SEAL
// in the current extension's params, or null when there is none.
function buildCard(
  config: Config,
  credential: Credential | null,
  handshake: string | null,
  url?: string,
): AgentCard {
  const profile = idProfileUrl(config.agentId);
  return AgentCard.parse({
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: config.name,
    description: `SealKeeper agent ${config.agentId}. Verified track record at ${profile}`,
    ...(url === undefined ? {} : { url }),
    version: config.version,
    // ext/seal/v1 and the old ext/credential/v1, the same SEAL in both.
    // The handshake goes on ext/seal/v1 only.
    capabilities: {
      extensions: credential
        ? sealExtensions(credential.credential, handshake ?? undefined)
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
  fresh = false,
): Promise<AgentCard> {
  if (url !== undefined && !CardUrl.safeParse(url).success) {
    cmd.error(`--url must be an https URL, got ${url}`);
  }
  const { config, credential } = await loadSeal(cmd, deps, fresh);
  if (credential === null) stderr(NO_CREDENTIAL);
  // A fresh handshake each time the card is built, over the fingerprint
  // sync or prove last wrote, so it is refreshed whenever card write runs.
  // None when there is no fingerprint yet. Only beside a SEAL.
  const handshake =
    credential === null ? null : await makeHandshakeQuietly(Date.now());
  return buildCard(config, credential, handshake, url);
}

// The agent's config and current SEAL, from the cache or the API, the same
// for the card and the seal commands. credential is null when the API cannot
// be reached and nothing usable is cached. fresh asks the API even when the
// cached SEAL is fresh, for the show commands, so a withheld SEAL ends the
// command with the hold or the dormant days. The writes reuse the cache.
export async function loadSeal(
  cmd: Command,
  deps: CardDeps,
  fresh = false,
): Promise<{ config: Config; credential: Credential | null }> {
  const config = await requireConfig(cmd);

  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
    timeoutMs: CARD_TIMEOUT_MS,
  });
  let credential: Credential | null;
  try {
    credential = await getCredential({
      api,
      agentId: config.agentId,
      fetch: deps.fetch,
      force: fresh,
    });
  } catch (error) {
    if (error instanceof CredentialError || error instanceof ApiError) {
      cmd.error(error.message);
    }
    throw error;
  }
  return { config, credential };
}
