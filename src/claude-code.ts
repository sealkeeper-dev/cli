// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createApiClient, resolveApiUrl } from './api.js';
import { ConfigError, type Paths, paths, readConfig } from './config.js';
import { type EmitInput, emit } from './emit.js';
import { toolNameOf } from './names.js';
import { stderr } from './output.js';
import { syncEvents } from './sync.js';

export { toolNameOf } from './names.js';

// The Claude Code hooks adapter. Claude Code runs `sealkeeper hook claude-code`
// for each hook event with one JSON object on stdin. handleHook maps it to
// the event taxonomy and appends to the local log. It prints nothing on
// stdout, since Claude Code may read that, and it never throws.

// Only the SessionEnd hook tries a sync, only once autoSync is on, and never
// for longer than this per request. Every other hook only appends.
export const HOOK_SYNC_TIMEOUT_MS = 2_000;

// Markers older than this belong to sessions or tool calls that never ended.
export const STALE_MARKER_MS = 24 * 60 * 60 * 1000;

// The payload schema caps durations at a week.
const MAX_DURATION_MS = 604_800_000;

// Session and tool use ids become file names, so only plain ids are used.
// The cap matches the taxonomy's 64 character names.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_MARKER_PREFIX = 'tool.';
// An ended session keeps its marker under this prefix until the stale sweep,
// so a later SessionStart for the same id does not count a second session.
const ENDED_MARKER_PREFIX = 'ended.';

export type HookInput = {
  event: string;
  sessionId: string | null;
  toolName: string | null;
  toolUseId: string | null;
};

export type HookDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  paths?: Paths;
};

// Picks the few fields the adapter uses out of the raw stdin text, or null
// when it is not a hook payload. Only tool_name is used. tool_input and
// tool_response are never read, logged or emitted.
export function parseHookInput(text: string): HookInput | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return null;
  }
  const raw = json as Record<string, unknown>;
  if (typeof raw.hook_event_name !== 'string') return null;
  return {
    event: raw.hook_event_name,
    sessionId: idOf(raw.session_id),
    toolName: toolNameOf(raw.tool_name),
    toolUseId: idOf(raw.tool_use_id),
  };
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null;
}

// Handles one hook event. Without a config it does nothing. Any failure
// ends in at most one warning line on stderr.
export async function handleHook(
  input: HookInput,
  deps: HookDeps,
): Promise<void> {
  const p = deps.paths ?? paths();
  const now = deps.now?.() ?? new Date();
  try {
    let config: Awaited<ReturnType<typeof readConfig>>;
    try {
      config = await readConfig(p);
    } catch (error) {
      if (error instanceof ConfigError) return;
      throw error;
    }
    if (config === null) return;
    const append = (event: EmitInput) =>
      emit({ ...event, version: config.version }, p);

    switch (input.event) {
      case 'SessionStart': {
        if (input.sessionId === null) return;
        await removeStaleMarkers(p, now, append);
        // A resume or compact fires SessionStart again for the same session.
        // The marker, open or ended, keeps it to one session.start.
        if (await exists(p, ENDED_MARKER_PREFIX + input.sessionId)) return;
        if (await writeMarker(p, input.sessionId, now)) {
          await append({
            type: 'session.start',
            payload: { session_id: input.sessionId },
          });
        }
        return;
      }
      case 'Stop': {
        // Claude Code fires Stop after every turn, so it only notes the time.
        // A session that never sees SessionEnd is closed at its last Stop by
        // the stale sweep.
        if (input.sessionId === null) return;
        await noteStop(p, input.sessionId, now);
        return;
      }
      case 'SessionEnd': {
        if (input.sessionId === null) return;
        // No open marker means the session already ended, or began before
        // the hooks were installed. Either way there is nothing to close.
        const session = await readSession(p, input.sessionId);
        if (session === null) return;
        await append({
          type: 'session.end',
          payload: {
            session_id: input.sessionId,
            duration_ms: durationMs(session.start, now),
          },
        });
        await endSession(p, input.sessionId);
        await removeStaleMarkers(p, now, append);
        // Nothing leaves on its own until the operator has previewed and
        // confirmed a first sync, which turns autoSync on.
        if (config.autoSync) await trySync(config.apiUrl, deps, p);
        return;
      }
      case 'PreToolUse': {
        if (input.toolUseId === null) return;
        await writeMarker(p, TOOL_MARKER_PREFIX + input.toolUseId, now);
        return;
      }
      case 'PostToolUse': {
        if (input.toolName === null) return;
        const started =
          input.toolUseId === null
            ? null
            : await takeMarker(p, TOOL_MARKER_PREFIX + input.toolUseId);
        await append({
          type: 'tool.call',
          payload: {
            tool: input.toolName,
            duration_ms: started === null ? 0 : durationMs(started, now),
            ok: true,
          },
        });
        return;
      }
      default:
        return;
    }
  } catch (error) {
    warn(error);
  }
}

