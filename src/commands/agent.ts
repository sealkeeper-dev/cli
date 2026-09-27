// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentName,
  type AgentResponse,
  DeleteAgentRequest,
  RenameAgentRequest,
  RUNTIME_LABELS,
  RUNTIMES,
  Version,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import {
  changeRuntime,
  parseRuntime,
  RUNTIME_RULES,
  recordRuntimeAsked,
} from '../agent-runtime.js';
import { type ApiClient, ApiError } from '../api.js';
import { type Input, streamInput } from '../ask.js';
import { LOCK_FILE, STAMP_FILE } from '../background-sync.js';
import {
  boundFolders,
  ConfigError,
  handleOf,
  handleUrl,
  listMachineAgents,
  type MachineAgent,
  type Paths,
  paths,
  profileUrl,
  releaseHome,
  writeConfig,
} from '../config.js';
import { tildePath } from '../files.js';
import { deleteKey } from '../identity.js';
import { cli } from '../invocation.js';
import { readOperatorSlug, refreshOperatorSlug } from '../operator-slug.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import { routinePaths } from '../routine.js';
import { SchedulerError } from '../routine-scheduler.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  type TasksDeps,
} from '../tasks.js';
import { changeVersion, inheritLine } from '../version-change.js';
import { NAME_RULES, VERSION_RULES } from './init.js';
import {
  defaultRoutineDeps,
  installedJob,
  jobLines,
  type RoutineDeps,
  uninstallJob,
} from './routine.js';

// agent talks to the API the same way the task commands do, so it takes the
// same injectable fetch. delete asks on stdin, which tests replace.
export type AgentDeps = TasksDeps & { stdin?: () => Input };

const defaultAgentDeps: AgentDeps = {
  ...defaultTasksDeps,
  stdin: () => streamInput(process.stdin),
};

// What agent delete removes, as it prints them before asking.
const DELETE_ON_SERVER =
  'the agent, its events, the tasks it posted, its claims, its scores and its SEAL';
const DELETE_ON_MACHINE =
  'the key and any copies of it, config.json, the log, the routine settings and log, the SEAL cache and the well-known cache';

