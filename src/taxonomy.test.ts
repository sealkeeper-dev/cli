// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { readFileSync } from 'node:fs';
import { EventPayload, EventType } from '@sealkeeper/schema';
import { describe, expect, it } from 'vitest';
import {
  commonFields,
  describeTaxonomy,
  NEVER_LEAVES,
  taxonomyRows,
} from './taxonomy.js';

describe('describeTaxonomy', () => {
  const text = describeTaxonomy();
  const lines = text.split('\n');

  it('names every event type on its own line, in taxonomy order', () => {
    const typeLines = lines.filter((l) =>
      (EventType.options as string[]).includes(l),
    );
    expect(typeLines).toEqual(EventType.options);
  });

  it('lists every field of every payload schema under its type', () => {
    for (const type of EventType.options) {
      const start = lines.indexOf(type);
      const block = [];
      for (let i = start + 1; i < lines.length && lines[i] !== ''; i++) {
        block.push(lines[i]?.trim().split(/\s+/)[0]);
      }
      expect(block).toEqual(Object.keys(EventPayload[type].shape));
    }
  });

  it('lists the fields every event carries', () => {
    for (const name of ['event_id', 'type', 'occurred_at', 'version']) {
      expect(lines.some((l) => l.trim().startsWith(`${name} `))).toBe(true);
    }
    expect(commonFields().map((f) => f.name)).toEqual([
      'event_id',
      'type',
      'occurred_at',
      'version',
    ]);
    expect(commonFields().find((f) => f.name === 'type')?.kind).toBe(
      'one of the types below',
    );
  });

  it('has plain words and a kind for every field', () => {
    for (const row of taxonomyRows()) {
      for (const field of row.fields) {
        expect(field.text, field.name).not.toBe('');
        expect(field.kind, field.name).not.toMatch(/^(pipe|union|object)$/);
      }
    }
  });

  it('marks optional fields and spells out enums', () => {
    const tool = taxonomyRows().find((r) => r.type === 'tool.call');
    expect(tool?.fields.find((f) => f.name === 'error_class')?.optional).toBe(
      true,
    );
    const incident = taxonomyRows().find((r) => r.type === 'incident');
    expect(incident?.fields.find((f) => f.name === 'kind')?.kind).toBe(
      'one of scope, tool_denied, leak_suspected, flagged',
    );
  });

  it('matches the table in the README', () => {
    const readme = readFileSync(
      new URL('../README.md', import.meta.url),
      'utf8',
    );
    for (const row of taxonomyRows()) {
      const fields = row.fields
        .map((f) => `\`${f.name}\`${f.optional ? ' (optional)' : ''}`)
        .join(', ');
      expect(readme).toContain(`| \`${row.type}\` | ${fields} |`);
    }
    expect(readme).toContain(
      NEVER_LEAVES.replace('this machine', 'your machine'),
    );
  });

  it('ends with what never leaves and uses no em-dash', () => {
    expect(text.endsWith(NEVER_LEAVES)).toBe(true);
    expect(text).not.toContain('—');
  });
});
