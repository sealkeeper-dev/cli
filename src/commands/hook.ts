// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { handleHook, parseHookInput } from '../claude-code.js';
import { defaultSyncDeps, type SyncDeps } from './sync.js';

// Hook entry points that agent frameworks call. Hidden from help, since
// people run `sealkeeper adapter ... install` and never these directly.

// Claude Code writes the payload and closes stdin at once. Past this, or past
// MAX_STDIN_BYTES, the hook gives up and does nothing.
export const STDIN_TIMEOUT_MS = 1_000;
export const MAX_STDIN_BYTES = 64 * 1024 * 1024;

export type HookCommandDeps = SyncDeps & {
  readStdin: () => Promise<string | null>;
};

export const defaultHookDeps: HookCommandDeps = {
  ...defaultSyncDeps,
  readStdin: () => readStdin(process.stdin),
};

export function register(
  parent: Command,
  deps: HookCommandDeps = defaultHookDeps,
): Command {
  const hook = parent
    .command('hook', { hidden: true })
    .description('Entry points for agent framework hooks');
  hook
    .command('claude-code')
    .description('Claude Code hook, reads the hook payload on stdin')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      // Always exits 0 and never writes to stdout, whatever the input.
      try {
        const text = await deps.readStdin();
        const input = text === null ? null : parseHookInput(text);
        if (input === null) return;
        await handleHook(input, { fetch: deps.fetch, sleep: deps.sleep });
      } catch {
        // handleHook reports its own failures. Nothing else should throw.
      }
    });
  return hook;
}

// The whole of stdin as text, or null on a terminal, a timeout or too much
// input.
export function readStdin(
  stream: NodeJS.ReadStream,
  timeoutMs = STDIN_TIMEOUT_MS,
): Promise<string | null> {
  if (stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (text: string | null) => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
      stream.pause();
      resolve(text);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) finish(null);
      else chunks.push(chunk);
    });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(null));
  });
}
