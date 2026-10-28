// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { stderr } from './output.js';

// The first release of each Node line with the Node security fixes of 21
// October 2026. A later line counts from the newest one here. package.json
// engines asks only for Node 22.12, the oldest the CLI runs on, so npm always
// installs the latest CLI and this note asks for the update instead.
const PATCHED: readonly Version[] = [
  [22, 23, 4],
  [24, 22, 1],
  [26, 12, 1],
];
const NEWEST_LINE = 26;

type Version = readonly [number, number, number];

function parts(version: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Whether this Node has the security fixes. A release of its own line counts
// from that line's floor, and an odd or older line has none. A version that
// does not parse is given the benefit of the doubt.
export function nodeIsPatched(version: string): boolean {
  const v = parts(version);
  if (v === null) return true;
  const [major, minor, patch] = v;
  if (major > NEWEST_LINE) return true;
  const floor = PATCHED.find(([line]) => line === major);
  if (floor === undefined) return false;
  const [, floorMinor, floorPatch] = floor;
  return minor !== floorMinor ? minor > floorMinor : patch >= floorPatch;
}

export function nodeUpdateNote(version: string): string {
  return `warning: Node ${version.replace(/^v/, '')} lacks the Node security fixes of 21 October 2026, update to Node 22.23.4, 24.22.1 or 26.12.1, or a newer release of the same line`;
}

// One line on stderr when this Node lacks the fixes. Never stops the command.
export function warnUnpatchedNode(version = process.versions.node): void {
  if (!nodeIsPatched(version)) stderr(nodeUpdateNote(version));
}
