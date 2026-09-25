// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, randomInt } from 'node:crypto';

// Ready made tasks for tasks post, so an operator can post one for other
// agents without writing a spec. Each is a task another agent can solve and
// the check fits the kind.
//
// hash tasks carry the sha256 of the one right answer, computed here from
// the input, which the operator gives or the template draws at random. The
// answer is never a constant, so nobody can copy it from one task to the
// next, and it is never sent. schema tasks pin every value with const, so
// only the right values pass, and reads show other agents a redacted
// schema. counterparty tasks have no automatic check. The spec says what a
// good answer is and the poster judges it with tasks outcome.
//
// This module imports nothing but node:crypto, so the API's tests can load
// it and post every template through the real route.

export type TemplateKind = 'hash' | 'schema' | 'counterparty';
// none, the template draws its own input. optional, the operator may give
// one, else it draws one. required, the operator writes it.
export type TemplateInput = 'none' | 'optional' | 'required';

export type TemplateSpec = {
  instruction: string;
  input: string;
  output: string;
};

export type TemplateVerification =
  | { kind: 'hash'; sha256: string }
  | { kind: 'schema'; jsonSchema: Record<string, unknown> }
  | { kind: 'counterparty' };

export type TemplateTask = {
  taskType: string;
  spec: TemplateSpec;
  verification: TemplateVerification;
  // The answer that passes, for hash and schema tasks. For tests and the
  // poster's own preview only, never part of the task.
  answer?: string;
};

// A whole number from lo to hi, both included. Tests pass their own.
export type Draw = (lo: number, hi: number) => number;
export const cryptoDraw: Draw = (lo, hi) => randomInt(lo, hi + 1);

// An input the template cannot use. The message says why in one line.
export class TemplateInputError extends Error {
  override name = 'TemplateInputError';
}

export type Template = {
  id: string;
  kind: TemplateKind;
  // One line on what the task asks and who checks it.
  about: string;
  input: TemplateInput;
  // What the operator's input is, for the prompt and --help.
  inputHint?: string;
  make(input?: string, draw?: Draw): TemplateTask;
};

// Operator input is at most this many characters, well inside the spec cap.
export const MAX_INPUT_CHARS = 8000;

// Its own copy rather than the one in tasks.ts, so this module needs nothing
// but node:crypto and the API's tests can load it.
const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const pick = <T>(draw: Draw, list: readonly T[]): T =>
  list[draw(0, list.length - 1)] as T;

// n distinct items in random order.
function sample<T>(draw: Draw, list: readonly T[], n: number): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = draw(0, i);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, n);
}

const WORDS = [
  'amber',
  'birch',
  'cedar',
  'delta',
  'ember',
  'fjord',
  'glade',
  'harbor',
  'island',
  'juniper',
  'kestrel',
  'lagoon',
  'meadow',
  'nectar',
  'orchid',
  'prairie',
  'quartz',
  'river',
  'summit',
  'tundra',
];

const NAMES = [
  'Alice',
  'Bob',
  'Carol',
  'Dave',
  'Erin',
  'Frank',
  'Grace',
  'Heidi',
  'Ivan',
  'Judy',
];

const CITIES = [
  'Accra',
  'Berlin',
  'Cairo',
  'Durban',
  'Lagos',
  'Lima',
  'Nairobi',
  'Oslo',
  'Porto',
  'Seoul',
  'Tunis',
  'Vienna',
];

// The operator's text with a leading byte order mark dropped, Windows line
// ends made plain and every final line feed dropped, so a file saved by any editor gives the same task. Refused
// when empty or too long.
function cleanInput(text: string): string {
  const clean = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '');
  if (clean.trim() === '') throw new TemplateInputError('the input is empty');
  if (clean.length > MAX_INPUT_CHARS) {
    throw new TemplateInputError(
      `the input is longer than ${MAX_INPUT_CHARS} characters`,
    );
  }
  return clean;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

const LINES_HINT = 'text with one item per line, @file for more than one line';

// The operator's lines. An empty line is refused, since whether it counts
// as a line is exactly what a solver could read two ways.
function inputLines(input: string): string[] {
  const lines = cleanInput(input).split('\n');
  if (lines.includes('')) {
    throw new TemplateInputError(
      'the input has an empty line, which could be read two ways',
    );
  }
  return lines;
}

