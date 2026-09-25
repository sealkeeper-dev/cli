// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  AgentName,
  type Level,
  type RegisterAgentRequest,
  toAgentName,
  Version,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError, createApiClient, resolveApiUrl } from '../api.js';
import { type Input, isYes, readYesNo, streamInput } from '../ask.js';
import {
  installProveCommand,
  proveCommandPath,
  refreshProveCommand,
} from '../claude-code-command.js';
import {
  claudeConfigDir,
  hasHooks,
  hookCommand,
  installHooks,
  invocationOf,
  isNpxCopy,
  refuseOutsideProject,
  SettingsError,
  settingsPath,
} from '../claude-code-settings.js';
import {
  Config,
  ConfigError,
  DEFAULT_AGENT_VERSION,
  handleOf,
  INSECURE_API_URL,
  paths,
  profileUrl as profileUrlOf,
  readConfig,
  writeConfig,
} from '../config.js';
import { isDirectory, tildePath } from '../files.js';
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
import { cli } from '../invocation.js';
import { atBronzeOrAbove, readLiveAgent } from '../live-agent.js';
import {
  promptStyled,
  stderr,
  stderrStyled,
  stdout,
  stdoutStyled,
  wantsJson,
} from '../output.js';
import { refusal } from '../refusal.js';
import { createStyle, indent, type Style, type Styled } from '../style.js';
import { describeTaxonomy } from '../taxonomy.js';
import { VERSION } from '../version.js';
import {
  changeVersion,
  inheritLine,
  type VersionChange,
} from '../version-change.js';
import { commandLine, hooksLines, INSTALL_COMMAND } from './adapter.js';
import { printIdentity } from './whoami.js';

// NOTHING_SENT and CONSENT are what a --json run prints on stderr, next to
// the full taxonomy block. The human output says less, see below.
export const NOTHING_SENT = `No events have been sent yet. Run ${cli('sync')} to review them and send.`;
export const CONSENT =
  'By continuing you accept https://sealkeeper.run/terms and https://sealkeeper.run/privacy.';

// The human output. The welcome box, then the terms, the sign in, the
// registration, what leaves this machine, the Claude Code hooks and what to
// do next.
export const TAGLINE = [
  'Prove your agent. A signed, portable track record',
  'anyone can check offline.',
];
export const TERMS =
  'By continuing you accept sealkeeper.run/terms and sealkeeper.run/privacy.';
export const SHARED_SUMMARY = [
  'Tool names, durations, outcomes, session boundaries and token counts,',
  'each signed with your key. Never prompts, tool inputs or outputs,',
  'file contents or model output.',
];
// Said on its own, since a repeat run has no summary above it.
export const HOOKS_INTRO =
  'The hooks record each session and tool call, names and timings only, into a local log.';
export const HOOKS_QUESTION = 'Install them now? [Y/n] ';
// Asked again after an answer that is not yes or no, up to this many
// questions in all.
export const HOOKS_MAX_ASKS = 3;
export const HOOKS_NOT_INSTALLED = `Hooks not installed. Run ${INSTALL_COMMAND} to install them later.`;
export const ADAPTERS_URL = 'https://sealkeeper.run/docs/init#adapters';
// What bronze asks for. The source is SCORING.levels.bronze in
// apps/api/src/scoring/config.ts, and a test there fails when it moves, so
// this copy is updated with it. @sealkeeper/schema carries no level
// thresholds yet, so the CLI keeps the two it prints here, in one place.
export const BRONZE = { verifiedTasks: 25, historyDays: 3 } as const;

// Asked on a repeat init when the version on this machine is not the one
// SealKeeper has. No is the default, since a new version starts a new record.
export const versionQuestion = (server: string, local: string): string =>
  `SealKeeper has this agent on version ${server} and this machine on ${local}. Move SealKeeper to ${local}? [y/N] `;
