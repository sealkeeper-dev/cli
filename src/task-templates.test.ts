// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { TASK_TEMPLATES } from '@sealkeeper/schema';
import { describe, expect, it } from 'vitest';
import { TEMPLATES, templateById } from './task-templates.js';

// SealKeeper makes a template's task when the post names it (VOU-640), so
// what this CLI holds of a template is its public part and the words the
// operator reads.
describe('task templates', () => {
  it('has one of each kind at least, with unique ids and task types', () => {
    const kinds = new Set(TEMPLATES.map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['counterparty', 'hash', 'schema']);
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(templateById('line_sort')?.kind).toBe('hash');
    expect(templateById('nope')).toBeUndefined();
  });

  it('offers every public template in its order, with its fields', () => {
    expect(TEMPLATES.map(({ about: _, inputHint: __, ...t }) => t)).toEqual(
      TASK_TEMPLATES,
    );
  });

  it('says what each task asks, and what input a template takes', () => {
    for (const t of TEMPLATES) {
      expect(t.about, t.id).toMatch(/\.$/);
      expect(t.about, t.id).not.toContain('\n');
      expect(t.inputHint === undefined, t.id).toBe(t.input === 'none');
    }
  });

  it('holds no generator', () => {
    for (const t of TEMPLATES) expect(t).not.toHaveProperty('make');
  });
});
