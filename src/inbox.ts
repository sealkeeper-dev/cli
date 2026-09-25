// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile, rm } from 'node:fs/promises';
import { AgentId } from '@sealkeeper/schema';
import { z } from 'zod';
import { createApiClient } from './api.js';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { SCORE_TIMEOUT_MS, SCORE_TTL_MS } from './score.js';
import { addressedTo } from './tasks.js';

// How many open tasks are addressed to this agent, from
// GET /v1/tasks?assignee=<id>&state=open, kept in inbox.json for fifteen
// minutes like the score, so status stays fast. Unlike the score, a stale
// count is never shown. Offline, status says nothing about addressed tasks.

const INBOX_CACHE_VERSION = 1;
// The API's own maximum for one page, above its cap on tasks addressed to
// one agent.
const INBOX_LIMIT = 100;

const InboxCache = z.strictObject({
  v: z.literal(INBOX_CACHE_VERSION),
  agentId: AgentId,
  fetchedAt: z.iso.datetime({ offset: true }),
  count: z.int().min(0),
});
export type InboxCache = z.infer<typeof InboxCache>;

type InboxOptions = {
  agentId: string;
  apiUrl: string;
  fetch?: typeof fetch;
  now?: Date;
  paths?: Paths;
};

// A cache under fifteen minutes old is returned as is. Otherwise it asks the
// API, with a two second timeout, and caches the answer. null when that
// fails for any reason. It never throws.
export async function getInbox(
  options: InboxOptions,
): Promise<InboxCache | null> {
  const p = options.paths ?? paths();
  const now = options.now ?? new Date();
  const cached = await readInboxCache(p, options.agentId);
  // A fetchedAt in the future means the clock was wrong, so not fresh.
  const age = cached ? now.getTime() - Date.parse(cached.fetchedAt) : -1;
  if (cached && age >= 0 && age < SCORE_TTL_MS) return cached;

  try {
    const api = createApiClient({
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      timeoutMs: SCORE_TIMEOUT_MS,
    });
    const tasks = await api.listTasks({
      state: 'open',
      assignee: options.agentId,
      limit: INBOX_LIMIT,
    });
    // Only tasks for this agent, whatever the server sent.
    const count = addressedTo(tasks, options.agentId).length;
    const fresh: InboxCache = {
      v: INBOX_CACHE_VERSION,
      agentId: options.agentId,
      fetchedAt: now.toISOString(),
      count,
    };
    await writeInboxCache(fresh, p).catch(() => undefined);
    return fresh;
  } catch {
    return null;
  }
}

// Drops the cache, so the next status asks again. Called after this agent
// claims an addressed task, which leaves the cached count too high.
export async function clearInbox(p: Paths = paths()): Promise<void> {
  await rm(p.inbox, { force: true }).catch(() => undefined);
}

async function readInboxCache(
  p: Paths,
  agentId: string,
): Promise<InboxCache | null> {
  try {
    const result = InboxCache.safeParse(
      JSON.parse(await readFile(p.inbox, 'utf8')),
    );
    if (!result.success) return null;
    return result.data.agentId === agentId ? result.data : null;
  } catch {
    return null;
  }
}

async function writeInboxCache(cache: InboxCache, p: Paths): Promise<void> {
  await ensureHome(p);
  await writeFileAtomic(p.inbox, `${JSON.stringify(cache)}\n`);
}