// The next steps a --json run lists in nextSteps.
export const NEXT_PROVE = `Run ${cli('prove')} to earn your first verified tasks`;
export const NEXT_WHAT_IS_SHARED = `Run ${cli('what-is-shared')} to see exactly what leaves this machine`;
export const NEXT_HOOKS = `Run ${INSTALL_COMMAND} to record your Claude Code sessions`;
export const NEXT_NPX =
  'Hooks point at this npx copy. For a stable path run npm i -g sealkeeper and then sealkeeper adapter claude-code install.';

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
    `this key is already registered by another operator, run ${cli('init --force')} to create a new key`,
  // The API's message names the handle and a free name, as in
  // alice/claude-code is taken, try claude-code-2.
  name_taken: (m) => m,
  invalid_signature: () =>
    `the API rejected the registration signature, check the key file or run ${cli('init --force')}`,
  github_token_rejected: () =>
    `the API could not verify your GitHub login, run ${cli('init')} again`,
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

// The two streams init writes to, each styled or not on its own, decided
// once per run. null for a --json run, which prints what it always has.
type Ui = { out: Style; err: Style };

// One line of the human output, two spaces in, or an empty line. Only
// Styled lines, so every part of them was escaped when it was built.
const say = (line?: Styled) => stdoutStyled(indent(line));
const note = (line?: Styled) => stderrStyled(indent(line));

// The welcome box, on stderr with the terms and the sign in.
function welcome(ui: Ui): void {
  const s = ui.err;
  note();
  for (const text of s.box([
    s.line`${s.gold('◉')} ${s.bold('SealKeeper')} ${s.dim(`v${VERSION}`)}`,
    '',
    ...TAGLINE,
  ])) {
    note(text);
  }
}

// The profile URL is built from the handle in the config file, so it is
// escaped like any other text from outside.
function profileLine(s: Style, url: string): Styled {
  return s.line`  ${s.dim('Profile')}  ${s.cyan(url)}`;
}

