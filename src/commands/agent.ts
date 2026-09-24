// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import {
  AgentName,
  type AgentResponse,
  DeleteAgentRequest,
  RenameAgentRequest,
  Version,
} from '@sealkeeper/schema';
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
import { refusal } from '../refusal.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  type TasksDeps,
} from '../tasks.js';
import { changeVersion, inheritLine } from '../version-change.js';
import { NAME_RULES, VERSION_RULES } from './init.js';

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

// The agent's own identity on SealKeeper. Its name and its version.
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
    .command('version <version>')
    .description(
      'Move this agent to a new version on SealKeeper, which starts its record on that version',
    )
    .action(async function (this: Command, version: string): Promise<void> {
      // Checked before the key is loaded or anything is signed, the same
      // rule registration uses.
      if (!Version.safeParse(version).success) {
        this.error(`invalid agent version, ${VERSION_RULES}`);
      }
      const { config, signer, api } = await openTaskSession(this, deps);

      let change: Awaited<ReturnType<typeof changeVersion>>;
      try {
        // The version SealKeeper has now, which is what moves. The local
        // config can differ from it.
        const { version: previous } = await api.getAgent(config.agentId);
        change = await changeVersion({
          api,
          signer,
          config,
          previous,
          version,
        });
      } catch (error) {
        if (error instanceof ApiError) this.error(refusal(error));
        throw error;
      }

      const { previous, next } = change;
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            agentId: config.agentId,
            previousVersion: previous,
            version: next,
            changed: previous !== next,
          }),
        );
        return;
      }
      if (previous === next) {
        // SealKeeper was already there. config.json may still have named
        // another version, and changeVersion has set it, so say so.
        stdout(
          config.version === next
            ? `already on version ${next}, nothing changed`
            : `SealKeeper is already on version ${next}, set config.json from ${config.version} to ${next}`,
        );
        return;
      }
      printFields([
        ['old version', previous],
        ['new version', next],
      ]);
      stdout(inheritLine(previous, next));
    });

  agent
    .command('delete')
    .description(
      'Delete this agent on SealKeeper and its key and files on this machine',
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
        ['on SealKeeper', DELETE_ON_SERVER],
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
            `nothing deleted. There is no terminal to ask, so run sealkeeper agent delete --yes to delete ${handle}`,
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
          `${handle} was already gone from SealKeeper, removed the files on this machine`,
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

// Everything under the SealKeeper home that belongs to this agent. The home
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