function durationMs(started: Date, now: Date): number {
  const ms = Math.round(now.getTime() - started.getTime());
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(ms, 0), MAX_DURATION_MS);
}

// Writes the start time marker unless it exists. Returns whether it wrote.
async function writeMarker(p: Paths, name: string, at: Date): Promise<boolean> {
  await mkdir(p.sessions, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(p.sessions, name), at.toISOString(), {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

// Reads and deletes a marker. null when there is none. A marker that does
// not hold a valid time gives an invalid date, which durationMs turns into 0.
async function takeMarker(p: Paths, name: string): Promise<Date | null> {
  const text = await readMarker(p, name);
  if (text === null) return null;
  await rm(join(p.sessions, name), { force: true });
  return new Date(text.trim());
}

async function readMarker(p: Paths, name: string): Promise<string | null> {
  try {
    return await readFile(join(p.sessions, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(p: Paths, name: string): Promise<boolean> {
  return (await readMarker(p, name)) !== null;
}

// An open session marker holds the start time on the first line and, once a
// Stop has been seen, the time of the last Stop on the second.
type Session = { start: Date; lastStop: Date | null };

async function readSession(p: Paths, id: string): Promise<Session | null> {
  const text = await readMarker(p, id);
  if (text === null) return null;
  const [start = '', stop] = text.split('\n');
  return {
    start: new Date(start.trim()),
    lastStop: stop?.trim() ? new Date(stop.trim()) : null,
  };
}

async function noteStop(p: Paths, id: string, at: Date): Promise<void> {
  const text = await readMarker(p, id);
  if (text === null) return;
  const start = text.split('\n')[0]?.trim() ?? '';
  await writeFile(join(p.sessions, id), `${start}\n${at.toISOString()}`, {
    mode: 0o600,
  });
}

// Keeps the start time under the ended prefix. rename keeps the mode.
async function endSession(p: Paths, id: string): Promise<void> {
  try {
    await rename(
      join(p.sessions, id),
      join(p.sessions, ENDED_MARKER_PREFIX + id),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Removes markers untouched for a day. An open session marker with a Stop
// time stands for a SessionEnd that never came, so it first emits
// session.end with the duration from start to the last Stop.
async function removeStaleMarkers(
  p: Paths,
  now: Date,
  append: (event: EmitInput) => Promise<unknown>,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(p.sessions);
  } catch {
    return;
  }
  const cutoff = now.getTime() - STALE_MARKER_MS;
  for (const name of names) {
    const file = join(p.sessions, name);
    try {
      if ((await stat(file)).mtimeMs >= cutoff) continue;
      const session = ID.test(name) ? await readSession(p, name) : null;
      // Without force, only the hook that removes the file emits for it.
      await rm(file);
      if (session?.lastStop) {
        await append({
          type: 'session.end',
          payload: {
            session_id: name,
            duration_ms: durationMs(session.start, session.lastStop),
          },
        });
      }
    } catch {
      // Another hook may have removed it first.
    }
  }
}

// Best effort. The events are in the log already, so a failure only means
// they go with the next sync.
async function trySync(
  apiUrl: string,
  deps: HookDeps,
  p: Paths,
): Promise<void> {
  try {
    await syncEvents({
      api: createApiClient({
        apiUrl: resolveApiUrl({ config: apiUrl }),
        fetch: deps.fetch,
        timeoutMs: HOOK_SYNC_TIMEOUT_MS,
      }),
      sleep: deps.sleep,
      maxRateLimitWaitSec: 0,
      paths: p,
    });
  } catch {
    stderr('sealkeeper: sync did not finish, run sealkeeper sync');
  }
}

function warn(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  stderr(`sealkeeper: hook failed, ${reason.split('\n')[0]}`);
}
