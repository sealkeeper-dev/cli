// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, randomUUID } from 'node:crypto';
import { PostTaskRequest, redactJsonSchema } from '@sealkeeper/schema';
import { describe, expect, it } from 'vitest';
import {
  type Draw,
  MAX_INPUT_CHARS,
  TEMPLATES,
  TemplateInputError,
  type TemplateTask,
  templateById,
} from './task-templates.js';

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// A draw that always takes the low end, and one from a fixed sequence, so a
// test can make the same task twice.
const low: Draw = (lo) => lo;
function seeded(seed: number): Draw {
  let a = seed >>> 0;
  return (lo, hi) => {
    a = (a * 1103515245 + 12345) >>> 0;
    return lo + (a % (hi - lo + 1));
  };
}

// Solved here without the template's code, from the spec's own words.
const dedupe = (input: string) =>
  `${[...new Set(input.split('\n'))].join('\n')}\n`;
const sortLines = (input: string) =>
  `${input
    .split('\n')
    .sort((a, b) => {
      const x = [...a].map((c) => c.codePointAt(0) ?? 0);
      const y = [...b].map((c) => c.codePointAt(0) ?? 0);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return x.length - y.length;
    })
    .join('\n')}\n`;

const INPUTS: Record<string, string> = {
  text_dedupe: 'b\na\nb\n',
  line_sort: 'b\nA\na\n',
  summarise: 'word '.repeat(45),
  answer_question: 'Which planet is largest?',
};

// Every way each template makes a task, drawn and with input.
function everyTask(): [string, TemplateTask][] {
  const out: [string, TemplateTask][] = [];
  for (const t of TEMPLATES) {
    if (t.input !== 'required') {
      for (let seed = 1; seed <= 25; seed++) {
        out.push([`${t.id} seed ${seed}`, t.make(undefined, seeded(seed))]);
      }
      out.push([`${t.id} low`, t.make(undefined, low)]);
    }
    const input = INPUTS[t.id];
    if (t.input !== 'none' && input !== undefined) {
      out.push([`${t.id} input`, t.make(input)]);
    }
  }
  return out;
}

describe('task templates', () => {
  it('has one of each kind at least, with unique ids and task types', () => {
    const kinds = new Set(TEMPLATES.map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['counterparty', 'hash', 'schema']);
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(templateById('line_sort')?.kind).toBe('hash');
    expect(templateById('nope')).toBeUndefined();
  });

  it('makes tasks the post request schema accepts', () => {
    for (const [label, task] of everyTask()) {
      const request = PostTaskRequest.safeParse({
        taskId: randomUUID(),
        taskType: task.taskType,
        spec: task.spec,
        verification: task.verification,
      });
      expect(request.success, label).toBe(true);
    }
  });

  it('hash tasks carry the sha256 of the answer the spec asks for', () => {
    for (const [label, task] of everyTask()) {
      if (task.verification.kind !== 'hash') continue;
      const solve = task.taskType === 'text_dedupe' ? dedupe : sortLines;
      const answer = solve(task.spec.input);
      expect(task.answer, label).toBe(answer);
      expect(task.verification.sha256, label).toBe(sha256(answer));
    }
  });

  it('draws a different task each time, so no answer can be copied', () => {
    for (const t of TEMPLATES) {
      if (t.input === 'required') continue;
      const specs = new Set(
        Array.from({ length: 10 }, () => JSON.stringify(t.make().verification)),
      );
      expect(specs.size, t.id).toBeGreaterThan(1);
    }
  });

  it('schema tasks pin every value and hide them from other agents', () => {
    for (const [label, task] of everyTask()) {
      if (task.verification.kind !== 'schema') continue;
      const schema = task.verification.jsonSchema as {
        properties: Record<string, { const: unknown; type: string }>;
        required: string[];
        additionalProperties: boolean;
      };
      const answer = JSON.parse(task.answer ?? '') as Record<string, unknown>;
      expect(Object.keys(answer).sort(), label).toEqual(
        [...schema.required].sort(),
      );
      expect(schema.additionalProperties).toBe(false);
      for (const [key, sub] of Object.entries(schema.properties)) {
        expect(sub.const, `${label} ${key}`).toEqual(answer[key]);
        // Every value is in the sentence the agent reads.
        const shown =
          typeof answer[key] === 'boolean' ? null : String(answer[key]);
        if (shown !== null && typeof answer[key] === 'string') {
          expect(task.spec.input, `${label} ${key}`).toContain(shown);
        }
      }
      // The API refuses pattern, and reads drop const.
      expect(JSON.stringify(schema)).not.toContain('pattern');
      expect(
        JSON.stringify(redactJsonSchema(task.verification.jsonSchema)),
      ).not.toContain('const');
    }
  });

  it('counterparty tasks need the operator input and carry no answer', () => {
    for (const t of TEMPLATES.filter((x) => x.kind === 'counterparty')) {
      expect(t.input).toBe('required');
      expect(() => t.make(undefined)).toThrow(TemplateInputError);
      const task = t.make(INPUTS[t.id]);
      expect(task.answer).toBeUndefined();
      expect(task.verification).toEqual({ kind: 'counterparty' });
      expect(task.spec.output).toContain('The poster');
    }
  });

  it('takes the operator input as given, with Windows line ends made plain', () => {
    const dedupeTask = templateById('text_dedupe')?.make('x\r\ny\r\nx\r\n');
    expect(dedupeTask?.spec.input).toBe('x\ny\nx');
    expect(dedupeTask?.answer).toBe('x\ny\n');
    const sortTask = templateById('line_sort')?.make('b\nA\na');
    expect(sortTask?.answer).toBe('A\na\nb\n');
  });

  it('drops a leading byte order mark, as some editors save one', () => {
    const plain = templateById('line_sort')?.make('b\na');
    const marked = templateById('line_sort')?.make('\uFEFFb\na');
    expect(marked?.spec.input).toBe('b\na');
    expect(marked?.verification).toEqual(plain?.verification);
    expect(
      templateById('answer_question')?.make('\uFEFFIs this a question?').spec
        .input,
    ).toBe('Is this a question?');
  });

  it('drops every trailing line feed, so a file with blank lines at the end reads the same', () => {
    for (const id of ['text_dedupe', 'line_sort']) {
      const plain = templateById(id)?.make('b\na\nb');
      const trailing = templateById(id)?.make('b\na\nb\n\n\r\n\n');
      expect(trailing?.spec.input, id).toBe('b\na\nb');
      expect(trailing?.verification, id).toEqual(plain?.verification);
    }
  });

  it.each([
    ['text_dedupe', 'a\n\nb\na'],
    ['line_sort', 'b\n\na'],
    ['text_dedupe', '\na\na'],
  ])('refuses %s input with an empty line in it', (id, input) => {
    expect(() => templateById(id)?.make(input)).toThrow(TemplateInputError);
    expect(() => templateById(id)?.make(input)).toThrow('an empty line');
  });

  it.each([
    ['text_dedupe', 'a\nb\nc', 'no line repeats'],
    ['line_sort', 'A\na\nb', 'already in order'],
    ['summarise', 'too short to summarise here', 'fewer than 40 words'],
    ['answer_question', 'Why?', 'fewer than 3 words'],
    ['summarise', '   \n  ', 'the input is empty'],
    ['answer_question', 'x '.repeat(MAX_INPUT_CHARS), 'longer than'],
  ])('refuses %s input that does not fit', (id, input, message) => {
    expect(() => templateById(id)?.make(input)).toThrow(message);
  });
});
