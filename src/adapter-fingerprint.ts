// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// What the in-process adapters read for their fingerprint parts, kept out
// of the entry files so the published sealkeeper/mastra and
// sealkeeper/openclaw exports stay as they are. Only the adapters' own
// observers turn these into hashes, see fingerprint-observer.ts.
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageVersion, stableJson } from './fingerprint-content.js';
import { toolNameOf } from './names.js';

// Anything with an id, as the Mastra adapter wraps.
type ToolLike = { id: string };

// The installed @mastra/core version, looked for from each folder in starts
// upward, by default the agent's folder and this file's, which sits in the
// same node_modules as Mastra when installed from npm. null when not found.
export async function mastraVersion(
  starts: readonly string[] = [
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ],
): Promise<string | null> {
  for (const start of starts) {
    const version = await findPackageVersion('@mastra/core', start);
    if (version !== null) return version;
  }
  return null;
}

// A tool's JSON schema, or null when it has none this can read. A Zod 4
// schema gives its own with toJSONSchema, the AI SDK's jsonSchema() holds
// one under jsonSchema, and a plain JSON schema object is taken as it is.
// A schema that throws when read counts as none.
function jsonSchemaOf(value: unknown): unknown {
  try {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as { toJSONSchema?: unknown; jsonSchema?: unknown };
    if (typeof v.toJSONSchema === 'function') {
      return (v.toJSONSchema as () => unknown).call(value);
    }
    if (typeof v.jsonSchema === 'object' && v.jsonSchema !== null) {
      return v.jsonSchema;
    }
    const keys = Object.keys(value);
    return keys.some((k) =>
      ['type', 'properties', '$schema', 'anyOf'].includes(k),
    )
      ? value
      : null;
  } catch {
    return null;
  }
}

// The tools part's line for one tool, its name, a tab and its input and
// output schemas as JSON with sorted keys. Only the schemas are read, never
// arguments or results.
export function toolLine(name: string, tool: ToolLike): string {
  const { inputSchema, outputSchema } = tool as {
    inputSchema?: unknown;
    outputSchema?: unknown;
  };
  let schemas: string;
  try {
    schemas = stableJson({
      input: jsonSchemaOf(inputSchema),
      output: jsonSchemaOf(outputSchema),
    });
  } catch {
    schemas = 'null';
  }
  return `${name}\t${schemas}`;
}

// The OpenClaw version of the Gateway this plugin runs in, from the
// package.json of the openclaw package that holds the running script, or
// null when the script is not inside one. entry defaults to process.argv[1].
export async function openClawVersion(
  entry: string | undefined = process.argv[1],
): Promise<string | null> {
  if (entry === undefined || entry === '') return null;
  const real = await realpath(entry).catch(() => entry);
  return findPackageVersion('openclaw', dirname(real));
}

// The model id of a Mastra step or generate result, response.modelId, else
// model.modelId, else model, else response.modelMetadata.modelId, the first
// that gives a name, as it is written, so an empty string never wins. On
// Gemini response.modelId is undefined on the result and empty on a step,
// and the id is in response.modelMetadata (VOU-623, @mastra/core 1.74.0).
// The live adapter reads it per step, the routine per answer (VOU-614).
export function rawModelIdOf(response: unknown, model: unknown): unknown {
  const r = response as
    | { modelId?: unknown; modelMetadata?: { modelId?: unknown } | null }
    | null
    | undefined;
  return [
    r?.modelId,
    (model as { modelId?: unknown } | null | undefined)?.modelId,
    model,
    r?.modelMetadata?.modelId,
  ].find((id) => toolNameOf(id) !== null);
}