// The agent's own identity on SealKeeper. Its name and its version.
export function register(
  parent: Command,
  deps: AgentDeps = defaultAgentDeps,
  routineDeps: RoutineDeps = defaultRoutineDeps,
): Command {
  const agent = parent.command('agent').description('Manage this agent');

  agent
    .command('list')
    .description(
      'List the agents on this machine and the folders that use them',
    )
    .action(async function (this: Command): Promise<void> {
      let agents: MachineAgent[];
      try {
        agents = await listMachineAgents();
      } catch (error) {
        if (error instanceof ConfigError) this.error(error.message);
        throw error;
      }
      const listed = await Promise.all(agents.map(listedAgent));
      if (wantsJson(this)) {
        stdout(JSON.stringify({ agents: listed }));
        return;
      }
      if (listed.length === 0) {
        stdout(`no agents on this machine, run ${cli('init')}`);
        return;
      }
      listed.forEach((entry, i) => {
        if (i > 0) stdout('');
        for (const line of agentLines(entry)) stdout(line);
      });
    });

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
        renamed = await api.patchAgent(
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
      // The slug from the answer is stored, and the one stored before
      // stands in for an API that sends none.
      const slug = await refreshOperatorSlug(updated.agentId, renamed);
      const handle = renamed.handle ?? handleOf(updated, slug);
      const url = handleUrl(handle);
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
    .command('runtime <runtime>')
    .description(`Say what this agent runs in, one of ${RUNTIMES.join(', ')}`)
    .action(async function (this: Command, value: string): Promise<void> {
      // Checked before the key is loaded or anything is signed.
      const runtime = parseRuntime(value);
      if (runtime === null) {
        this.error(`invalid runtime ${value}, ${RUNTIME_RULES}`);
      }
      const { config, signer, api } = await openTaskSession(this, deps);
      let changed: AgentResponse;
      try {
        changed = await changeRuntime({
          api,
          signer,
          agentId: config.agentId,
          runtime,
        });
      } catch (error) {
        if (error instanceof ApiError) this.error(refusal(error));
        throw error;
      }
      // Set by hand counts as the one time question answered.
      await recordRuntimeAsked(config.agentId);
      const now = changed.runtime ?? runtime;
      if (wantsJson(this)) {
        stdout(JSON.stringify({ agentId: config.agentId, runtime: now }));
        return;
      }
      stdout(`runtime set to ${RUNTIME_LABELS[now]}`);
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
      const slug = await readOperatorSlug(config.agentId, p);
      const handle = handleOf(config, slug);

      // With --json stdout carries only the result, so the summary goes to
      // stderr.
      const print = json ? stderr : stdout;
      const fields: [string, string][] = [
        ['handle', handle],
        ['profile', profileUrl(config, slug)],
        ['on SealKeeper', DELETE_ON_SERVER],
        ['on this machine', `${DELETE_ON_MACHINE}, in ${p.home}`],
      ];
      // A daily routine job would run for an agent that is gone, so it goes
      // too, and is named before the question.
      const job = await installedJob(p);
      if (job !== null) {
        fields.push([
          'routine job',
          `the daily ${job.scheduler} job ${job.job}`,
        ]);
      }
      // Folders init bound to this agent stop using it. Only named here, a
      // map that does not read is left for the removal to report.
      const bound = await boundFolders(p.home).catch(() => []);
      if (bound.length > 0) {
        fields.push(['folders', bound.map((f) => tildePath(f)).join(', ')]);
      }
      const width = Math.max(...fields.map(([key]) => key.length));
      for (const [key, value] of fields) {
        print(`${key.padEnd(width)}  ${value}`);
      }

      if (options.yes !== true) {
        const input = (deps.stdin ?? noInput)();
        if (!input.isTTY) {
          this.error(
            `nothing deleted. There is no terminal to ask, so run ${cli('agent delete --yes')} to delete ${handle}`,
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

      let routineJob: { removed: string[]; kept: string[] } | null = null;
      let routineJobError: string | null = null;
      try {
        routineJob = await uninstallJob(routineDeps, p);
      } catch (error) {
        if (!(error instanceof SchedulerError)) throw error;
        routineJobError = error.message;
        stderr(
          `the daily routine job could not be removed: ${error.message}. Run ${cli('routine remove')} to try again`,
        );
      }
      const keyCopies = await removeLocal(p);
      const folders = await releaseFolders(p);
      if (routineJob !== null && !json) {
        for (const line of jobLines(routineJob)) stdout(line);
      }
      if (json) {
        stdout(
          JSON.stringify({
            handle,
            deleted: true,
            keyCopies,
            routineJob,
            folders,
            ...(routineJobError === null ? {} : { routineJobError }),
          }),
        );
        return;
      }
      for (const line of unboundLines(folders)) stdout(line);
      if (result === 'gone') {
        stdout(
          `${handle} was already gone from SealKeeper, removed the files on this machine`,
        );
      }
      for (const file of keyCopies) stdout(`deleted the key copy at ${file}`);
      stdout(`deleted ${handle}`);
    });

  return agent;
}

type ListedAgent = {
  home: string;
  name: string | null;
  agentId: string | null;
  handle: string | null;
  isDefault: boolean;
  folders: string[];
};

// One agent as agent list shows it. The handle is built offline, from the
// operator slug the API last sent, as status does.
async function listedAgent(agent: MachineAgent): Promise<ListedAgent> {
  const { config } = agent;
  const slug =
    config === null
      ? null
      : await readOperatorSlug(config.agentId, paths(agent.home));
  return {
    home: agent.home,
    name: config?.name ?? null,
    agentId: config?.agentId ?? null,
    handle: config === null ? null : handleOf(config, slug),
    isDefault: agent.isDefault,
    folders: agent.folders,
  };
}

function agentLines(agent: ListedAgent): string[] {
  const head = [
    agent.handle ?? `no config in ${tildePath(agent.home)}`,
    ...(agent.isDefault ? ['default'] : []),
  ].join('  ');
  const folders =
    agent.folders.length > 0
      ? agent.folders.map((folder) => `  ${tildePath(folder)}`)
      : ['  no folder uses it'];
  return [head, ...folders];
}

// Takes this agent's folders out of the map and its named home off the
// disk, once its files are gone. The agent is deleted by then, so a map
// that does not read only warns.
export async function releaseFolders(p: Paths): Promise<string[]> {
  try {
    return await releaseHome(p.home);
  } catch (error) {
    stderr(
      `the folders that used this agent could not be unbound: ${(error as Error).message.split('\n')[0]}`,
    );
    return [];
  }
}

export function unboundLines(folders: string[]): string[] {
  return folders.map(
    (folder) => `${tildePath(folder)} no longer uses this agent`,
  );
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
// directory itself stays here, and releaseFolders removes a named one once
// it is empty. config.json goes last, so a run cut short leaves
// a config that still names the agent. Returns the full paths of the key
// copies (key.<time>.bak, key.<id>.tmp) it deleted with the key.
async function removeLocal(p: Paths): Promise<string[]> {
  for (const target of [
    p.credential,
    p.wellKnown,
    p.score,
    p.inbox,
    p.postPrompt,
    p.goal,
    p.nudge,
    p.routine,
    p.runtimeQuestion,
    p.operatorSlug,
    routinePaths(p).log,
    routinePaths(p).lock,
    routinePaths(p).claimLock,
    routinePaths(p).out,
    routinePaths(p).work,
    p.cursor,
    p.cursorOffset,
    // What the automatic sync leaves, so a named home ends up empty and
    // goes with it.
    join(p.home, STAMP_FILE),
    join(p.home, LOCK_FILE),
    p.sessions,
    p.log,
  ]) {
    await rm(target, { recursive: true, force: true });
  }
  const copies = await deleteKey(p);
  await rm(p.config, { force: true });
  return copies;
}
