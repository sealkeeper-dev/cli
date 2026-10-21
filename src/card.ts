// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile, rm } from 'node:fs/promises';
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
  readCache,
} from './credential.js';
import { readIfExists, tildePath } from './files.js';
import type { RoutineSource } from './fingerprint.js';
import { makeHandshakeQuietly } from './handshake.js';
import { cli } from './invocation.js';
import { type SealWithheld, withheldText } from './responses.js';
import { sha256Hex } from './tasks.js';

// init and the routine build the same card, and the seal commands read the
// SEAL the card carries. fetch is injectable so tests can stand in for the
// API.
export type CardDeps = {
  fetch: typeof fetch;
};

// Short, so neither init nor a scheduled run hangs on a slow network.
const CARD_TIMEOUT_MS = 10_000;

// The card is public, so the file is world readable for whatever serves it.
const CARD_FILE_MODE = 0o644;

// The card as init and the routine write it, one JSON object and a
// newline.
const cardText = (card: AgentCard): string =>
  `${JSON.stringify(card, null, 2)}\n`;

// handshake is the agent's signed handshake, carried beside the SEAL in the
// current extension's params, or null when there is none.
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

// init writes the card into the home, once for each agent, and records it so
// the daily routine keeps its SEAL fresh. A card recorded already is the
// routine's to refresh, so a repeat init leaves it alone. The card carries no
// SEAL when none can be fetched, and the routine adds it later. Never throws.
// Returns the path written, or null when nothing was written.
export async function writeCard(
  config: Config,
  deps: CardDeps,
  p: Paths = paths(),
): Promise<string | null> {
  try {
    if ((await readCardRecord(config.agentId, p)) !== null) return null;
    const api = createApiClient({
      apiUrl: resolveApiUrl({ config: config.apiUrl }),
      fetch: deps.fetch,
      timeoutMs: CARD_TIMEOUT_MS,
    });
    const credential = await getCredential({
      api,
      agentId: config.agentId,
      fetch: deps.fetch,
      paths: p,
    }).catch(() => null);
    const handshake =
      credential === null ? null : await makeHandshakeQuietly(Date.now(), p);
    const text = cardText(buildCard(config, credential, handshake));
    await ensureHome(p);
    await writeFileAtomic(p.card, text, CARD_FILE_MODE);
    await recordCard(
      {
        agentId: config.agentId,
        path: p.card,
        sha256: sha256Hex(text),
        writtenAt: new Date().toISOString(),
      },
      p,
    );
    return p.card;
  } catch {
    return null;
  }
}

// The agent's config and current SEAL, from the cache or the API, the same
// for the card and the seal commands. credential is null when the API cannot
// be reached and nothing usable is cached. fresh asks the API even when the
// cached SEAL is fresh, for the show commands, so a withheld SEAL ends the
// command with the hold or the dormant days, and the cached SEAL and the one
// on the card go, see withholdSeal. The writes reuse the cache.
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
    if (error instanceof SealWithheldError) await withholdSeal(config);
    if (error instanceof CredentialError || error instanceof ApiError) {
      cmd.error(error.message);
    }
    throw error;
  }
  return { config, credential };
}

