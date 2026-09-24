// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  AgentName,
  type RegisterAgentRequest,
  toAgentName,
  Version,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError, createApiClient, resolveApiUrl } from '../api.js';
import { type Input, isYes, streamInput } from '../ask.js';
import {
  installProveCommand,
  proveCommandPath,
  removeOldProveCommand,
} from '../claude-code-command.js';
import {
  claudeConfigDir,
  hasHooks,
  hasOldPackageHooks,
  hookCommand,
  installHooks,
  invocationOf,
  isNpxCopy,
  SettingsError,
  settingsPath,
} from '../claude-code-settings.js';
import {
  Config,
  ConfigError,
  DEFAULT_AGENT_VERSION,
  handleOf,
  paths,
  profileUrl as profileUrlOf,
  readConfig,
  writeConfig,
} from '../config.js';
import {
  DeviceFlowError,
  deviceFlow,
  githubClientId,
  MISSING_CLIENT_ID,
  type Sleep,
  sleep,
} from '../github-device.js';
import {
  createKey,
  KeyError,
  loadKey,
  loadSigner,
  signEnvelope,
} from '../identity.js';
import { stderr, stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import { describeTaxonomy } from '../taxonomy.js';
import {
  changeVersion,
  inheritLine,
  type VersionChange,
} from '../version-change.js';
import {
  commandLine,
  hooksLines,
  INSTALL_COMMAND,
  oldCommandLine,
} from './adapter.js';
import { printIdentity } from './whoami.js';

export const ALREADY_INITIALISED = 'already initialised';
export const NOTHING_SENT =
  'No events have been sent yet. Run sealkeeper sync to review them and send.';
export const CONSENT =
  'By continuing you accept https://sealkeeper.run/terms and https://sealkeeper.run/privacy.';
export { DEFAULT_AGENT_VERSION } from '../config.js';

export const HOOKS_QUESTION = 'Install the Claude Code hooks now? [Y/n] ';
// Asked on a repeat init when the version on this machine is not the one
// SealKeeper has. No is the default, since a new version starts a new record.
export const versionQuestion = (server: string, local: string): string =>
  `SealKeeper has this agent on version ${server} and this machine on ${local}. Move SealKeeper to ${local}? [y/N] `;
export const NEXT_PROVE =
  'Run sealkeeper prove to earn your first verified tasks';
export const NEXT_WHAT_IS_SHARED =
  'Run sealkeeper what-is-shared to see exactly what leaves this machine';
export const NEXT_HOOKS = `Run ${INSTALL_COMMAND} to record your Claude Code sessions`;
export const NEXT_NPX = `Hooks point at this npx copy. For a stable path run npm i -g sealkeeper and then ${INSTALL_COMMAND}.`;

// fetch and sleep are injectable so tests can drive GitHub and the API
// without a network or real waits. stdin answers the hooks question, which is
// never asked without it. claudeDir is the Claude Code config dir and
// hookCommand the command the hooks run, both defaulting to what sealkeeper
// adapter claude-code install uses. isNpx says whether this CLI runs from
// the npx cache.
export type InitDeps = {
  fetch: typeof fetch;
  sleep: Sleep;
  stdin?: () => Input;
  claudeDir?: () => string;
  // The directory whose .claude/settings.json holds project scope hooks.
  cwd?: () => string;
  hookCommand?: () => string;
  isNpx?: () => boolean;
};

const defaultInitDeps: InitDeps = {
  fetch: (...args) => fetch(...args),
  sleep,
  stdin: () => streamInput(process.stdin),
  claudeDir: () => claudeConfigDir(),
  cwd: () => process.cwd(),
  hookCommand: () => hookCommand(),
  isNpx: () => isNpxCopy(),
};

type InitOptions = {
  name?: string;
  version: string;
  apiUrl?: string;
  force?: boolean;
};

export const VERSION_RULES = 'use 1 to 32 characters';

export const NAME_RULES =
  'lowercase letters, digits and single hyphens, 2 to 39 characters, starting and ending with a letter or digit';

// One line per API error code the operator can act on. Anything else falls
// back to the code and the message the API sent.
const API_MESSAGES: Record<string, (message: string) => string> = {
  account_too_new: (m) =>
    `registration refused, your GitHub account is too new (${m})`,
  operator_cap_reached: (m) =>
    `registration refused, your GitHub account has reached its agent limit (${m})`,
  conflict: () =>
    'this key is already registered by another operator, run sealkeeper init --force to create a new key',
  // The API's message names the handle and a free name, as in
  // carelmeyer/claude-code is taken, try claude-code-2.
  name_taken: (m) => m,
  invalid_signature: () =>
    'the API rejected the registration signature, check the key file or run sealkeeper init --force',
  github_token_rejected: () =>
    'the API could not verify your GitHub login, run sealkeeper init again',
  network_error: (m) => m,
  bad_response: (m) => m,
};

function apiErrorMessage(error: ApiError): string {
  const known = API_MESSAGES[error.code];
  return known
    ? known(error.message)
    : `registration failed with ${error.code}, ${error.message}`;
}

export function register(
  parent: Command,
  deps: InitDeps = defaultInitDeps,
): Command {
  return parent
    .command('init')
    .description('Create a keypair, register via GitHub, write config')
    .option('--name <name>', 'agent name (default: current directory name)')
    .option('--version <version>', 'agent version', DEFAULT_AGENT_VERSION)
    .option('--api-url <url>', 'SealKeeper API base URL')
    .option('--force', 'regenerate the key and register again')
    .action(async function (this: Command, options: InitOptions) {
      try {
        await init(this, options, deps);
      } catch (error) {
        if (
          error instanceof ApiError ||
          error instanceof DeviceFlowError ||
          error instanceof KeyError ||
          error instanceof ConfigError
        ) {
          this.error(
            error instanceof ApiError ? apiErrorMessage(error) : error.message,
          );
        }
        throw error;
      }
    });
}

async function init(
  cmd: Command,
  options: InitOptions,
  deps: InitDeps,
): Promise<void> {
  const json = wantsJson(cmd);
  const p = paths();

  // Without --force an existing config ends the command here. With --force it
  // is read only for its apiUrl, so a re-register goes to the same API. A
  // broken config is no reason to block --force, so it counts as none.
  let previous: Config | null = null;
  if (options.force) {
    previous = await readConfig(p).catch((error: unknown) => {
      if (error instanceof ConfigError) return null;
      throw error;
    });
  } else {
    const existing = await readConfig(p);
    if (existing !== null) {
      if (!json) stdout(ALREADY_INITIALISED);
      printIdentity(existing, json);
      if (json) return;
      await offerVersionMove(existing, deps);
      // Registered already, but the hooks may be missing, the bare form an
      // older version wrote, or pointing at a path that moved. Offer them the
      // way a fresh init does, so npx sealkeeper init is always enough.
      const hooks = await offerHooks(deps, true);
      if (hooks === 'installed' || hooks === 'not-installed') {
        stdout('');
        for (const line of nextSteps(hooks, deps)) stdout(line);
      }
      return;
    }
  }

  const clientId = githubClientId();
  if (clientId === null) cmd.error(MISSING_CLIENT_ID);

  // An explicit --name must already be a valid name. The directory name is
  // only a default, so it is made into one.
  const name =
    options.name ?? toAgentName(basename(process.cwd())) ?? undefined;
  if (name === undefined) {
    cmd.error(
      `the directory name does not make an agent name, pass --name with ${NAME_RULES}`,
    );
  }
  if (!AgentName.safeParse(name).success) {
    cmd.error(`invalid agent name ${name}, use ${NAME_RULES}`);
  }
  if (!Version.safeParse(options.version).success) {
    cmd.error('agent version must be 1 to 32 characters');
  }
  const apiUrl = resolveApiUrl({
    flag: options.apiUrl,
    config: previous?.apiUrl,
  });
  if (!Config.shape.apiUrl.safeParse(apiUrl).success) {
    cmd.error(`invalid API URL ${apiUrl}, expected an http or https URL`);
  }

  // With --force the old config describes the old key, so it goes as soon as
  // the new key exists. A failed registration then leaves a key and no
  // config, and a plain init picks up from there.
  let agentId: string;
  if (options.force) {
    agentId = (await createKey({ force: true }, p)).agentId;
    await rm(p.config, { force: true });
  } else {
    agentId = ((await loadKey(p)) ?? (await createKey({}, p))).agentId;
  }

  // On stderr with the device flow prompts, so --json output stays one object.
  stderr(CONSENT);
  const githubToken = await deviceFlow({
    clientId,
    fetch: deps.fetch,
    sleep: deps.sleep,
  });

  const request: RegisterAgentRequest = {
    publicKey: agentId,
    githubToken,
    name,
    version: options.version,
  };
  const envelope = await signEnvelope(request, p);
  const api = createApiClient({ apiUrl, fetch: deps.fetch });
  const agent = await api.registerAgent(envelope);
  if (agent.id !== agentId) {
    throw new ApiError(
      0,
      'bad_response',
      'the API registered a different agent id than the local key',
    );
  }

  const config = await writeConfig(
    {
      agentId: agent.id,
      operatorLogin: agent.operator.login,
      name: agent.name,
      version: agent.version,
      apiUrl: api.apiUrl,
      registeredAt: agent.createdAt,
    },
    p,
  );

  const handle = handleOf(config);
  const profileUrl = profileUrlOf(config);
  // On stderr, so --json output stays one object.
  const printShared = () => {
    stderr('');
    stderr(describeTaxonomy());
    stderr('');
    stderr(NOTHING_SENT);
  };
  if (json) {
    const hooks = await offerHooks(deps, false);
    stdout(
      JSON.stringify({
        agentId: config.agentId,
        handle,
        operatorLogin: config.operatorLogin,
        name: config.name,
        version: config.version,
        apiUrl: config.apiUrl,
        profileUrl,
        nextSteps: nextSteps(hooks, deps),
      }),
    );
    printShared();
    return;
  }
  stdout(`registered agent ${config.agentId}`);
  stdout(`operator ${config.operatorLogin}`);
  stdout(`handle ${handle}`);
  stdout(`profile ${profileUrl}`);
  printShared();
  const hooks = await offerHooks(deps, true);
  stdout('');
  for (const line of nextSteps(hooks, deps)) stdout(line);
}

// Short, so a repeat init never hangs on a slow network for a question it
// can skip.
const VERSION_CHECK_TIMEOUT_MS = 10_000;

// On a repeat init where a person can answer, compares the version in
// config.json, which the card and every event carry, with the one SealKeeper
// has, and offers to move SealKeeper to it. Nothing is asked without a
// terminal, and an API that cannot be reached skips the question quietly,
// since registration is already done.
async function offerVersionMove(config: Config, deps: InitDeps): Promise<void> {
  const input = deps.stdin?.();
  if (input === undefined || !input.isTTY) return;
  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  });
  let server: string;
  try {
    server = (await api.getAgent(config.agentId)).version;
  } catch (error) {
    if (error instanceof ApiError) return;
    throw error;
  }
  if (server === config.version) return;
  process.stderr.write(`\n${versionQuestion(server, config.version)}`);
  if (!isYes(await input.readLine())) {
    stdout(
      `SealKeeper stays on ${server}. Run sealkeeper agent version ${config.version} to move it later.`,
    );
    return;
  }
  // Registration is done and the move is optional, so a refusal or a
  // missing key ends only the move. init goes on to the hooks offer.
  let change: VersionChange;
  try {
    change = await changeVersion({
      api,
      signer: await loadSigner(),
      config,
      previous: server,
      version: config.version,
    });
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof KeyError)) {
      throw error;
    }
    const reason = error instanceof ApiError ? refusal(error) : error.message;
    stderr(
      `version not moved, ${reason}. Run sealkeeper agent version ${config.version} to try again.`,
    );
    return;
  }
  stdout(`moved SealKeeper from version ${change.previous} to ${change.next}`);
  stdout(inheritLine(change.previous, change.next));
}

