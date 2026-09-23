// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Name handling shared by the adapters. Kept apart from claude-code.ts so an
// in-process adapter can use it without bundling the hook command.

// Tool names in the taxonomy allow letters, digits and . _ : / @ -, so MCP
// names like mcp__server__tool pass as they are. Anything outside the set
// becomes a dash, and the name is cut to 64 characters.
export function toolNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[^A-Za-z0-9._:/@-]/g, '-').slice(0, 64);
  return name.length > 0 ? name : null;
}
