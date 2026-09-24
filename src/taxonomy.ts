// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  Event,
  EventPayload,
  EventType,
  type EventPayload as Payload,
} from '@sealkeeper/schema';
import type { z } from 'zod';

// What leaves this machine, in plain words. The types and fields come from
// the taxonomy schemas in @sealkeeper/schema, so this text cannot drift from
// what emit accepts and sync sends. Only the one line per field is written by
// hand, and the types below make a field without one a compile error.

type PayloadField = {
  [T in EventType]: keyof Payload<T>;
}[EventType];
type CommonField = Exclude<keyof Event, 'payload'>;

const FIELD_TEXT: Record<CommonField | PayloadField, string> = {
  event_id: 'a random id made on this machine for this event',
  type: 'the event type',
  occurred_at: 'when it happened',
  version: 'the agent version you set with vouched init',
  session_id: 'the id your agent framework gives the session',
  duration_ms: 'how long it took in milliseconds',
  tool: 'the tool name, for example Bash or Read',
  ok: 'whether the tool call succeeded',
  error_class:
    'when it failed, the kind of error, for example TypeError, never the message',
  task_id: 'the id of a task from the Vouched task exchange',
  task_type: 'the kind of task, for example lint',
  outcome: 'whether the task succeeded',
  evidence_hash: 'a SHA-256 hash of the evidence, never the evidence',
  kind: 'the kind of incident',
  detail_hash: 'a SHA-256 hash of the detail, never the detail',
  tokens_in: 'how many tokens went to the model, a count, not the text',
  tokens_out: 'how many tokens the model returned, a count, not the text',
  latency_ms: 'model time in milliseconds',
  model: 'the model name',
};

export const NEVER_LEAVES =
  'Prompts, tool inputs, tool outputs, file contents and model output never leave this machine.';

export const WIRE_FORM =
  'Each event is sent as exactly this JSON wrapped in a signature from your agent key, and nothing else.';

export type FieldRow = {
  name: string;
  kind: string;
  optional: boolean;
  text: string;
};

export type TypeRow = { type: EventType; fields: FieldRow[] };

// The fields every event carries next to its payload.
export function commonFields(): FieldRow[] {
  const shape = Event.options[0].shape as Record<string, z.ZodType>;
  return Object.entries(shape)
    .filter(([name]) => name !== 'payload')
    .map(([name, schema]) =>
      // type is a literal per member of the union, so name the choice.
      name === 'type'
        ? { ...fieldRow(name, schema), kind: 'one of the types below' }
        : fieldRow(name, schema),
    );
}

// One row per event type, in taxonomy order, with its payload fields.
export function taxonomyRows(): TypeRow[] {
  return EventType.options.map((type) => {
    const shape = EventPayload[type].shape as Record<string, z.ZodType>;
    return {
      type,
      fields: Object.entries(shape).map(([name, schema]) =>
        fieldRow(name, schema),
      ),
    };
  });
}

// The What leaves this machine block. init prints it at the end and the
// hidden command vouched what-is-shared prints it on its own.
export function describeTaxonomy(): string {
  const common = commonFields();
  const rows = taxonomyRows();
  const width =
    Math.max(...[...common, ...rows.flatMap((r) => r.fields)].map(nameLength)) +
    2;
  const line = (f: FieldRow) =>
    `  ${f.name.padEnd(width)}${f.text} (${f.kind}${f.optional ? ', optional' : ''})`;

  const out = [
    'What leaves this machine',
    '',
    `Only events of the ${rows.length} types below leave, each signed with your agent key.`,
    'Every event carries',
    ...common.map(line),
    'and the fields listed under its type, nothing else.',
  ];
  for (const row of rows) out.push('', row.type, ...row.fields.map(line));
  out.push('', NEVER_LEAVES);
  return out.join('\n');
}

function nameLength(f: FieldRow): number {
  return f.name.length;
}

function fieldRow(name: string, schema: z.ZodType): FieldRow {
  const def = schema.def as unknown as { type: string; innerType?: z.ZodType };
  const optional = def.type === 'optional';
  const inner = optional && def.innerType ? def.innerType : schema;
  return {
    name,
    kind: kindOf(inner),
    optional,
    text: FIELD_TEXT[name as keyof typeof FIELD_TEXT] ?? '',
  };
}

// The value's shape in plain words, read from the Zod schema.
function kindOf(schema: z.ZodType): string {
  const def = schema.def as unknown as {
    type: string;
    format?: string;
    entries?: Record<string, string>;
    values?: unknown[];
  };
  switch (def.type) {
    case 'boolean':
      return 'true or false';
    case 'number':
      return 'a number';
    case 'enum':
      return `one of ${Object.values(def.entries ?? {}).join(', ')}`;
    case 'literal':
      return (def.values ?? []).join(', ');
    case 'string':
      if (def.format === 'uuid') return 'a uuid';
      if (def.format === 'datetime') return 'a UTC timestamp';
      return 'text';
    default:
      return def.type;
  }
}