// What init did about the Claude Code hooks. none means there is no Claude
// Code config dir, so hooks are not mentioned at all. present means ours
// were there already, installed that this run wrote them.
type HooksResult = 'none' | 'present' | 'installed' | 'not-installed';

// Asks whether to install the Claude Code hooks when Claude Code is set up
// here and a person can answer. Yes, or just Enter, runs the same install as
// sealkeeper adapter claude-code install, the /sealkeeper-prove command
// included.
// Hooks already there, in the user or the project settings, count as
// installed and nothing is asked.
async function offerHooks(deps: InitDeps, ask: boolean): Promise<HooksResult> {
  const dir = (deps.claudeDir ?? claudeConfigDir)();
  if (!(await isDirectory(dir))) return 'none';
  const dirs = { home: '', cwd: (deps.cwd ?? process.cwd)(), claudeDir: dir };
  const user = settingsPath('user', dirs);
  const project = settingsPath('project', dirs);
  const hook = (deps.hookCommand ?? hookCommand)();
  // Hooks the old vouched package wrote are replaced in place, in the user
  // and in the project settings, without asking again, since the operator
  // agreed to them when they went in. Each scope's slash command moves too.
  let replaced = false;
  for (const file of new Set([user, project])) {
    if (!(await hasOldPackageHooks(file))) continue;
    if (await installAt(file, hook)) replaced = true;
  }
  if (replaced) return 'installed';
  // Only hooks that run this very command count. An older form, bare or
  // through npx, or a path that moved, is offered the install again, which
  // rewrites our entries in place.
  if ((await hasHooks(user, hook)) || (await hasHooks(project, hook))) {
    return 'present';
  }
  // Hooks of ours in the project settings, in an older form, are rewritten
  // there, so a second set never lands in the user settings beside them.
  const file = (await hasHooks(project)) ? project : user;

  const input = deps.stdin?.();
  if (!ask || input === undefined || !input.isTTY) return 'not-installed';
  process.stderr.write(`\n${HOOKS_QUESTION}`);
  if (!isYesByDefault(await input.readLine())) return 'not-installed';
  return (await installAt(file, hook)) ? 'installed' : 'not-installed';
}