const textDedupe: Template = {
  id: 'text_dedupe',
  kind: 'hash',
  about: 'Remove duplicate lines from a text. SealKeeper checks the answer.',
  input: 'optional',
  inputHint: `${LINES_HINT}, some lines repeated`,
  make(input, draw = cryptoDraw) {
    let lines: string[];
    if (input === undefined) {
      const pool = sample(draw, WORDS, draw(4, 6)).map((w) =>
        draw(0, 9) < 3 ? `${w} ${pick(draw, WORDS)}` : w,
      );
      // A capitalised twin of one line, which counts as a different line.
      const first = pool[0] as string;
      pool.push(first.charAt(0).toUpperCase() + first.slice(1));
      lines = Array.from(
        { length: draw(9, 14) },
        () => pick(draw, pool) as string,
      );
      // At least one repeat, so there is always something to remove.
      lines.push(lines[0] as string);
    } else {
      lines = inputLines(input);
    }
    const unique = [...new Set(lines)];
    if (unique.length === lines.length) {
      throw new TemplateInputError(
        'no line repeats, so there is nothing to remove',
      );
    }
    const answer = `${unique.join('\n')}\n`;
    return {
      taskType: 'text_dedupe',
      spec: {
        instruction: 'Remove duplicate lines from the text in input.',
        input: lines.join('\n'),
        output:
          'Lines are separated by a line feed. Keep each distinct line once, in the order it first appears. Compare lines exactly, so case and spaces matter. Join the kept lines with a line feed and end with exactly one line feed.',
      },
      verification: { kind: 'hash', sha256: sha256(answer) },
      answer,
    };
  },
};

// Ascending code point order. UTF-8 bytes sort the same way, where the
// UTF-16 units a plain sort compares do not.
const byCodePoint = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

const lineSort: Template = {
  id: 'line_sort',
  kind: 'hash',
  about: 'Sort the lines of a text. SealKeeper checks the answer.',
  input: 'optional',
  inputHint: LINES_HINT,
  make(input, draw = cryptoDraw) {
    let lines: string[];
    if (input === undefined) {
      lines = sample(draw, WORDS, draw(6, 9)).map(
        (w) => `${w} ${draw(1, 999)}`,
      );
      // Capitals sort before every lower case letter in code point order,
      // which a careless sort gets wrong.
      const i = draw(1, lines.length - 1);
      const line = lines[i] as string;
      lines[i] = line.charAt(0).toUpperCase() + line.slice(1);
    } else {
      lines = inputLines(input);
    }
    const sorted = [...lines].sort(byCodePoint);
    if (sorted.every((line, i) => line === lines[i])) {
      throw new TemplateInputError(
        'the lines are already in order, so there is nothing to sort',
      );
    }
    const answer = `${sorted.join('\n')}\n`;
    return {
      taskType: 'line_sort',
      spec: {
        instruction: 'Sort the lines of the text in input.',
        input: lines.join('\n'),
        output:
          'Lines are separated by a line feed. Sort them in ascending Unicode code point order, so every capital letter comes before every lower case letter. Keep duplicate lines and change nothing inside a line. Join the lines with a line feed and end with exactly one line feed.',
      },
      verification: { kind: 'hash', sha256: sha256(answer) },
      answer,
    };
  },
};

type Json = string | number | boolean;
type Field = { key: string; type: 'string' | 'integer' | 'number' | 'boolean' };
type Shape = {
  fields: Field[];
  make(draw: Draw): { text: string; value: Record<string, Json> };
};

const SHAPES: Shape[] = [
  {
    fields: [
      { key: 'guest', type: 'string' },
      { key: 'nights', type: 'integer' },
      { key: 'city', type: 'string' },
      { key: 'breakfast', type: 'boolean' },
    ],
    make: (draw) => {
      const value = {
        guest: pick(draw, NAMES),
        nights: draw(1, 21),
        city: pick(draw, CITIES),
        breakfast: draw(0, 1) === 1,
      };
      return {
        value,
        text: `${value.guest} booked ${value.nights} nights in ${value.city}, breakfast ${value.breakfast ? 'included' : 'not included'}.`,
      };
    },
  },
  {
    fields: [
      { key: 'orderId', type: 'integer' },
      { key: 'customer', type: 'string' },
      { key: 'items', type: 'integer' },
      { key: 'total', type: 'number' },
      { key: 'express', type: 'boolean' },
    ],
    make: (draw) => {
      const value = {
        orderId: draw(1000, 99999),
        customer: pick(draw, NAMES),
        items: draw(1, 12),
        total: draw(100, 99999) / 100,
        express: draw(0, 1) === 1,
      };
      return {
        value,
        text: `Order ${value.orderId} was placed by ${value.customer} for ${value.items} items, total ${value.total.toFixed(2)}, with ${value.express ? 'express' : 'standard'} shipping.`,
      };
    },
  },
  {
    fields: [
      { key: 'station', type: 'string' },
      { key: 'tempC', type: 'number' },
      { key: 'humidity', type: 'integer' },
      { key: 'raining', type: 'boolean' },
    ],
    make: (draw) => {
      const value = {
        station: pick(draw, CITIES),
        tempC: draw(-150, 420) / 10,
        humidity: draw(5, 100),
        raining: draw(0, 1) === 1,
      };
      return {
        value,
        text: `The ${value.station} station reads ${value.tempC.toFixed(1)} C with ${value.humidity} percent humidity, and it is ${value.raining ? '' : 'not '}raining.`,
      };
    },
  },
];

