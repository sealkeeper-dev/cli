// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import { OperatorSlug } from '@sealkeeper/schema';
import { z } from 'zod';
import {
  type Config,
  ensureHome,
  type Paths,
  paths,
  writeFileAtomic,
} from './config.js';
import { type LiveAgent, readLiveAgent } from './live-agent.js';

// The operator slug, the first half of the handle (VOU-187). The API
// builds the handle from it, and it differs from the GitHub login when the
// slug was suffixed at backfill or changed on the web. status, init, run
// and agent rename and delete build the handle offline, so the last slug
// the API sent is kept in operator-slug.json. Not in config.json, since CLI 0.4.4
// and earlier read that file strictly and fail on a key they do not know.
// The file names the agent it belongs to, so a new agent on the same
// machine never takes the slug of the one before. The login stands in only
// while nothing is stored.

// seenAt is when this slug was first stored. The file is written again
// only when the slug changes.
const SlugFile = z.object({
  v: z.literal(1),
  agentId: z.string().min(1),
  slug: OperatorSlug,
  seenAt: z.iso.datetime({ offset: true }),
});

// The stored slug of this agent's operator. null when there is none, the
// file belongs to another agent or does not read.
export async function readOperatorSlug(
  agentId: string,
  p: Paths = paths(),
): Promise<string | null> {
  try {
    const parsed = SlugFile.safeParse(
      JSON.parse(await readFile(p.operatorSlug, 'utf8')),
    );
    return parsed.success && parsed.data.agentId === agentId
      ? parsed.data.slug
      : null;
  } catch {
    return null;
  }
}

// Stores the slug the API sent. Never throws, the worst case is the old
// value, or the login, until the next answer.
export async function saveOperatorSlug(
  agentId: string,
  slug: string,
  now: Date = new Date(),
  p: Paths = paths(),
): Promise<void> {
  if (!OperatorSlug.safeParse(slug).success) return;
  try {
    if ((await readOperatorSlug(agentId, p)) === slug) return;
    await ensureHome(p);
    await writeFileAtomic(
      p.operatorSlug,
      `${JSON.stringify({ v: 1, agentId, slug, seenAt: now.toISOString() })}\n`,
    );
  } catch {
    // Kept as it was, and the next answer tries again.
  }
}

// The slug an agent answer carries, operator.slug, or the first half of
// the handle from an answer without it. undefined from an API before
// slugs, which sends neither.
export function slugOfAnswer(answer: {
  handle?: string | null;
  operator?: { slug?: string | null } | null;
}): string | undefined {
  const slug = answer.operator?.slug ?? answer.handle?.split('/')[0];
  return slug !== undefined && OperatorSlug.safeParse(slug).success
    ? slug
    : undefined;
}

// The slug from an agent answer, stored, or the stored one when there is
// no answer or it carries none. null when nothing is known.
export async function refreshOperatorSlug(
  agentId: string,
  answer: Parameters<typeof slugOfAnswer>[0] | null,
  p: Paths = paths(),
): Promise<string | null> {
  const slug = answer === null ? undefined : slugOfAnswer(answer);
  if (slug === undefined) return readOperatorSlug(agentId, p);
  await saveOperatorSlug(agentId, slug, new Date(), p);
  return slug;
}

// Reads the agent from the API, with the two second limit of every live
// read, and refreshes the stored slug from it. Offline it is the stored
// slug. live is the answer, for a caller that reads more of it.
export async function currentOperatorSlug(
  config: Pick<Config, 'agentId' | 'apiUrl'>,
  fetchFn: typeof fetch,
  p: Paths = paths(),
): Promise<{ slug: string | null; live: LiveAgent | null }> {
  const live = await readLiveAgent(config, fetchFn);
  return { slug: await refreshOperatorSlug(config.agentId, live, p), live };
}
