// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINGERPRINT_SENDS } from '../fingerprint.js';
import { createProgram } from '../program.js';
import { COMMAND_SENDS } from './what-is-shared.js';

// VOU-624. what-is-shared is a privacy promise, so it must never say less
// than the code sends. These read the code rather than a list written here,
// so a new sender fails until the text names it.

const SRC = new URL('../', import.meta.url);

// Every source file under src, tests left out, with comments removed so a
// name in a comment is not a call.
function sources(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  for (const dir of ['', 'commands/']) {
    for (const name of readdirSync(new URL(dir, SRC))) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const text = readFileSync(new URL(`${dir}${name}`, SRC), 'utf8');
      out.push({
        file: `${dir}${name}`,
        code: text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      });
    }
  }
  return out;
}

const names = (text: string, name: string) =>
  new RegExp(`(^|[\\s,(])${name}\\b`).test(text);

// The commands whose requests carry the fingerprint, each caller of
// sendWithFingerprint in tasks.ts and each caller of postEvents, which
// sends it beside the events, named by its file.
function fingerprintSenders(): string[] {
  const senders = new Set<string>();
  for (const { file, code } of sources()) {
    if (file === 'tasks.ts' || file === 'api.ts') continue;
    if (/\bsendWithFingerprint\(/.test(code) || /\.postEvents\(/.test(code)) {
      senders.add(basename(file, '.ts'));
    }
  }
  return [...senders].sort();
}

describe('what-is-shared names every request that carries the fingerprint', () => {
  it('finds the senders in the code', () => {
    // A floor, so a broken scan cannot pass by finding nothing.
    expect(fingerprintSenders()).toEqual(
      expect.arrayContaining(['claim', 'submit', 'sync']),
    );
  });

  it('names each one in the fingerprint block and in the command list', () => {
    const line = COMMAND_SENDS.find((l) =>
      l.includes("also carry the agent's current fingerprint"),
    );
    expect(line).toBeDefined();
    for (const sender of fingerprintSenders()) {
      expect(names(FINGERPRINT_SENDS, sender), sender).toBe(true);
      expect(names(line ?? '', sender), sender).toBe(true);
    }
  });
});

// Every command a person or an agent can run. Those that send nothing are
// the only ones the list may leave out.
const SENDS_NOTHING = ['logout', 'what-is-shared'];

describe('what-is-shared names every command that sends', () => {
  it('has a line for each command but the ones that send nothing', () => {
    const text = COMMAND_SENDS.join('\n');
    const commands = createProgram()
      .commands.map((c) => c.name())
      .filter((n) => n !== 'help');
    expect(commands.length).toBeGreaterThan(10);
    for (const name of commands) {
      if (SENDS_NOTHING.includes(name)) continue;
      expect(names(text, name), name).toBe(true);
    }
  });
});