async function init(
  cmd: Command,
  options: InitOptions,
  deps: InitDeps,
): Promise<void> {
  const json = wantsJson(cmd);
  const p = paths();
  const ui: Ui | null = json
    ? null
    : {
        out: createStyle(process.stdout),
        err: createStyle(process.stderr),
      };

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
      if (ui === null) {
        printIdentity(existing, true);
        return;
      }
      const s = ui.out;
      welcome(ui);
      say();
      say(s.line`${s.tick()} Already set up as ${s.bold(handleOf(existing))}`);
      say(profileLine(s, profileUrlOf(existing)));
      await offerVersionMove(existing, deps, ui);
      // Registered already, but the hooks may be missing or pointing at a
      // path that moved. Offer them the way a fresh init does, so npx
      // sealkeeper init is always enough.
      const hooks = await offerHooks(deps, ui);
      printNext(ui.out, hooks, await readNextState(existing, deps));
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
    cmd.error(`invalid API URL ${apiUrl}, ${INSECURE_API_URL}`);
  }

  // With --force the old config describes the old key, so it goes as soon as
  // the new key exists. A failed registration then leaves a key and no
  // config, and a plain init picks up from there. The old key is kept in a
  // backup file, named below.
  let agentId: string;
  let backup: string | undefined;
  if (options.force) {
    const created = await createKey({ force: true }, p);
    agentId = created.agentId;
    backup = created.backup;
    if (backup !== undefined && ui === null) {
      stderr(`the old key is kept at ${backup}`);
    }
    await rm(p.config, { force: true });
  } else {
    agentId = ((await loadKey(p)) ?? (await createKey({}, p))).agentId;
  }

  // On stderr with the device flow prompts, so --json output stays one object.
  let prompt: ((url: string, code: string) => void) | undefined;
  if (ui === null) {
    stderr(CONSENT);
  } else {
    const s = ui.err;
    welcome(ui);
    if (backup !== undefined) {
      note();
      note(s.line`${s.tick()} The old key is kept at ${tildePath(backup)}`);
    }
    note();
    note(s.dim(TERMS));
    note();
    note(s.bold('Sign in with GitHub'));
    // The URL and the code come from GitHub, so the style functions escape
    // them like any other text from outside.
    prompt = (url, code) =>
      note(s.line`Open ${s.cyan(url)} and enter ${s.bold(s.gold(code))}`);
  }
  const githubToken = await deviceFlow({
    clientId,
    fetch: deps.fetch,
    sleep: deps.sleep,
    prompt,
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
  if (ui === null) {
    const hooks = await offerHooks(deps, null);
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
    // On stderr, so --json output stays one object.
    stderr('');
    stderr(describeTaxonomy());
    stderr('');
    stderr(NOTHING_SENT);
    return;
  }
  // The login comes back with the registration, so the sign in is confirmed
  // here, beside it.
  const s = ui.out;
  say(s.line`${s.tick()} Signed in as ${s.bold(config.operatorLogin)}`);
  say();
  say(s.line`${s.tick()} Registered ${s.bold(handle)}`);
  say(profileLine(s, profileUrl));
  printShared(ui.err);
  const hooks = await offerHooks(deps, ui);
  printNext(ui.out, hooks, await readNextState(config, deps));
}

// A short account of what leaves this machine, on stderr where the full
// taxonomy block used to be. what-is-shared prints the full list.
function printShared(s: Style): void {
  note();
  note(s.bold('What leaves this machine'));
  for (const text of SHARED_SUMMARY) note(s.line`${text}`);
  note(s.line`${s.dim('Full list')}  ${cli('what-is-shared')}`);
}

// What Next reads, the same numbers status shows. The verified count and
// the level come live from the API. autoSync comes from the config.
export type NextState = {
  verifiedTasks: number;
  level: Level | null;
  autoSync: boolean;
};

// null when the API does not answer or sends no count, so Next falls back
// to the generic steps rather than failing init.
async function readNextState(
  config: Config,
  deps: InitDeps,
): Promise<NextState | null> {
  const live = await readLiveAgent(config, deps.fetch);
  const verifiedTasks = live?.counts?.verifiedTasks;
  if (verifiedTasks === undefined) return null;
  return {
    verifiedTasks,
    level: live?.level ?? null,
    autoSync: config.autoSync === true,
  };
}

// The numbered next steps and where the other adapters are documented.
// With the state known, only the steps that apply, in order. Hooks to
// install, then earning verified tasks the way this machine can, then sync
// when auto sync is off, then where the agent stands. Without it, the
// generic steps.
function printNext(
  s: Style,
  hooks: HooksResult,
  state: NextState | null,
): void {
  const steps =
    state === null ? genericSteps(s, hooks) : stateSteps(s, hooks, state);
  say();
  say(s.bold('Next'));
  steps.forEach((step, i) => {
    say(s.line`${s.gold(i + 1)}  ${step}`);
  });
  say();
  say(s.line`${s.dim('Mastra or OpenClaw')}  ${s.cyan(ADAPTERS_URL)}`);
  say();
}

export function bronzeLine(verifiedTasks: number, level: Level | null): string {
  return atBronzeOrAbove(level)
    ? `Level ${level}, with ${verifiedTasks} verified tasks`
    : `${verifiedTasks} of ${BRONZE.verifiedTasks} verified tasks toward bronze`;
}

function stateSteps(s: Style, hooks: HooksResult, state: NextState): Styled[] {
  const earn =
    state.verifiedTasks > 0 ? 'verified tasks' : 'your first verified tasks';
  const prove = s.bold('/sealkeeper-prove');
  const steps: Styled[] = [];
  if (hooks === 'not-installed') {
    steps.push(
      s.line`Install the Claude Code hooks with ${s.dim(INSTALL_COMMAND)}`,
      s.line`Then in Claude Code, run ${prove} to earn ${earn}`,
    );
  } else if (hooks === 'installed' || hooks === 'present') {
    steps.push(s.line`In Claude Code, run ${prove} to earn ${earn}`);
  } else {
    steps.push(
      s.line`Have your agent run ${s.bold(cli('prove --json'))} to earn ${earn}`,
    );
  }
  if (!state.autoSync) {
    steps.push(
      s.line`Review and send what was recorded   ${s.dim(cli('sync'))}`,
    );
  }
  steps.push(s.line`${bronzeLine(state.verifiedTasks, state.level)}`);
  return steps;
}

// With the hooks in, the first step is the slash command in Claude Code,
// otherwise prove from the shell.
function genericSteps(s: Style, hooks: HooksResult): Styled[] {
  const hooksIn = hooks === 'installed' || hooks === 'present';
  const steps = [
    hooksIn
      ? s.line`In Claude Code, run ${s.bold('/sealkeeper-prove')} to earn your first verified tasks`
      : s.line`Earn your first verified tasks with ${s.bold(cli('prove'))}`,
    s.line`Review and send what was recorded   ${s.dim(cli('sync'))}`,
    s.line`Bronze needs ${BRONZE.verifiedTasks} verified tasks over ${BRONZE.historyDays} days. Your badge updates on its own.`,
  ];
  if (hooks === 'not-installed') {
    steps.push(
      s.line`Record your Claude Code sessions with ${s.dim(INSTALL_COMMAND)}`,
    );
  }
  return steps;
}

// Short, so a repeat init never hangs on a slow network for a question it
// can skip.
const VERSION_CHECK_TIMEOUT_MS = 10_000;

// On a repeat init where a person can answer, compares the version in
// config.json, which the card and every event carry, with the one SealKeeper
// has, and offers to move SealKeeper to it. Nothing is asked without a
// terminal, and an API that cannot be reached skips the question quietly,
// since registration is already done.
async function offerVersionMove(
  config: Config,
  deps: InitDeps,
  ui: Ui,
): Promise<void> {
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
  const e = ui.err;
  const o = ui.out;
  // The server version comes from the API, so it is escaped with the rest.
  promptStyled(e.line`\n${indent(versionQuestion(server, config.version))}`);
  if (!isYes(await input.readLine())) {
    say(
      o.line`SealKeeper stays on ${server}. Run ${cli(`agent version ${config.version}`)} to move it later.`,
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
    note(
      e.line`version not moved, ${reason}. Run ${cli(`agent version ${config.version}`)} to try again.`,
    );
    return;
  }
  say(
    o.line`${o.tick()} moved SealKeeper from version ${change.previous} to ${change.next}`,
  );
  say(o.line`${inheritLine(change.previous, change.next)}`);
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
// installed and nothing is asked. A --json run, ui null, never asks and
// prints the install lines the way adapter claude-code install does.
async function offerHooks(deps: InitDeps, ui: Ui | null): Promise<HooksResult> {
  const dir = (deps.claudeDir ?? claudeConfigDir)();
  if (!(await isDirectory(dir))) return 'none';
  if (ui !== null) {
    note();
    note(ui.err.bold('Claude Code'));
    note(ui.err.line`${HOOKS_INTRO}`);
  }
  const dirs = { home: '', cwd: (deps.cwd ?? process.cwd)(), claudeDir: dir };
  const user = settingsPath('user', dirs);
  const project = settingsPath('project', dirs);
  const hook = (deps.hookCommand ?? hookCommand)();
  // Only hooks that run this very command count. A path that moved is
  // offered the install again, which rewrites our entries in place.
  const inUser = await hasHooks(user, hook);
  if (inUser || (await hasHooks(project, hook))) {
    if (ui !== null) {
      const s = ui.out;
      say(s.line`${s.tick()} Hooks in ${tildePath(inUser ? user : project)}`);
    }
    await refreshCommand(inUser ? user : project, !inUser, dirs.cwd, hook, ui);
    return 'present';
  }
  // Hooks of ours in the project settings, with an older path, are
  // rewritten there, so a second set never lands in the user settings
  // beside them.
  const file = (await hasHooks(project)) ? project : user;

  const input = deps.stdin?.();
  if (ui === null || input === undefined || !input.isTTY) {
    return 'not-installed';
  }
  if ((await askHooks(input, ui)) !== 'yes') {
    say(ui.out.line`${HOOKS_NOT_INSTALLED}`);
    return 'not-installed';
  }
  if (file === project) {
    try {
      await refuseOutsideProject(dirs.cwd, [file, proveCommandPath(file)]);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      note(ui.err.line`${error.message}`);
      return 'not-installed';
    }
  }
  return (await installAt(file, hook, ui)) ? 'installed' : 'not-installed';
}

// The hooks question. Escape sequences such as arrow keys are taken out of
// the answer. An answer that is still not yes or no asks again, up to
// HOOKS_MAX_ASKS questions, and then counts as no.
async function askHooks(input: Input, ui: Ui): Promise<'yes' | 'no'> {
  const e = ui.err;
  const [question = ''] = HOOKS_QUESTION.split(' [Y/n]');
  for (let asked = 0; asked < HOOKS_MAX_ASKS; asked++) {
    const again = asked === 0 ? '' : 'Please answer y or n. ';
    promptStyled(indent(e.line`${again}${question} ${e.dim('[Y/n]')} `));
    const answer = readYesNo(await input.readLine(), 'yes');
    if (answer !== 'unclear') return answer;
  }
  return 'no';
}

// Brings /sealkeeper-prove up to date on a run that finds the hooks
// already in, so a newer CLI's command reaches Claude Code without a
// reinstall. Only a file of ours that differs is written. Anything that
// goes wrong leaves the file as it was.
async function refreshCommand(
  file: string,
  project: boolean,
  cwd: string,
  hook: string,
  ui: Ui | null,
): Promise<void> {
  const commandPath = proveCommandPath(file);
  try {
    if (project) await refuseOutsideProject(cwd, [commandPath]);
    if (await refreshProveCommand(commandPath, invocationOf(hook))) {
      if (ui !== null) {
        const s = ui.out;
        say(
          s.line`${s.tick()} /sealkeeper-prove updated in ${tildePath(dirname(commandPath))}`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
  }
}

// The same install as sealkeeper adapter claude-code install into one
// settings file, the hooks and then the /sealkeeper-prove command. false
// when the settings file could not be changed. A --json run, ui null,
// prints the lines adapter claude-code install prints.
async function installAt(
  file: string,
  hook: string,
  ui: Ui | null,
): Promise<boolean> {
  const warn = (message: string) =>
    ui === null ? stderr(message) : note(ui.err.line`${message}`);
  try {
    const result = await installHooks(file, hook);
    if (ui === null) {
      for (const text of hooksLines(result, file)) stdout(text);
    } else {
      const s = ui.out;
      say(s.line`${s.tick()} Hooks in ${tildePath(file)}`);
    }
  } catch (error) {
    // Registration already worked, so a settings file we will not touch
    // only means the hooks wait for a later install.
    if (error instanceof SettingsError) {
      warn(error.message);
      return false;
    }
    throw error;
  }
  const commandPath = proveCommandPath(file);
  try {
    const command = await installProveCommand(commandPath, invocationOf(hook));
    if (ui === null) {
      stdout(commandLine(command, commandPath));
    } else {
      const s = ui.out;
      say(
        command === 'kept'
          ? s.line`Left ${tildePath(commandPath)} alone, SealKeeper did not write it`
          : s.line`${s.tick()} /sealkeeper-prove in ${tildePath(dirname(commandPath))}`,
      );
    }
  } catch (error) {
    // The hooks are in, so this is only a warning.
    if (!(error instanceof SettingsError)) throw error;
    warn(error.message);
  }
  return true;
}

// Enter or y or yes is yes, after escape sequences such as arrow keys are
// taken out. n, no or a closed input is no, and so is anything else, so a
// typo never edits a settings file. The hooks question asks again on
// anything else, see askHooks.
export function isYesByDefault(answer: string | null): boolean {
  return readYesNo(answer, 'yes') === 'yes';
}

// The nextSteps of a --json run. The hooks this run wrote point at the
// running script, which under npx lives in a cache that can be cleared, so
// that gets a line of its own.
function nextSteps(hooks: HooksResult, deps: InitDeps): string[] {
  const steps = [NEXT_PROVE, NEXT_WHAT_IS_SHARED];
  if (hooks === 'not-installed') steps.push(NEXT_HOOKS);
  if (hooks === 'installed' && (deps.isNpx ?? isNpxCopy)()) {
    steps.push(NEXT_NPX);
  }
  return steps;
}
