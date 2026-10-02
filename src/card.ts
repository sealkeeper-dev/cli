// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  SEAL_EXTENSION_URI,
  sealExtensions,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import {
  ApiError,
  createApiClient,
  resolveApiUrl,
  SealWithheldError,
} from './api.js';
import { requireConfig } from './cli-config.js';
import {
  type Config,
  ensureHome,
  idProfileUrl,
  type Paths,
  paths,
  writeFileAtomic,
} from './config.js';
import {
  type Credential,
  CredentialError,
  getCredential,
} from './credential.js';
import { readIfExists } from './files.js';
import { makeHandshakeQuietly } from './handshake.js';
import { stderr } from './output.js';
import { sha256Hex } from './tasks.js';

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

// The card is public, so the file is world readable for whatever serves it.
export const CARD_FILE_MODE = 0o644;

// The card as card write and the routine write it, one JSON object and a
// newline.
export const cardText = (card: AgentCard): string =>
  `${JSON.stringify(card, null, 2)}\n`;

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
  // sync or run last wrote, so it is refreshed whenever card write runs.
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

// Where card write last wrote the card, in card-write.json (VOU-383), so
// the daily routine refreshes that file with the same --url and writes no
// card anywhere else. It names the agent, so after init --force the new
// agent never writes over the card of the one before. sha256 is of the
// bytes last written there, so the routine rewrites the file only while it
// still holds that card, and never a card another agent's card write or the
// operator put there since. Read loosely.
const CardRecord = z.looseObject({
  v: z.literal(1),
  agentId: z.string().min(1),
  path: z.string().min(1),
  url: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  writtenAt: z.iso.datetime({ offset: true }),
});
export type CardRecord = z.infer<typeof CardRecord>;

// This agent's card record. null when there is none, it is another agent's
// or it does not read.
export async function readCardRecord(
  agentId: string,
  p: Paths = paths(),
): Promise<CardRecord | null> {
  try {
    const parsed = CardRecord.safeParse(
      JSON.parse(await readFile(p.cardWrite, 'utf8')),
    );
    return parsed.success && parsed.data.agentId === agentId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

// Records where the card was written. Never throws, a card on disk counts
// for more than the record of it, and the worst case is a routine that does
// not refresh it.
export async function recordCard(
  record: Omit<CardRecord, 'v'>,
  p: Paths = paths(),
): Promise<void> {
  try {
    await ensureHome(p);
    await writeFileAtomic(
      p.cardWrite,
      `${JSON.stringify({ ...record, v: 1 })}\n`,
    );
  } catch {
    // Kept as it was.
  }
}

// What the routine's refresh did with the card. refreshed wrote it with a
// newer SEAL. current left it alone, it carries the SEAL the CLI holds.
// offline and withheld left it as it was, since the API could not be
// reached or issues no SEAL now. gone, changed, unwritable and failed say
// why it was not refreshed. changed is a file that no longer holds the card
// last written there.
export type CardRefresh =
  | 'refreshed'
  | 'current'
  | 'offline'
  | 'withheld'
  | 'gone'
  | 'changed'
  | 'unwritable'
  | 'failed';

const CardSeal = z.object({
  capabilities: z.object({
    extensions: z.array(
      z.object({
        uri: z.string(),
        params: z.object({ credential: z.string() }).partial().optional(),
      }),
    ),
  }),
});

// The SEAL a card carries on the current extension, or null.
function sealOnCard(text: string): string | null {
  try {
    const card = CardSeal.safeParse(JSON.parse(text));
    if (!card.success) return null;
    const ext = card.data.capabilities.extensions.find(
      (e) => e.uri === SEAL_EXTENSION_URI,
    );
    return ext?.params?.credential ?? null;
  } catch {
    return null;
  }
}

// The daily routine's refresh of the card card write last wrote (VOU-383).
// null when card write never wrote one for this agent, and then nothing is
// written. A file whose bytes are not the ones last written there is left
// alone. Never throws, a card is a side task of the run.
//
// A SEAL lives 24 hours at most and the job runs once a day, so every SEAL
// on a card expires before the next run, and no margin short of a whole
// day would keep a daily card fresh. So the routine looks at the card on
// every run and rewrites it whenever the SEAL the CLI holds now, from the
// cache or the API as card write gets it, is not the one on the card. The
// cache is reused while it has more than two hours left, and the API
// serves its stored SEAL until two hours before it expires. So after a run
// the card carries a SEAL with more than two hours left, and one the API
// issued for the run's own read lasts until about the next run. One the
// API issued for another read, earlier in the day, may leave the card with
// an expired SEAL for up to 22 hours before the next run. A card that must
// never carry an expired SEAL needs card write every hour or so.
//
// A withheld SEAL leaves the card as it was, as card write does, which then
// writes nothing and exits 1. So does an API that cannot be reached with no
// usable SEAL cached, where card write would write a card without a SEAL.
export async function refreshCard(
  config: Config,
  deps: CardDeps,
  p: Paths = paths(),
  now: () => number = Date.now,
): Promise<CardRefresh | null> {
  const record = await readCardRecord(config.agentId, p);
  if (record === null) return null;
  try {
    const text = await readIfExists(record.path);
    if (text === null) return 'gone';
    if (sha256Hex(text) !== record.sha256) return 'changed';
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
        now,
        paths: p,
      });
    } catch (error) {
      return error instanceof SealWithheldError ? 'withheld' : 'failed';
    }
    if (credential === null) return 'offline';
    if (credential.credential === sealOnCard(text)) return 'current';
    const handshake = await makeHandshakeQuietly(now(), p);
    const written = cardText(
      buildCard(config, credential, handshake, record.url),
    );
    try {
      await writeFileAtomic(record.path, written, CARD_FILE_MODE);
    } catch {
      return 'unwritable';
    }
    await recordCard(
      {
        ...record,
        sha256: sha256Hex(written),
        writtenAt: new Date(now()).toISOString(),
      },
      p,
    );
    return 'refreshed';
  } catch {
    return 'failed';
  }
}
