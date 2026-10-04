// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { gatedSync, WAITING_CALLER_LIMITS } from './background-sync.js';
import {
  ConfigError,
  type Paths,
  paths,
  readConfig,
  sealkeeperHome,
} from './config.js';
import { observeClaudeCode } from './fingerprint-claude-code.js';
import { cli } from './invocation.js';
import { type NudgeDeps, nudgeLines } from './nudge.js';
import { stderr, stdout } from './output.js';

// The Claude Code hooks adapter. Claude Code runs `sealkeeper hook claude-code`
// for each hook event with one JSON object on stdin. It writes no event
// (VOU-627). An interactive session is the operator's own work, so only a
// routine run, which is SealKeeper work, records a session and its usage,
// see routine-run.ts. The hooks keep what is not an event. SessionStart
// reads the model id for the fingerprint source and prints the session
// nudge, SessionEnd reads the fingerprint parts again and syncs what the
// log holds. A CLI before 0.5.0 also
// wrote session.start and session.end and installed a Stop hook to close a
// session that never ended. Stop, and the tool events of the PreToolUse,
// PostToolUse and PostToolUseFailure hooks a CLI before 0.4.14 installed,
// record nothing until the install runs again and removes them. It never
// throws. Claude Code adds what a SessionStart hook prints on stdout to the
// session's context, so stdout carries only the session nudge (nudge.ts),
// and only on SessionStart once the operator turned it on. Every other hook
// prints nothing there.

// Only the SessionEnd hook may go to the network, and only for SealKeeper
// work. It tries a sync once autoSync is on, through the gate every
// automatic sync takes (see background-sync.ts), and a sync sends only
// pending events, so a session with no SealKeeper work, whose log holds
// nothing new, sends nothing (VOU-627). SessionStart reads only the cached
// goal, which the task commands, status and a routine run refresh
// (keepNudgeFresh in nudge.ts), never a hook.

type HookInput = {
  event: string;
  // The folder Claude Code runs in, which picks the agent, see
  // sealkeeperHome. null when the payload has no absolute path there.
  cwd: string | null;
  // The model id SessionStart names, as it came, for the fingerprint source
  // (VOU-614). null when the payload has no string there.
  model: string | null;
};

type HookDeps = {
  fetch: typeof fetch;
  now?: () => Date;
  paths?: Paths;
  cachedGoal?: NudgeDeps['cachedGoal'];
};

// How the summary tells Claude to act on it, the slash command and the
// sealkeeper skill both run the run instructions.
export const CLAUDE_CODE_RUN = '/sealkeeper-run';

// Picks the few fields the adapter uses out of the raw stdin text, or null
// when it is not a hook payload. Only the event name, cwd and the model id
// are read. The model id is used only by SessionStart, the one hook Claude
// Code passes it to. Nothing else a hook carries is read, logged or
// emitted.
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
    cwd: cwdOf(raw.cwd),
    model: typeof raw.model === 'string' ? raw.model : null,
  };
}

function cwdOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && isAbsolute(value)
    ? value
    : null;
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
  await runHook(input, deps, p);
  // After the fingerprint parts are read, so the summary never holds them
  // up or breaks them.
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

async function runHook(
  input: HookInput,
  deps: HookDeps,
  p: Paths,
): Promise<void> {
  try {
    let config: Awaited<ReturnType<typeof readConfig>>;
    try {
      config = await readConfig(p);
    } catch (error) {
      if (error instanceof ConfigError) return;
      throw error;
    }
    if (config === null) return;
    // The fingerprint parts, read from the folder Claude Code runs in and
    // kept for the next sync or run, see fingerprint-claude-code.ts. Only
    // at session start and end, with the model id SessionStart names.
    // Never throws.
    const observe = (model: string | null) =>
      observeClaudeCode(
        config.agentId,
        { cwd: input.cwd ?? process.cwd(), env: process.env, model },
        p,
      );

    switch (input.event) {
      case 'SessionStart':
        await observe(input.model);
        return;
      case 'SessionEnd':
        // Before the sync below, which recomputes the fingerprint.
        // SessionEnd names no model, so a reported one is kept.
        await observe(null);
        await removeSessionMarkers(p);
        // Every SessionEnd, whatever session it ends, but with nothing
        // pending it makes no request. Nothing leaves on its own until the
        // operator has previewed and confirmed a first sync, which turns
        // autoSync on.
        if (config.autoSync) await trySync(deps, p);
        return;
      // Stop, a tool event, and any other, records nothing.
      default:
        return;
    }
  } catch (error) {
    warn(error);
  }
}

// A CLI before 0.5.0 kept a start time marker per session here. None is
// written now, so the folder goes once a session ends. Never fails the
// hook.
async function removeSessionMarkers(p: Paths): Promise<void> {
  try {
    await rm(p.sessions, { recursive: true, force: true });
  } catch {
    // Left for the next SessionEnd.
  }
}

// Best effort. What the log holds stays there, so a failure only means it
// goes with the next sync. The gate keeps Claude Code waiting for a few
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

function warn(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  stderr(`sealkeeper: hook failed, ${reason.split('\n')[0]}`);
}
