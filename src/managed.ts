// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The one mark on every file SealKeeper writes into someone else's tool,
// the Claude Code slash command and skill and the routine's scheduler
// files. Install writes and remove deletes only a file that carries it, so
// a file the operator wrote is never touched.

export const MANAGED_MARKER = 'managed-by: sealkeeper';

// How far down a file the marker may sit. The skill's frontmatter puts it
// fourth, after the opening line, its name and its description.
const HEADER_LINES = 5;

// Ours when one of the first few lines is the marker, alone as a YAML key
// or after a # or <!-- comment opener, and followed by nothing, a full stop,
// a comma or a space. In a file that opens with YAML frontmatter the marker
// counts only inside it, before the closing ---.
export function isManaged(text: string): boolean {
  const lines = text.split(/\r?\n/).slice(0, HEADER_LINES);
  for (const [i, line] of lines.entries()) {
    if (i > 0 && line === '---') return false;
    const bare = line.trim().replace(/^(?:#|<!--)\s*/, '');
    if (!bare.startsWith(MANAGED_MARKER)) continue;
    const next = bare.charAt(MANAGED_MARKER.length);
    if (next === '' || next === '.' || next === ',' || next === ' ') {
      return true;
    }
  }
  return false;
}
