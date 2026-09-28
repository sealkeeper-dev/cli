// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// What a fingerprint part is hashed from, built the same way by every
// adapter, and the package version lookups the framework part uses. The
// text built here is hashed with partHash from @sealkeeper/schema and never
// leaves this machine.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Model ids, each once, sorted, one per line.
export function modelSetContent(ids: Iterable<string>): string {
  return [...new Set(ids)].sort().join('\n');
}

// Lines, each once, sorted, one per line.
export function linesContent(lines: Iterable<string>): string {
  return [...new Set(lines)].sort().join('\n');
}

// A framework and its version, as in claude-code@2.1.283.
export function frameworkContent(name: string, version: string): string {
  return `${name}@${version}`;
}

// JSON with object keys sorted at every level, so one schema gives one text
// whatever order its keys were built in. undefined and functions are left
// out as JSON.stringify leaves them. Throws on a cycle.
export function stableJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) throw new Error('cycle');
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item) ?? null);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item === undefined || typeof item === 'function') continue;
        out[key] = walk(item);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return JSON.stringify(walk(value)) ?? 'null';
}

// The version in the package.json of the package named name, looked for in
// each folder from start up to the root, both as that folder's own
// package.json and under node_modules. null when none is found.
export async function findPackageVersion(
  name: string,
  start: string,
): Promise<string | null> {
  let dir = start;
  for (;;) {
    for (const file of [
      join(dir, 'package.json'),
      join(dir, 'node_modules', ...name.split('/'), 'package.json'),
    ]) {
      const version = await packageVersion(file, name);
      if (version !== null) return version;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

// A version string that looks like semver, as in 2.1.283.
export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && VERSION.test(value);
}

async function packageVersion(
  file: string,
  name: string,
): Promise<string | null> {
  try {
    const json = JSON.parse(await readFile(file, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return json.name === name && isVersion(json.version) ? json.version : null;
  } catch {
    return null;
  }
}
