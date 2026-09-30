// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Name handling shared by the adapters. Kept apart from claude-code.ts so an
// in-process adapter can use it without bundling the hook command.
import { ModelName } from '@sealkeeper/schema';

// Tool names in the taxonomy allow letters, digits and . _ : / @ -, so MCP
// names like mcp__server__tool pass as they are. Anything outside the set
// becomes a dash, and the name is cut to 64 characters.
export function toolNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[^A-Za-z0-9._:/@-]/g, '-').slice(0, 64);
  return name.length > 0 ? name : null;
}

// The model name an adapter declares for a model id it read (VOU-566), as
// text, or null when the id gives none. The id through toolNameOf, so
// opus[1m] reads as opus-1m-, when that is a ModelName. An AWS ARN, as a
// Bedrock inference profile in ANTHROPIC_MODEL is, names the operator's
// account and region, and an id longer than 64 characters would be cut
// short, so of either only the part after the last slash is kept, and no
// name when that part is still an ARN or too long. The model part of the
// fingerprint hashes the whole id as before.
export function modelNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  const tail =
    id.startsWith('arn:') || id.length > 64
      ? id.slice(id.lastIndexOf('/') + 1)
      : id;
  if (tail.startsWith('arn:') || tail.length > 64) return null;
  const name = toolNameOf(tail);
  return name !== null && ModelName.safeParse(name).success ? name : null;
}
