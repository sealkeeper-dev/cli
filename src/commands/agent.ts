// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import {
  AgentName,
  type AgentResponse,
  DeleteAgentRequest,
  RenameAgentRequest,
} from '@vouched-dev/schema';
import type { Command } from 'commander';
import { type ApiClient, ApiError } from '../api.js';
import { type Input, streamInput } from '../ask.js';
import {
  handleOf,
  type Paths,
  paths,
  profileUrl,
  writeConfig,
} from '../config.js';
import { stderr, stdout, wantsJson } from '../output.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  type TasksDeps,
} from '../tasks.js';
import { NAME_RULES } from './init.js';

// agent talks to the API the same way the task commands do, so it takes the
// same injectable fetch. delete asks on stdin, which tests replace.
export type AgentDeps = TasksDeps & { stdin?: () => Input };

const defaultAgentDeps: AgentDeps = {
  ...defaultTasksDeps,
  stdin: () => streamInput(process.stdin),
};

// What agent delete removes, as it prints them before asking.
export const DELETE_ON_SERVER =
  'the agent, its events, the tasks it posted, its claims, its scores and its SEAL';
export const DELETE_ON_MACHINE =
  'the key, config.json, the log, the SEAL cache and the well-known cache';

// The agent's own identity on Vouched. Today that is its name.
export function register(
  parent: Command,
  deps: AgentDeps = defaultAgentDeps,
): Command {
  const agent = parent.command('agent').description('Manage this agent');

  agent
    .command('rename <new-name>')
    .description('Rename this agent, which changes its handle')
    .action(async function (this: Command, newName: string): Promise<void> {
      // Checked before the key is loaded or anything is signed, so a bad
      // name never reaches the network.
      if (!AgentName.safeParse(newName).success) {
        this.error(`invalid agent name ${newName}, use ${NAME_RULES}`);
      }
      const { config, signer, api } = await openTaskSession(this, deps);

      // issuedAt is signed with the name, so the API can refuse an old
      // envelope sent again.
      const request = RenameAgentRequest.parse({
        name: newName,
        issuedAt: new Date().toISOString(),
      });
      let renamed: AgentResponse;
      try {
        renamed = await api.renameAgent(
          config.agentId,
          await signer.sign(request),
        );
      } catch (error) {
        if (error instanceof ApiError) this.error(refusal(error));
        throw error;
      }

      const updated = await writeConfig({
        ...config,
        name: renamed.name,
        operatorLogin: renamed.operator.login,
      });
      const handle = renamed.handle ?? handleOf(updated);
      const url = profileUrl(updated);
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({ agentId: updated.agentId, handle, profileUrl: url }),
        );
        return;
      }
      printFields([
        ['handle', handle],
        ['profile', url],
      ]);
    });

  agent
    .command('delete')
    .description(
      'Delete this agent on Vouched and its key and files on this machine',
    )
    .option('--yes', 'delete without asking, for scripts')
    .action(async function (
      this: Command,
      options: { yes?: boolean },
    ): Promise<void> {
      const { config, signer, api } = await openTaskSession(this, deps);
      const json = wantsJson(this);
      const p = paths();
      const handle = handleOf(config);

      // With --json stdout carries only the result, so the summary goes to
      // stderr.
      const print = json ? stderr : stdout;
      const fields: [string, string][] = [
        ['handle', handle],
        ['profile', profileUrl(config)],
        ['on Vouched', DELETE_ON_SERVER],
        ['on this machine', `${DELETE_ON_MACHINE}, in ${p.home}`],
      ];
      const width = Math.max(...fields.map(([key]) => key.length));
      for (const [key, value] of fields) {
        print(`${key.padEnd(width)}  ${value}`);
      }

      if (options.yes !== true) {
        const input = (deps.stdin ?? noInput)();
        if (!input.isTTY) {
          this.error(
            `nothing deleted. There is no terminal to ask, so run vouched agent delete --yes to delete ${handle}`,
          );
        }
        process.stderr.write(`Delete ${handle}? Type the name to confirm: `);
        const answer = (await input.readLine())?.trim() ?? '';
        if (answer !== config.name) {
          this.error(`nothing deleted, the name did not match ${config.name}`);
        }
      }

      // issuedAt is signed, so a captured envelope stops working after the
      // API's window.
      const request = DeleteAgentRequest.parse({
        issuedAt: new Date().toISOString(),
      });
      let result: 'deleted' | 'gone';
      try {
        result = await api.deleteAgent(
          config.agentId,
          await signer.sign(request),
        );
      } catch (error) {
        if (error instanceof ApiError) this.error(refusal(error));
        throw error;
      }
      // A 404 from an API without this route would read as gone too. Only an
      // agent the API no longer knows is gone, so the key is never deleted
      // while the agent is still registered.
      if (
        result === 'gone' &&
        (await stillRegistered(this, api, config.agentId))
      ) {
        this.error(
          'the API did not delete the agent and it is still registered, nothing deleted',
        );
      }

      await removeLocal(p);
      if (json) {
        stdout(JSON.stringify({ handle, deleted: true }));
        return;
      }
      if (result === 'gone') {
        stdout(
          `${handle} was already gone from Vouched, removed the files on this machine`,
        );
      }
      stdout(`deleted ${handle}`);
    });

  return agent;
}

function noInput(): Input {
  return { isTTY: false, readLine: async () => null };
}

// True when a read of the agent succeeds, false on 404. Any other failure
// ends the command with the files in place.
async function stillRegistered(
  cmd: Command,
  api: ApiClient,
  agentId: string,
): Promise<boolean> {
  try {
    await api.getAgent(agentId);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    if (error instanceof ApiError) cmd.error(refusal(error));
    throw error;
  }
}

// Everything under the Vouched home that belongs to this agent. The home
// directory itself stays. config.json goes last, so a run cut short leaves
// a config that still names the agent.
async function removeLocal(p: Paths): Promise<void> {
  for (const target of [
    p.credential,
    p.wellKnown,
    p.score,
    p.cursor,
    p.sessions,
    p.log,
    p.key,
    p.config,
  ]) {
    await rm(target, { recursive: true, force: true });
  }
}

// One line per refusal. The API message is the fallback for codes this
// version does not know.
function refusal(error: ApiError): string {
  switch (error.code) {
    // The API's message names the handle and a free name, as in
    // carelmeyer/claude-code is taken, try claude-code-2.
    case 'name_taken':
      return error.message;
    case 'stale_rename':
      return 'a newer rename of this agent is already stored';
    case 'issued_at_out_of_window':
      return 'the API refused the request time, check this machine clock';
    case 'rate_limited':
      return error.retryAfterSec === null
        ? 'too many requests, try again later'
        : `too many requests, try again in ${error.retryAfterSec} seconds`;
    case 'unknown_agent':
      return 'this agent is not registered, run vouched init';
    case 'forbidden':
      return 'the API refused, the key on this machine is not this agent';
    default:
      return error.message;
  }
}