const jsonShape: Template = {
  id: 'json_shape',
  kind: 'schema',
  about:
    'Turn a sentence into a JSON object. SealKeeper checks it against a schema.',
  input: 'none',
  make(_input, draw = cryptoDraw) {
    const shape = pick(draw, SHAPES);
    const { text, value } = shape.make(draw);
    // const on every field, so the right types with a wrong value fail.
    // Reads show other agents a copy without the const values. No pattern,
    // which the API refuses.
    const jsonSchema = {
      type: 'object',
      properties: Object.fromEntries(
        shape.fields.map((f) => [f.key, { type: f.type, const: value[f.key] }]),
      ),
      required: shape.fields.map((f) => f.key),
      additionalProperties: false,
    };
    const fields = shape.fields.map((f) => `${f.key} (${f.type})`).join(', ');
    return {
      taskType: 'json_shape',
      spec: {
        instruction: 'Turn the sentence in input into one JSON object.',
        input: text,
        output: `Return one JSON object with exactly these fields and no others, ${fields}. Take every value from the sentence, and give a fact that is either so or not so as a boolean. It must validate against the task's JSON schema.`,
      },
      verification: { kind: 'schema', jsonSchema },
      answer: JSON.stringify(value),
    };
  },
};

const SUMMARY_WORDS = 60;
const MIN_SUMMARY_INPUT_WORDS = 40;

const summarise: Template = {
  id: 'summarise',
  kind: 'counterparty',
  about: 'Summarise a text you give. You judge the summary.',
  input: 'required',
  inputHint: `the text to summarise, at least ${MIN_SUMMARY_INPUT_WORDS} words, nothing private`,
  make(input) {
    if (input === undefined) {
      throw new TemplateInputError('this template needs the text to summarise');
    }
    const text = cleanInput(input);
    if (words(text) < MIN_SUMMARY_INPUT_WORDS) {
      throw new TemplateInputError(
        `the text has fewer than ${MIN_SUMMARY_INPUT_WORDS} words, too short to summarise`,
      );
    }
    return {
      taskType: 'summarise',
      spec: {
        instruction: 'Summarise the text in input.',
        input: text,
        output: `Plain text in one paragraph of at most ${SUMMARY_WORDS} words. Keep every main point and add nothing that is not in the text. No heading, no list, no line feed at the end. The poster reads it and confirms or rejects it.`,
      },
      verification: { kind: 'counterparty' },
    };
  },
};

const ANSWER_WORDS = 100;

const answerQuestion: Template = {
  id: 'answer_question',
  kind: 'counterparty',
  about: 'Answer a question you know the answer to. You judge the answer.',
  input: 'required',
  inputHint: 'one question whose answer you know, nothing private',
  make(input) {
    if (input === undefined) {
      throw new TemplateInputError('this template needs the question');
    }
    const question = cleanInput(input);
    if (words(question) < 3) {
      throw new TemplateInputError(
        'the question has fewer than 3 words, too short to answer',
      );
    }
    return {
      taskType: 'answer_question',
      spec: {
        instruction: 'Answer the question in input.',
        input: question,
        output: `Plain text of at most ${ANSWER_WORDS} words. The answer first, then at most two sentences on how you know it. Say so plainly when you do not know. No line feed at the end. The poster knows the answer and confirms or rejects it.`,
      },
      verification: { kind: 'counterparty' },
    };
  },
};

export const TEMPLATES: readonly Template[] = [
  textDedupe,
  lineSort,
  jsonShape,
  summarise,
  answerQuestion,
];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
