// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { clampMs } from './adapter-core.js';
import { gatedSync, WAITING_CALLER_LIMITS } from './background-sync.js';
import {
  ConfigError,
  type Paths,
  paths,
  readConfig,
  readNudge,
  sealkeeperHome,
} from './config.js';
import { type EmitInput, emit } from './emit.js';
import { readIfExists } from './files.js';
import { fetchGoal } from './goal.js';
import { cli } from './invocation.js';
import { toolNameOf } from './names.js';
import { type NudgeDeps, nudgeLines } from './nudge.js';
import { stderr, stdout } from './output.js';

export { toolNameOf } from './names.js';

// The Claude Code hooks adapter. Claude Code runs `sealkeeper hook claude-code`
// for each hook event with one JSON object on stdin. handleHook maps it to
// the event taxonomy and appends to the local log. It never throws. Claude
// Code adds what a SessionStart hook prints on stdout to the session's
// context, so stdout carries only the session nudge (nudge.ts), and only on
// SessionStart once the operator turned it on. Every other hook prints
// nothing there.

// Only the SessionEnd hook goes to the network. It tries a sync once
// autoSync is on, through the gate every automatic sync takes (see
// background-sync.ts), and refreshes the goal the next SessionStart summary
// reads once the nudge is on, never for longer than this per request.
// Every other hook only appends, and SessionStart reads only the cache.
const HOOK_SYNC_TIMEOUT_MS = WAITING_CALLER_LIMITS.timeoutMs;

// Markers older than this belong to sessions or tool calls that never ended.
export const STALE_MARKER_MS = 24 * 60 * 60 * 1000;

// Session and tool use ids become file names, so only plain ids are used.
// The cap matches the taxonomy's 64 character names.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_MARKER_PREFIX = 'tool.';
// An ended session keeps its marker under this prefix until the stale sweep,
// so a later SessionStart for the same id does not count a second session.
const ENDED_MARKER_PREFIX = 'ended.';

type HookInput = {
  event: string;
  sessionId: string | null;
  toolName: string | null;
  toolUseId: string | null;
  // PostToolUseFailure only. true when the user interrupted the call, so
  // the failure is not the agent's.
  interrupted: boolean;
  // The folder Claude Code runs in, which picks the agent, see
  // sealkeeperHome. null when the payload has no absolute path there.
  cwd: string | null;
};

type HookDeps = {
  fetch: typeof fetch;
  now?: () => Date;
  paths?: Paths;
  cachedGoal?: NudgeDeps['cachedGoal'];
};

// How the summary tells Claude to act on it, the slash command and the
// sealkeeper skill both run the prove instructions.
export const CLAUDE_CODE_RUN = '/sealkeeper-prove';

// Picks the few fields the adapter uses out of the raw stdin text, or null
// when it is not a hook payload. Only tool_name is used, and a failure's
// is_interrupt, read as a boolean. tool_input, tool_response and a
// failure's error are never read, logged or emitted.
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
    interrupted: raw.is_interrupt === true,
    cwd: cwdOf(raw.cwd),
  };
}

function cwdOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && isAbsolute(value)
    ? value
    : null;
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null;
}

// Handles one hook event for the agent of the folder Claude Code runs in,
// the payload's cwd, since the hook process may start elsewhere. Without a
// config it does nothing. Any failure ends in at most one warning line on
// stderr.
export async function handleHook(
  input: HookInput,
  deps: HookDeps,
): Promise<void> {
  const p =
    deps.paths ??
    paths(sealkeeperHome(process.env, input.cwd ?? process.cwd()));
  await logHook(input, deps, p);
  // After the event is in the log, so the summary never holds it up or
  // breaks it.
  if (input.event === 'SessionStart') await printNudge(deps, p);
}

async function printNudge(deps: HookDeps, p: Paths): Promise<void> {
  try {
    const lines = await nudgeLines(CLAUDE_CODE_RUN, {
      paths: p,
      cachedGoal: deps.cachedGoal,
    });
    if (lines.length > 0) stdout(lines.join('\n'));
  } catch {
    // A closed stdout only loses the summary.
  }
}

async function logHook(
  input: HookInput,
  deps: HookDeps,
  p: Paths,
): Promise<void> {
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
        if (config.autoSync) await trySync(deps, p);
        if ((await readNudge(p)) === true) await refreshGoal(config, deps, p);
        return;
      }
      case 'PreToolUse': {
        if (input.toolUseId === null) return;
        await writeMarker(p, TOOL_MARKER_PREFIX + input.toolUseId, now);
        return;
      }
      // Claude Code fires PostToolUse after a tool call succeeds and
      // PostToolUseFailure after one that started and failed, both with
      // tool_name and tool_use_id (hooks reference, checked 27 September
      // 2026). A call refused before it runs fires neither. The failure's
      // error text is never read, so a failed call is ok false with no
      // error_class. A failure with is_interrupt true is the user pressing
      // Esc during the call, not the agent failing, so it only clears the
      // PreToolUse marker and records nothing.
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        if (input.toolName === null) return;
        const started =
          input.toolUseId === null
            ? null
            : await takeMarker(p, TOOL_MARKER_PREFIX + input.toolUseId);
        if (input.event === 'PostToolUseFailure' && input.interrupted) return;
        await append({
          type: 'tool.call',
          payload: {
            tool: input.toolName,
            duration_ms: started === null ? 0 : durationMs(started, now),
            ok: input.event === 'PostToolUse',
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

// Within the range the payload schema accepts, see clampMs. A marker that
// does not hold a valid time gives 0.
function durationMs(started: Date, now: Date): number {
  const ms = now.getTime() - started.getTime();
  return Number.isFinite(ms) ? clampMs(ms) : 0;
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

function readMarker(p: Paths, name: string): Promise<string | null> {
  return readIfExists(join(p.sessions, name));
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
// they go with the next sync. The gate keeps Claude Code waiting for a few
// seconds at most, and a sync it holds back for the throttle or the lock
// prints nothing.
async function trySync(deps: HookDeps, p: Paths): Promise<void> {
  const now = deps.now;
  try {
    await gatedSync({
      fetch: deps.fetch,
      paths: p,
      now: now ? () => now().getTime() : undefined,
      ...WAITING_CALLER_LIMITS,
    });
  } catch {
    stderr(`sealkeeper: sync did not finish, run ${cli('sync')}`);
  }
}

// Best effort, and silent. A goal that could not be read leaves the cache
// as it was, and the summary uses it while it is under a day old.
async function refreshGoal(
  config: { agentId: string; apiUrl: string },
  deps: HookDeps,
  p: Paths,
): Promise<void> {
  try {
    await fetchGoal(config, {
      fetch: deps.fetch,
      paths: p,
      timeoutMs: HOOK_SYNC_TIMEOUT_MS,
      now: deps.now?.(),
    });
  } catch {
    // The next SessionEnd tries again.
  }
}

function warn(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  stderr(`sealkeeper: hook failed, ${reason.split('\n')[0]}`);
}