// Where init wrote the card, in card-write.json, so the daily routine refreshes
// that file and writes no card anywhere else. It names the agent, so after init
// --force the new agent writes a card of its own. sha256 is of the bytes last
// written there, so the routine rewrites the file only while it still holds
// that card. url is kept for a record an earlier CLI wrote with one. Read
// loosely.
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
async function recordCard(
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
// newer SEAL or a new handshake. current left it alone, it carries the SEAL
// the CLI holds. offline left it as it was, since the API could not be
// reached. withheld wrote it without a SEAL, or left one that holds none,
// since the API issues no SEAL now. gone, changed, unwritable and failed say
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

/*
 * The card's state on this machine, which status and the routine screen show in
 * one line with the same words. Local only, it reads card-write.json, the card
 * file and the cached SEAL, and calls nothing. current holds the SEAL the CLI
 * holds now, stale does not, unsealed holds none while the CLI holds none
 * either. gone, changed and unreadable are a file the routine would not
 * refresh, as refreshCard says them. none is an agent init wrote no card for.
 * Never throws.
 */
export type CardState =
  | 'current'
  | 'stale'
  | 'unsealed'
  | 'gone'
  | 'changed'
  | 'unreadable';

export type CardView =
  | { state: 'none' }
  | { state: CardState; path: string; writtenAt: string };

export async function readCardView(
  agentId: string,
  p: Paths = paths(),
): Promise<CardView> {
  const record = await readCardRecord(agentId, p);
  if (record === null) return { state: 'none' };
  const at = { path: record.path, writtenAt: record.writtenAt };
  let text: string | null;
  try {
    text = await readIfExists(record.path);
  } catch {
    return { state: 'unreadable', ...at };
  }
  if (text === null) return { state: 'gone', ...at };
  if (sha256Hex(text) !== record.sha256) return { state: 'changed', ...at };
  const held = await readCache(p, agentId).catch(() => null);
  const onCard = sealOnCard(text);
  if (held === null && onCard === null) return { state: 'unsealed', ...at };
  return {
    state: held?.credential === onCard ? 'current' : 'stale',
    ...at,
  };
}

// The card's state in one line, without the Card label the screens put
// before it. withheld is why the API issues no SEAL now, when the caller
// knows it, and says why a card that holds none has none.
export function cardLine(
  view: CardView,
  withheld: SealWithheld | null = null,
): string {
  if (view.state === 'none') return `none written, ${cli('init')} writes it`;
  const where = tildePath(view.path);
  const written = `last written ${view.writtenAt}`;
  switch (view.state) {
    case 'current':
      return `${where}, holds the SEAL the CLI holds now, ${written}`;
    case 'stale':
      return `${where}, does not hold the SEAL the CLI holds now, ${written}`;
    case 'unsealed':
      return withheld === null
        ? `${where}, holds no SEAL yet, ${written}`
        : `${where}, holds no SEAL, ${withheldText(withheld)}, ${written}`;
    case 'gone':
      return `${where}, the file is gone`;
    case 'changed':
      return `${where}, the file holds another card`;
    case 'unreadable':
      return `${where}, the file could not be read`;
  }
}

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

// The daily routine's refresh of the card init wrote. null when init never
// wrote one for this agent, and then nothing is written. A file whose bytes are
// not the ones last written there is left alone. Never throws.
//
// The SEAL comes from the API each time, so a SEAL withheld since the last
// one was cached is seen, and from the cache when the API cannot be reached.
// The card is rewritten whenever that SEAL is not the one on the card, and
// also when newHandshake is set, for a handshake over a fingerprint that
// changed since the card was written. A withheld SEAL writes the card without
// one, see withholdSeal. An API that cannot be reached with no usable SEAL
// cached leaves the card as it was. The handshake on a rewritten card signs
// the fingerprint the run declares, the routine's own when routine names its
// source, or the session's while the routine has none yet.
export async function refreshCard(
  config: Config,
  deps: CardDeps & { routine?: RoutineSource; newHandshake?: boolean },
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
        force: true,
      });
    } catch (error) {
      if (!(error instanceof SealWithheldError)) return 'failed';
      return (await withholdSeal(config, p, now)) ?? 'withheld';
    }
    if (credential === null) return 'offline';
    if (
      credential.credential === sealOnCard(text) &&
      deps.newHandshake !== true
    ) {
      return 'current';
    }
    // A routine with no fingerprint of its own yet signs the session's, so
    // a rewritten card never loses its handshake.
    const handshake =
      (await makeHandshakeQuietly(now(), p, deps.routine)) ??
      (deps.routine === undefined
        ? null
        : await makeHandshakeQuietly(now(), p));
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

// The API issues no SEAL for this agent now, so the CLI holds none and the
// card init wrote carries none. Removes the cached SEAL, and rewrites the card
// the way init writes one with no SEAL, keeping the rest of it, when it still
// holds one. A card that is gone, holds another card or holds no SEAL is left
// as it is. Returns withheld when the card holds no SEAL now, gone, changed,
// unwritable or failed as refreshCard says them when it was not written, and
// null when init wrote no card for this agent. Never throws.
export async function withholdSeal(
  config: Config,
  p: Paths = paths(),
  now: () => number = Date.now,
): Promise<CardRefresh | null> {
  try {
    if ((await readCache(p, config.agentId)) !== null) {
      await rm(p.credential, { force: true });
    }
  } catch {
    // Kept. The card is still written without a SEAL.
  }
  const record = await readCardRecord(config.agentId, p);
  if (record === null) return null;
  try {
    const text = await readIfExists(record.path);
    if (text === null) return 'gone';
    if (sha256Hex(text) !== record.sha256) return 'changed';
    if (sealOnCard(text) === null) return 'withheld';
    const written = cardText(buildCard(config, null, null, record.url));
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
    return 'withheld';
  } catch {
    return 'failed';
  }
}
