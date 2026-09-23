// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { Event, type EventPayload, type EventType } from '@vouched-dev/schema';
import {
  DEFAULT_AGENT_VERSION,
  type Paths,
  paths,
  readConfig,
} from './config.js';
import { appendEvent } from './log.js';

// What a caller of emit supplies. type and payload are required, the rest is
// filled in. The payload shape follows the type, as in @vouched-dev/schema.
export type EmitInput = {
  [T in EventType]: {
    type: T;
    payload: EventPayload<T>;
    occurred_at?: string;
    version?: string;
  };
}[EventType];

// Builds one event and appends it to the local log. event_id is a fresh UUID,
// occurred_at is now and version comes from config, unless the caller gives
// them. Without a config (not initialised) the version falls back to the one
// init registers by default, so the log works offline and before init. Throws
// a ZodError when the event does not match the taxonomy and writes nothing.
// Nothing here signs or sends. That is sync.
export async function emit(
  input: EmitInput,
  p: Paths = paths(),
): Promise<Event> {
  const version =
    input.version ?? (await readConfig(p))?.version ?? DEFAULT_AGENT_VERSION;
  const event = Event.parse({
    event_id: randomUUID(),
    type: input.type,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    version,
    payload: input.payload,
  });
  return appendEvent(event, p);
}