// The same install as sealkeeper adapter claude-code install into one
// settings file, the hooks and then the /sealkeeper-prove command, with the
// old /vouched-prove command removed once the new one is there. false when
// the settings file could not be changed.
async function installAt(file: string, hook: string): Promise<boolean> {
  try {
    const result = await installHooks(file, hook);
    for (const line of hooksLines(result, file)) stdout(line);
  } catch (error) {
    // Registration already worked, so a settings file we will not touch
    // only means the hooks wait for a later install.
    if (error instanceof SettingsError) {
      stderr(error.message);
      return false;
    }
    throw error;
  }
  const commandPath = proveCommandPath(file);
  try {
    const command = await installProveCommand(commandPath, invocationOf(hook));
    stdout(commandLine(command, commandPath));
    if (command !== 'kept') {
      const old = await removeOldProveCommand(file);
      if (old !== null) stdout(oldCommandLine(old));
    }
  } catch (error) {
    // The hooks are in, so this is only a warning.
    if (!(error instanceof SettingsError)) throw error;
    stderr(error.message);
  }
  return true;
}

// Enter or y or yes is yes. n, no or a closed input is no, and so is
// anything else, so a typo never edits a settings file.
export function isYesByDefault(answer: string | null): boolean {
  if (answer === null) return false;
  return /^(y(es)?)?$/i.test(answer.trim());
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// The hooks this run wrote point at the running script, which under npx
// lives in a cache that can be cleared, so that gets a line of its own.
function nextSteps(hooks: HooksResult, deps: InitDeps): string[] {
  const steps = [NEXT_PROVE, NEXT_WHAT_IS_SHARED];
  if (hooks === 'not-installed') steps.push(NEXT_HOOKS);
  if (hooks === 'installed' && (deps.isNpx ?? isNpxCopy)()) {
    steps.push(NEXT_NPX);
  }
  return steps;
}
