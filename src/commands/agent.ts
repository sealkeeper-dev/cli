// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  AgentName,
  type AgentResponse,
  RenameAgentRequest,
} from '@vouched-dev/schema';
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { handleOf, profileUrl, writeConfig } from '../config.js';
import { stdout, wantsJson } from '../output.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  type TasksDeps,
} from '../tasks.js';
import { NAME_RULES } from './init.js';

// agent talks to the API the same way the task commands do, so it takes the
// same injectable fetch.
export type AgentDeps = TasksDeps;

// The agent's own identity on Vouched. Today that is its name.
export function register(
  parent: Command,
  deps: AgentDeps = defaultTasksDeps,
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

  return agent;
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
      return 'the API refused the rename time, check this machine clock';
    case 'rate_limited':
      return error.retryAfterSec === null
        ? 'too many requests, try again later'
        : `too many requests, try again in ${error.retryAfterSec} seconds`;
    case 'unknown_agent':
      return 'this agent is not registered, run vouched init';
    default:
      return error.message;
  }
}
