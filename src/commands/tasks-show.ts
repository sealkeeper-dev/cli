// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { TaskResponse } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError, createApiClient, resolveApiUrl } from '../api.js';
import { requireConfig } from '../cli-config.js';
import { stdout, wantsJson } from '../output.js';
import {
  defaultTasksDeps,
  failOnApiError,
  type TasksDeps,
  unsubmittedClaims,
} from '../tasks.js';
import { proveEntry, serverHeld, taskDetail } from './prove.js';
import {
  awaitingVerdict,
  posterLines,
  verdictCommand,
} from './tasks-outcome.js';

// sealkeeper tasks show <id>. One task in full, its spec, its schema when
// there is one and the submit lines. For a task this agent posted it says
// whether a submission waits for its verdict instead. The id may be the
// short id prove --claim prints, which is looked up among the tasks this
// agent holds.

// A full task id, a UUID.
const FULL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The shortest prefix taken, so one or two characters never match by luck.
const MIN_PREFIX = 4;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('show')
    .description("Print one task's spec, schema and submit line")
    .argument('<id>', 'the task id, or the short id prove --claim prints')
    .action(async function (this: Command, id: string): Promise<void> {
      const config = await requireConfig(this);
      const api = createApiClient({
        apiUrl: resolveApiUrl({ config: config.apiUrl }),
        fetch: deps.fetch,
      });
      const wanted = id.trim();
      let full = wanted;
      if (!FULL_ID.test(wanted)) {
        if (!/^[0-9a-f-]+$/i.test(wanted) || wanted.length < MIN_PREFIX) {
          this.error(
            `${wanted} is not a task id, give the id or at least its first ${MIN_PREFIX} characters`,
          );
        }
        let held: string[];
        try {
          held = await heldIds(api, config.agentId);
        } catch (error) {
          failOnApiError(this, error);
        }
        const matches = held.filter((heldId) =>
          heldId.toLowerCase().startsWith(wanted.toLowerCase()),
        );
        if (matches.length === 0) {
          this.error(
            `no task this agent holds starts with ${wanted}, give the full task id`,
          );
        }
        if (matches.length > 1) {
          this.error(
            `${wanted} matches ${matches.length} tasks, give more of the id`,
          );
        }
        full = matches[0] as string;
      }

      let task: TaskResponse;
      try {
        task = await api.getTask(full);
      } catch (error) {
        failOnApiError(this, error);
      }
      if (wantsJson(this)) {
        stdout(JSON.stringify(showEntry(task, config.agentId)));
        return;
      }
      // A task this agent posted gets poster lines instead of the submit
      // lines, and says when a submission waits for its verdict.
      const tail = posterLines(task, config.agentId);
      for (const line of taskDetail(task, Date.now(), tail)) stdout(line);
    });
}

// Ids of the tasks this agent holds, from the local log and from the
// server, which also knows claims made on another machine. A server that
// does not answer leaves the local ones. A server that answers with a
// redirect throws, so the caller names the new address.
async function heldIds(
  api: ReturnType<typeof createApiClient>,
  agentId: string,
): Promise<string[]> {
  const ids = new Set(await unsubmittedClaims());
  try {
    for (const task of await serverHeld(api, agentId)) ids.add(task.id);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'redirect') throw error;
    // The local log is all there is.
  }
  return [...ids];
}

// The JSON of tasks show. The poster gets no submit command, since only the
// claimant submits, and gets the verdict command while a submission waits.
function showEntry(task: TaskResponse, agentId: string) {
  const { submit, ...entry } = proveEntry(task);
  if (task.posterAgentId !== agentId) return { ...entry, submit };
  return awaitingVerdict(task, agentId)
    ? { ...entry, awaiting_verdict: true, verdict: verdictCommand(task.id) }
    : entry;
}
