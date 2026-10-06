// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import { StatusRequest } from '@sealkeeper/schema';
import { z } from 'zod';
import { ApiError, createApiClient, resolveApiUrl } from './api.js';
import {
  type Config,
  ensureHome,
  type Paths,
  paths,
  writeFileAtomic,
} from './config.js';
import { KeyError, loadSigner } from './identity.js';
import { saveOperatorSlug, slugOfAnswer } from './operator-slug.js';
import { refusal } from './refusal.js';
import { StatusAnswerResponse } from './responses.js';

// The status answer (VOU-596), POST /v1/agents/<id>/status, which status
// prints and the terminal run reads for where the agent stands. The last
// answer is kept in status.json, so status still shows it offline, labelled
// with the time it came. The API decides and words what status shows, so
// this is the only read of it. A fresh answer also refreshes the stored
// operator slug from its handle, as the agent answer of the old status did.

const STATUS_CACHE_VERSION = 1;

// How long status waits for the API before it shows the cache. The route
// makes about a dozen bounded reads, so it gets a little longer than the
// two seconds of a quick read, and a person still waits only seconds.
export const STATUS_TIMEOUT_MS = 5_000;

const StatusCache = z.object({
  v: z.literal(STATUS_CACHE_VERSION),
  fetchedAt: z.iso.datetime({ offset: true }),
  answer: StatusAnswerResponse,
});
type StatusCache = z.infer<typeof StatusCache>;

/*
 * What a status read got. api is a fresh answer, cache the last one kept
 * when the API could not give one, and none neither. noRoute says the API
 * answered 404, an API from before the status route, else why is the
 * reason in plain words.
 */
export type StatusRead =
  | { from: 'api'; answer: StatusAnswerResponse; fetchedAt: string }
  | {
      from: 'cache';
      answer: StatusAnswerResponse;
      fetchedAt: string;
      noRoute: boolean;
      why: string;
    }
  | { from: 'none'; answer: null; noRoute: boolean; why: string };

export type ReadStatusOptions = {
  config: Pick<Config, 'agentId' | 'apiUrl' | 'version'>;
  fetch?: typeof fetch;
  now?: Date;
  paths?: Paths;
};

/*
 * Signs StatusRequest with this agent's key, asks the status route and
 * keeps the answer. When the key cannot be read, the API refuses or does
 * not answer, or the answer is for another agent, it returns the last
 * answer kept for this agent and version, else none, with the reason. It
 * never throws, so a failed read never fails the local part of status.
 */
export async function readStatus(
  options: ReadStatusOptions,
): Promise<StatusRead> {
  const p = options.paths ?? paths();
  const now = options.now ?? new Date();
  const { config } = options;
  let why: string;
  let noRoute = false;
  try {
    const api = createApiClient({
      apiUrl: resolveApiUrl({ config: config.apiUrl }),
      fetch: options.fetch,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    const signer = await loadSigner(api.apiUrl, p);
    const answer = await api.status(
      config.agentId,
      await signer.sign(
        StatusRequest.parse({ issuedAt: now.toISOString() }),
        'agent.status',
      ),
    );
    if (answer.status.agent.id !== config.agentId) {
      why = 'the status answer is for another agent';
    } else {
      const fetchedAt = now.toISOString();
      await writeStatusCache(
        { v: STATUS_CACHE_VERSION, fetchedAt, answer },
        p,
      ).catch(() => undefined);
      const slug = slugOfAnswer({ handle: answer.status.agent.handle });
      if (slug !== undefined) {
        await saveOperatorSlug(config.agentId, slug, now, p);
      }
      return { from: 'api', answer, fetchedAt };
    }
  } catch (error) {
    noRoute = error instanceof ApiError && error.status === 404;
    why =
      error instanceof ApiError
        ? refusal(error)
        : error instanceof KeyError
          ? error.message
          : 'the answer could not be read';
  }
  const cached = await readStatusCache(p, config);
  return cached === null
    ? { from: 'none', answer: null, noRoute, why }
    : {
        from: 'cache',
        answer: cached.answer,
        fetchedAt: cached.fetchedAt,
        noRoute,
        why,
      };
}

// The one line that says where the numbers came from, or null for a fresh
// answer.
export function sourceLine(read: StatusRead): string | null {
  if (read.from === 'api') return null;
  const head = read.noRoute
    ? 'This SealKeeper API has no status route yet'
    : `SealKeeper did not answer, ${read.why}`;
  return read.from === 'cache'
    ? `${head}. The numbers are cached from ${read.fetchedAt}.`
    : `${head}, so only what this machine knows is shown.`;
}

// null when there is no cache, it does not parse, or it is for another
// agent or another version, as after sealkeeper agent version.
async function readStatusCache(
  p: Paths,
  config: Pick<Config, 'agentId' | 'version'>,
): Promise<StatusCache | null> {
  try {
    const result = StatusCache.safeParse(
      JSON.parse(await readFile(p.status, 'utf8')),
    );
    if (!result.success) return null;
    const { agent } = result.data.answer.status;
    return agent.id === config.agentId && agent.version === config.version
      ? result.data
      : null;
  } catch {
    return null;
  }
}

async function writeStatusCache(cache: StatusCache, p: Paths): Promise<void> {
  await ensureHome(p);
  await writeFileAtomic(p.status, `${JSON.stringify(cache)}\n`);
}
