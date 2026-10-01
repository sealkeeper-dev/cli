// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  AgentName,
  isRuntimeName,
  LEVEL_THRESHOLDS,
  type Level,
  type RegisterAgentRequest,
  RUNTIME_LABELS,
  RUNTIMES,
  type Runtime,
  toAgentName,
  Version,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import {
  askRuntime,
  detectRuntime,
  offerRuntime,
  parseRuntime,
  RUNTIME_RULES,
  recordRuntimeAsked,
} from '../agent-runtime.js';
import {
  API_URL_ENV,
  ApiError,
  createApiClient,
  resolveApiUrl,
} from '../api.js';
import {
  cleanAnswer,
  type Input,
  isYes,
  readYesNo,
  streamInput,
} from '../ask.js';
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
  removeRetiredHooks,
  SettingsError,
  settingsPath,
  sharedProjectSettingsPath,
  uninstallHooks,
} from '../claude-code-settings.js';
import { installSkill, skillPath } from '../claude-code-skill.js';
import {
  bindFolder,
  boundHome,
  Config,
  ConfigError,
  DEFAULT_AGENT_VERSION,
  DEFAULT_API_URL,
  handleOf,
  handleUrl,
  INSECURE_API_URL,
  listMachineAgents,
  type MachineAgent,
  namedHome,
  type Paths,
  paths,
  profileUrl as profileUrlOf,
  type RoutineConfig,
  readConfig,
  readNudge,
  readRoutineConfig,
  sealkeeperRoot,
  writeConfig,
} from '../config.js';
import { readEnv } from '../env.js';
import { exists, isDirectory, tildePath } from '../files.js';
import { repoName } from '../git-remote.js';
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
import {
  atBronzeOrAbove,
  type LiveAgent,
  operatorAgentCount,
  readLiveAgent,
} from '../live-agent.js';
import { cursorToEnd } from '../log.js';
import { setNudge } from '../nudge.js';
import {
  currentOperatorSlug,
  readOperatorSlug,
  refreshOperatorSlug,
} from '../operator-slug.js';
import {
  promptStyled,
  stderr,
  stderrStyled,
  stdout,
  stdoutStyled,
  wantsJson,
} from '../output.js';
import { refusal } from '../refusal.js';
import { SchedulerError } from '../routine-scheduler.js';
import { SCORE_TIMEOUT_MS } from '../score.js';
import {
  createStyle,
  INDENT,
  indent,
  type Style,
  type Styled,
} from '../style.js';
import { describeTaxonomy } from '../taxonomy.js';
import { VERSION } from '../version.js';
import {
  changeVersion,
  inheritLine,
  type VersionChange,
} from '../version-change.js';
import {
  askNudge,
  commandLine,
  hooksLines,
  INSTALL_COMMAND,
  skillLine,
} from './adapter.js';
import { readGameStatus } from './game.js';
import {
  askYes,
  BLOCK_LABEL,
  BLOCK_TITLE,
  blockHeadTail,
  checkLaterLine,
  DEFAULT_TIME,
  defaultRoutineDeps,
  FIRST_RUN_QUESTION,
  finishInstall,
  firstRun,
  INSTALL_QUESTION,
  installedLine,
  laterLine,
  type PreparedInstall,
  prepareInstall,
  type RoutineDeps,
  refreshCopy,
  routineRows,
} from './routine.js';
import { identityOf, printIdentity } from './whoami.js';

// NOTHING_SENT is what a --json run prints on stderr, next to the full
// taxonomy block. The human output says less, see below.
export const NOTHING_SENT = `No events have been sent yet. Run ${cli('sync')} to review them and send.`;
// Said right before the GitHub device code, in every form, and on stderr
// with --json. Full https links, so terminals make them clickable. The API
// records which versions were accepted, the CLI never sends them (VOU-121).
export const CONSENT =
  'Registering this agent means you accept the terms (https://sealkeeper.run/terms) and the privacy policy (https://sealkeeper.run/privacy).';

// Said by init --force when the log held events the old key never sent.
export function leftBehindLine(n: number): string {
  return `${n} unsent event${n === 1 ? '' : 's'} of the old key ${n === 1 ? 'stays' : 'stay'} in the log and ${n === 1 ? 'is' : 'are'} never sent under the new key.`;
}

// Said on stderr before the device flow when the API is not the SealKeeper
// one, since the GitHub token goes to it (cli-core-3).
export function otherApiLine(apiUrl: string): string {
  return `This sign in sends your GitHub token to the API at ${new URL(apiUrl).origin}, not ${DEFAULT_API_URL}.`;
}

// The human output. The welcome box, then the name, the runtime and the
// game, the terms and the sign in, the registration, what leaves this
// machine, the Claude Code hooks and what to do next.
export const TAGLINE = [
  'Prove your agent. A signed, portable track record',
  'anyone can check offline.',
];
export const SHARED_SUMMARY = [
  'Session boundaries, task outcomes, durations and token counts,',
  'each signed with your key. Never prompts, tool inputs or outputs,',
  'file contents or model output.',
];
// Said on its own, since a repeat run has no summary above it.
export const HOOKS_INTRO =
  'The hooks record each session, its start and end, into a local log.';
export const HOOKS_QUESTION = 'Install them now? [Y/n] ';
// Asked again after an answer that is not yes or no, up to this many
// questions in all.
export const HOOKS_MAX_ASKS = 3;
export const NUDGE_INTRO =
  'The hooks can also tell your agent where it stands when a session starts, from a local cache, without waiting on the network.';
export const NUDGE_NOT_ON = `Session nudge off. Run ${cli('config nudge on')} to turn it on later.`;
export const HOOKS_NOT_INSTALLED = `Hooks not installed. Run ${INSTALL_COMMAND} to install them later.`;
// Said on stderr when the hooks went in without a question, since Claude
// Code runs this init with no terminal (RS-8).
export const HOOKS_BY_CLAUDE =
  'The Claude Code hooks went in without a question, since Claude Code is running this init.';
// The first Next step then, for Claude to run on the user's yes.
export const ROUTINE_STEP = 'Set up the daily routine';
export const NEXT_ROUTINE = `${ROUTINE_STEP} with ${cli('routine install --yes')}, only after the user's clear yes`;
// Said when stdin closes at a question, so init ends rather than waits
// (D6).
export const INPUT_CLOSED = `init stopped, stdin closed before an answer. There is no terminal to ask, so run ${cli('init')} again in a terminal.`;
// The daily routine, offered after the hooks when claude is on PATH, as
// one block routine install shows too, with yes as the default (RS-1). The
// limits are on the screen before the question.
export const ROUTINE_NOT_INSTALLED = `Routine not installed. Run ${cli('routine install')} to set it up later.`;
export const ROUTINE_TIME_LINE = `Change the time with ${cli('routine install --time HH:MM')}.`;
export const routinePresentLine = (time: string): string =>
  `Daily routine at ${time}`;
// Said on a repeat init when the job was installed by a CLI from before
// RS-2, which pointed it at the script that ran install.
export const ROUTINE_EARLIER_LINE = `An earlier CLI installed this job. Run ${cli('routine install')} to give it a copy of the CLI that npm cannot clear.`;
export const ADAPTERS_URL = 'https://sealkeeper.run/docs/init#adapters';
// What bronze asks for, from the thresholds the scoring job applies.
export const BRONZE = LEVEL_THRESHOLDS.bronze;

// Asked on a repeat init when the version on this machine is not the one
// SealKeeper has. No is the default, since a new version starts a new record.
export const versionQuestion = (server: string, local: string): string =>
  `SealKeeper has this agent on version ${server} and this machine on ${local}. Move SealKeeper to ${local}? [y/N] `;
// The game layer, duels and weekly challenges (D-GAME-2). Asked in a
// terminal after the runtime, before the sign in, with yes as the default.
// Without a terminal, or when Claude Code runs init, nobody is asked and
// the default goes. The answer goes with the registration, and the line
// after it says what SealKeeper has and how to change it.
export const GAME_QUESTION = 'Play duels and weekly challenges? [Y/n] ';
export const gameLine = (on: boolean): string =>
  on
    ? `on, turn it off with ${cli('game off')}`
    : `off, turn it on with ${cli('game on')}`;
// The next steps a --json run lists in nextSteps.
export const NEXT_PROVE = `Run ${cli('prove')} to earn your first verified tasks`;
export const NEXT_WHAT_IS_SHARED = `Run ${cli('what-is-shared')} to see exactly what leaves this machine`;
export const NEXT_HOOKS = `Run ${INSTALL_COMMAND} to record your Claude Code sessions`;
// Every level needs tasks the agent posted that other operators' agents
// completed (POST-3), which exist only when it posts them. Said once there
// are verified tasks, and as what comes after them before that.
export const NEXT_POST = `After the first verified tasks, post one for other agents with ${cli('tasks post')}`;
export const POST_STEP = `Post a task for other agents with ${cli('tasks post')}, every level needs posted tasks other agents completed`;
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
  // The directory whose .claude/settings.json holds project scope hooks,
  // and whose git remote and name suggest the agent's name.
  cwd?: () => string;
  hookCommand?: () => string;
  isNpx?: () => boolean;
  // The repository name of the origin remote in a directory, or null.
  // Defaults to asking git.
  repoName?: (cwd: string) => Promise<string | null>;
  // The environment runtime detection reads. Defaults to process.env.
  env?: () => NodeJS.ProcessEnv;
};

const defaultInitDeps: InitDeps = {
  fetch: (...args) => fetch(...args),
  sleep,
  stdin: () => streamInput(process.stdin),
  claudeDir: () => claudeConfigDir(),
  cwd: () => process.cwd(),
  hookCommand: () => hookCommand(),
  isNpx: () => isNpxCopy(),
  repoName,
  env: () => process.env,
};

type InitOptions = {
  name?: string;
  version: string;
  apiUrl?: string;
  force?: boolean;
  runtime?: string;
};

export const VERSION_RULES = 'use 1 to 32 characters';

export const NAME_RULES =
  'lowercase letters, digits and single hyphens, 2 to 39 characters, starting and ending with a letter or digit';

// The name question. The suggestion, from the git remote or the directory
// name, is the default an empty answer takes.
export const nameQuestion = (suggestion: string | null): string =>
  suggestion === null ? 'Agent name' : `Agent name [${suggestion}]`;
// Asked again after an answer that is not a valid name, up to this many
// questions in all.
export const NAME_MAX_ASKS = 3;
export const NO_NAME = `neither the git remote nor the directory name makes an agent name, pass --name with ${NAME_RULES}`;
// Said once, in the question, for a name on the soft list of runtime names.
// Keeping it is allowed.
export const runtimeNameNudge = (name: string): string =>
  `${name} names what the agent runs in, so many agents share it. A name of its own reads better. Type one, or press Enter to keep ${name}.`;
// Said instead, on one line, when nobody is asked, with --name or without
// a terminal.
export const runtimeNameLine = (name: string): string =>
  `${name} names what the agent runs in, so many agents share it. Kept. Run ${cli('agent rename <new-name>')} to give it a name of its own.`;
// Said before the name question when this folder uses no agent yet and the
// machine has some, so the operator can pick one or register another. The
// agents are named by handle, and past MACHINE_AGENTS_SHOWN only counted.
export const MACHINE_AGENTS_SHOWN = 5;
export function machineAgentsLine(handles: string[]): string {
  const shown = handles.slice(0, MACHINE_AGENTS_SHOWN);
  const more = handles.length - shown.length;
  const list =
    more > 0
      ? `${shown.join(', ')} and ${more} more`
      : shown.length === 1
        ? shown[0]
        : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  return handles.length === 1
    ? `This machine has one agent, ${list}. Type its name to use it in this folder, or a new name to register another.`
    : `This machine has ${handles.length} agents, ${list}. Type a name to use one in this folder, or a new name to register another.`;
}
// Said when this run binds the folder to an agent, on the first
// registration, a new agent or one picked by name.
export const folderLine = (folder: string, handle: string): string =>
  `${folder} now uses ${handle}`;
// A new name whose home holds a config already, most likely an agent
// renamed since, which still owns the directory.
export const homeTaken = (home: string): string =>
  `${home} already holds an agent, which may have been renamed since, see ${cli('agent list')} or choose another name`;
// Where an operator changes the slug, on the web only.
export const ACCOUNT_URL = 'https://sealkeeper.run/me/account';
export const operatorLine = (slug: string): string =>
  `${slug}, change it at ${ACCOUNT_URL}`;

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
  wrong_audience: (m) =>
    `the API answers as another address, check the API URL, ${m}`,
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
  routineDeps: RoutineDeps = defaultRoutineDeps,
): Command {
  return parent
    .command('init')
    .description('Create a keypair, register via GitHub, write config')
    .option(
      '--name <name>',
      'agent name (default: the git repository name, then the directory name)',
    )
    .option(
      '--runtime <runtime>',
      `what the agent runs in, one of ${RUNTIMES.join(', ')}`,
    )
    .option('--version <version>', 'agent version', DEFAULT_AGENT_VERSION)
    .option('--api-url <url>', 'SealKeeper API base URL')
    .option('--force', 'regenerate the key and register again')
    .action(async function (this: Command, options: InitOptions) {
      try {
        await init(this, options, stopOnClose(deps), routineDeps);
      } catch (error) {
        if (error instanceof InputClosed) this.error(INPUT_CLOSED);
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
    s.line`${s.mark()} ${s.bold('SealKeeper')} ${s.dim(`v${VERSION}`)}`,
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

// The home this run acts in, and whether it binds a folder to it.
type Target = {
  p: Paths;
  // The folder to bind to p.home, as cwd gave it. A registration binds it
  // only once it worked, so a failed sign in leaves no binding. null when
  // this run binds nothing.
  folder: string | null;
  // The name the choice asked for, so the registration does not ask again.
  name?: string;
  // Whether the choice printed the welcome box already.
  welcomed: boolean;
};

// Picks the home before anything is created, since the key goes there.
// SEALKEEPER_HOME wins and reads no map. A folder bound already, or below
// one, uses that agent. An unbound folder on a machine with no agent gets
// the root, as before the folder map, and is bound to it once registered.
// An unbound folder on a machine with agents is the choice, see choose.
async function chooseHome(
  cmd: Command,
  options: InitOptions,
  deps: InitDeps,
  ui: Ui | null,
): Promise<Target> {
  if (readEnv('SEALKEEPER_HOME') !== undefined) {
    return { p: paths(), folder: null, welcomed: false };
  }
  const cwd = (deps.cwd ?? process.cwd)();
  const root = sealkeeperRoot();
  const bound = boundHome(cwd, root);
  if (bound !== null) return { p: paths(bound), folder: null, welcomed: false };
  const agents = (await listMachineAgents(root)).filter(
    (agent): agent is MachineAgent & { config: Config } =>
      agent.config !== null,
  );
  if (agents.length === 0) {
    return { p: paths(root), folder: cwd, welcomed: false };
  }
  return choose(cmd, options, deps, ui, cwd, root, agents);
}

// The choice, for an unbound folder on a machine with agents. The name
// comes from --name, from the question, or without a terminal from the
// suggestion. A name one of the agents has binds the folder to it, which
// is how a worktree of a project picks up the project's agent on Enter. A
// new name registers another agent in its own home under agents/.
async function choose(
  cmd: Command,
  options: InitOptions,
  deps: InitDeps,
  ui: Ui | null,
  cwd: string,
  root: string,
  agents: (MachineAgent & { config: Config })[],
): Promise<Target> {
  if (
    options.name !== undefined &&
    !AgentName.safeParse(options.name).success
  ) {
    cmd.error(`invalid agent name ${options.name}, use ${NAME_RULES}`);
  }
  let name = options.name;
  let asked: string | undefined;
  let welcomed = false;
  if (name === undefined) {
    const suggestion = await suggestName(deps);
    const stdin = ui === null ? undefined : deps.stdin?.();
    if (ui !== null && stdin?.isTTY) {
      // Each agent answers to its name and to its handle, since the line
      // before the question names them by handle.
      const known = new Map<string, string>();
      const handles: string[] = [];
      for (const agent of agents) {
        const slug = await readOperatorSlug(
          agent.config.agentId,
          paths(agent.home),
        );
        const handle = handleOf(agent.config, slug);
        handles.push(handle);
        known.set(agent.config.name, agent.config.name);
        known.set(handle, agent.config.name);
      }
      welcome(ui);
      welcomed = true;
      note();
      note(ui.err.line`${machineAgentsLine(handles)}`);
      name = await askName(cmd, stdin, suggestion, ui, known);
      asked = name;
    } else if (suggestion === null) {
      cmd.error(NO_NAME);
    } else {
      name = suggestion;
    }
  }
  const chosen = agents.find((agent) => agent.config.name === name);
  if (chosen !== undefined) {
    return { p: paths(chosen.home), folder: cwd, name: asked, welcomed };
  }
  const home = namedHome(name, root);
  if (await exists(paths(home).config)) cmd.error(homeTaken(tildePath(home)));
  return { p: paths(home), folder: cwd, name: asked, welcomed };
}

async function init(
  cmd: Command,
  options: InitOptions,
  deps: InitDeps,
  routineDeps: RoutineDeps,
): Promise<void> {
  const json = wantsJson(cmd);
  const ui: Ui | null = json
    ? null
    : {
        out: createStyle(process.stdout),
        err: createStyle(process.stderr),
      };
  const target = await chooseHome(cmd, options, deps, ui);
  const p = target.p;

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
      await initRegistered(existing, target, deps, routineDeps, ui);
      return;
    }
  }

  // An explicit --name must already be a valid name. The suggestion, the
  // repository name of the git remote and then the directory name, is only
  // a default, so it is made into one. Nobody to ask and no suggestion ends
  // the command here, before anything is created. terminal is where a
  // person answers, undefined when nobody can.
  const stdin = ui === null ? undefined : deps.stdin?.();
  const terminal = stdin?.isTTY ? stdin : undefined;
  if (
    options.name !== undefined &&
    !AgentName.safeParse(options.name).success
  ) {
    cmd.error(`invalid agent name ${options.name}, use ${NAME_RULES}`);
  }
  const suggestion =
    options.name === undefined && target.name === undefined
      ? await suggestName(deps)
      : null;
  if (
    options.name === undefined &&
    target.name === undefined &&
    suggestion === null &&
    terminal === undefined
  ) {
    cmd.error(NO_NAME);
  }
  let runtime: Runtime | undefined;
  if (options.runtime !== undefined) {
    const parsed = parseRuntime(options.runtime);
    if (parsed === null) {
      cmd.error(`invalid runtime ${options.runtime}, ${RUNTIME_RULES}`);
    }
    runtime = parsed;
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
  // After the checks of what was typed, so a build without the client id
  // still names a bad flag first.
  const clientId = githubClientId();
  if (clientId === null) cmd.error(MISSING_CLIENT_ID);
  // A URL from SEALKEEPER_API_URL alone is used for this run and never
  // saved, so config.json keeps the old URL or the default, and a variable
  // left set in one shell does not bind the agent to that API for good.
  // --api-url is saved.
  const savedApiUrl =
    !options.apiUrl?.trim() && readEnv(API_URL_ENV) !== undefined
      ? previous?.apiUrl
      : apiUrl;

  // With --force the old config describes the old key, so it goes as soon as
  // the new key exists. A failed registration then leaves a key and no
  // config, and a plain init picks up from there. The old key is kept in a
  // backup file, named below.
  // The log may hold events the old key logged and never sent, so the
  // cursor moves past them and the new key never signs them as its own.
  // The same holds for a plain init that makes a key on the spot, as in a
  // home an older logout --delete-key left with the log and no cursor. A
  // key made here never owns events already in the log.
  let agentId: string;
  let backup: string | undefined;
  let leftBehind = 0;
  if (options.force) {
    const created = await createKey({ force: true }, p);
    agentId = created.agentId;
    backup = created.backup;
    leftBehind = await cursorToEnd(p);
    if (ui === null && backup !== undefined) {
      stderr(`the old key is kept at ${backup}`);
    }
    await rm(p.config, { force: true });
  } else {
    const loaded = await loadKey(p);
    if (loaded !== null) {
      agentId = loaded.agentId;
    } else {
      agentId = (await createKey({}, p)).agentId;
      leftBehind = await cursorToEnd(p);
    }
  }
  if (ui === null && leftBehind > 0) stderr(leftBehindLine(leftBehind));

  let prompt: ((url: string, code: string) => void) | undefined;
  if (ui !== null) {
    const s = ui.err;
    if (!target.welcomed) welcome(ui);
    if (backup !== undefined) {
      note();
      note(s.line`${s.tick()} The old key is kept at ${tildePath(backup)}`);
    }
    if (leftBehind > 0) {
      note();
      note(s.line`${leftBehindLine(leftBehind)}`);
    }
  }

  // The name and the runtime, asked where a person can answer, before the
  // sign in. Otherwise the suggestion, and the runtime only from --runtime,
  // since a detected one is only a hint until the operator confirms it.
  let name: string;
  if (target.name !== undefined) {
    name = target.name;
  } else if (
    options.name === undefined &&
    terminal !== undefined &&
    ui !== null
  ) {
    name = await askName(cmd, terminal, suggestion, ui);
  } else {
    name = (options.name ?? suggestion) as string;
    if (isRuntimeName(name)) {
      if (ui === null) stderr(runtimeNameLine(name));
      else note(ui.err.line`${runtimeNameLine(name)}`);
    }
  }
  let askedRuntime = false;
  if (runtime === undefined && terminal !== undefined && ui !== null) {
    const detected = await detectRuntime({
      env: deps.env?.(),
      claudeDir: deps.claudeDir,
      cwd: deps.cwd,
    });
    note();
    runtime = (await askRuntime(terminal, detected, indent)) ?? undefined;
    askedRuntime = true;
  }
  let gameEnabled = true;
  if (terminal !== undefined && ui !== null) {
    note();
    gameEnabled = await askYes(terminal, question(ui, GAME_QUESTION));
  }

  // The terms, right before the device code. On stderr with the device flow
  // prompts, so --json output stays one object. Before them, the API the
  // token goes to when it is not the SealKeeper one.
  const otherApi =
    new URL(apiUrl).origin === DEFAULT_API_URL ? null : otherApiLine(apiUrl);
  if (ui === null) {
    if (otherApi !== null) stderr(otherApi);
    stderr(CONSENT);
  } else {
    const s = ui.err;
    if (otherApi !== null) {
      note();
      note(s.line`${otherApi}`);
    }
    note();
    note(s.dim(CONSENT));
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

  // unknown is what the API stores when runtime is left out, so it is.
  const request: RegisterAgentRequest = {
    publicKey: agentId,
    githubToken,
    name,
    version: options.version,
    ...(runtime === undefined || runtime === 'unknown' ? {} : { runtime }),
    gameEnabled,
  };
  const api = createApiClient({ apiUrl, fetch: deps.fetch });
  const envelope = await signEnvelope(request, api.apiUrl, p);
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
      ...(savedApiUrl === undefined
        ? {}
        : { apiUrl: savedApiUrl.replace(/\/+$/, '') }),
      registeredAt: agent.createdAt,
    },
    p,
  );
  // Only now that the agent is registered, so a failed sign in or a
  // refusal binds nothing.
  const folder =
    target.folder === null ? null : await bindFolder(target.folder, p.home);

  // Asked at init, or set with --runtime, counts as the one time question,
  // whatever the answer.
  if (askedRuntime || options.runtime !== undefined) {
    await recordRuntimeAsked(config.agentId, new Date(), p);
  }

  // The handle is built from the operator slug, which the registration
  // answer leaves out for CLI 0.1.0, so it comes from the agent read. The
  // slug is stored for the commands that build the handle offline. With no
  // answer the one stored for this agent before stands in, from a repeat
  // registration, and the login only when there is none.
  const live = await readLiveAgent(config, deps.fetch);
  const slug = await refreshOperatorSlug(config.agentId, live, p);
  const handle = live?.handle ?? handleOf(config, slug);
  const profileUrl =
    live?.handle === undefined
      ? profileUrlOf(config, slug)
      : handleUrl(live.handle);
  // What the API has, which differs from what was sent when the key was
  // registered already, since a repeat registration changes nothing.
  const registeredRuntime =
    live?.runtime ??
    (runtime === undefined || runtime === 'unknown' ? 'unknown' : runtime);
  if (ui === null) {
    const hooks = await offerHooks(deps, null);
    stdout(
      JSON.stringify({
        agentId: config.agentId,
        handle,
        operatorLogin: config.operatorLogin,
        name: config.name,
        version: config.version,
        runtime: registeredRuntime,
        apiUrl: api.apiUrl,
        profileUrl,
        ...(folder === null ? {} : { folder, home: p.home }),
        nextSteps: nextSteps(
          hooks,
          deps,
          await routineStepFirst(hooks, deps, p),
        ),
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
  if (registeredRuntime !== 'unknown') {
    say(s.line`  ${s.dim('Runtime')}  ${RUNTIME_LABELS[registeredRuntime]}`);
  }
  const game = await registeredGame(api.apiUrl, deps, p, gameEnabled);
  say(s.line`  ${s.dim('Game')}  ${gameLine(game)}`);
  await printOperator(s, config, live, deps);
  if (folder !== null && target.folder !== null) {
    say(s.line`${s.tick()} ${folderLine(tildePath(target.folder), handle)}`);
  }
  printShared(ui.err);
  const hooks = await offerHooks(deps, ui);
  await offerNudge(hooks, deps, ui, p);
  await offerRoutine(hooks, deps, routineDeps, ui, p);
  printNext(
    ui.out,
    hooks,
    nextStateOf(config, live),
    await routineStepFirst(hooks, deps, p),
  );
}

// Whether SealKeeper has the game on for the agent just registered, read
// with the signed status read. A key registered before keeps its switch,
// as it keeps its runtime, so the answer sent may not be what the API has.
// The answer sent when the read fails, with the short timeout of the agent
// read, so a slow API never holds init up.
async function registeredGame(
  apiUrl: string,
  deps: InitDeps,
  p: Paths,
  sent: boolean,
): Promise<boolean> {
  try {
    const api = createApiClient({
      apiUrl,
      fetch: deps.fetch,
      timeoutMs: SCORE_TIMEOUT_MS,
    });
    const signer = await loadSigner(api.apiUrl, p);
    return (await readGameStatus({ signer, api })).enabled;
  } catch {
    return sent;
  }
}

// A run for an agent registered already. When the choice picked it by
// name the folder is bound first. Then who it is, and what a fresh init
// offers, since the hooks may be missing or point at a path that moved, so
// npx sealkeeper init is always enough.
async function initRegistered(
  existing: Config,
  target: Target,
  deps: InitDeps,
  routineDeps: RoutineDeps,
  ui: Ui | null,
): Promise<void> {
  const p = target.p;
  const folder =
    target.folder === null ? null : await bindFolder(target.folder, p.home);
  // One agent read, for the operator slug in the handle, the runtime
  // question and Next. Offline the slug is the one last stored.
  const { slug, live: firstLive } = await currentOperatorSlug(
    existing,
    deps.fetch,
    p,
  );
  if (ui === null) {
    if (folder === null) {
      printIdentity(existing, true, slug);
    } else {
      stdout(
        JSON.stringify({
          ...identityOf(existing, slug),
          folder,
          home: p.home,
        }),
      );
    }
    return;
  }
  const s = ui.out;
  if (!target.welcomed) welcome(ui);
  say();
  const handle = handleOf(existing, slug);
  if (folder !== null && target.folder !== null) {
    say(s.line`${s.tick()} ${folderLine(tildePath(target.folder), handle)}`);
  }
  say(s.line`${s.tick()} Already set up as ${s.bold(handle)}`);
  say(profileLine(s, profileUrlOf(existing, slug)));
  // A moved version has a level of its own, so the agent is read again
  // for Next.
  const live = (await offerVersionMove(existing, deps, ui, p))
    ? await readLiveAgent(existing, deps.fetch)
    : firstLive;
  await offerRuntime({
    config: existing,
    readRuntime: async () => live?.runtime,
    input: deps.stdin?.(),
    fetch: deps.fetch,
    report: runtimeReport(ui),
    layout: indent,
    claudeDir: deps.claudeDir,
    cwd: deps.cwd,
    env: deps.env?.(),
    paths: p,
  });
  const hooks = await offerHooks(deps, ui);
  await offerNudge(hooks, deps, ui, p);
  await offerRoutine(hooks, deps, routineDeps, ui, p);
  printNext(
    ui.out,
    hooks,
    nextStateOf(existing, live),
    await routineStepFirst(hooks, deps, p),
  );
}

// Thrown when stdin closes at a question, caught by the action (D6).
class InputClosed extends Error {
  override name = 'InputClosed';
}

// deps whose stdin throws InputClosed on a closed input, so every question
// init asks, its own and the runtime and nudge questions it borrows, ends
// init with INPUT_CLOSED instead of reading the close as an answer.
function stopOnClose(deps: InitDeps): InitDeps {
  const stdin = deps.stdin;
  if (stdin === undefined) return deps;
  return {
    ...deps,
    stdin: () => {
      const input = stdin();
      return {
        isTTY: input.isTTY,
        readLine: async () => {
          const line = await input.readLine();
          if (line === null) throw new InputClosed();
          return line;
        },
      };
    },
  };
}

// Whether Claude Code runs this init for the user, stdin not a terminal
// and CLAUDECODE set (RS-8).
function claudeDriven(deps: InitDeps, input: Input | undefined): boolean {
  if (input?.isTTY === true) return false;
  return (
    readEnv('CLAUDECODE', (deps.env ?? (() => process.env))()) !== undefined
  );
}

// Whether Next starts with the routine, when Claude Code runs this init,
// the hooks are in and no job is installed yet (RS-8).
async function routineStepFirst(
  hooks: HooksResult,
  deps: InitDeps,
  p: Paths,
): Promise<boolean> {
  if (hooks !== 'installed' && hooks !== 'present') return false;
  if (!claudeDriven(deps, deps.stdin?.())) return false;
  try {
    return (await readRoutineConfig(p)).schedule === undefined;
  } catch {
    return false;
  }
}

// The suggested name. The repository name of the origin remote, then the
// directory name, each made into a valid name, else null.
async function suggestName(deps: InitDeps): Promise<string | null> {
  const cwd = (deps.cwd ?? process.cwd)();
  const repo = await (deps.repoName ?? repoName)(cwd).catch(() => null);
  return (
    (repo === null ? null : toAgentName(repo)) ?? toAgentName(basename(cwd))
  );
}

// The name question, on stderr. Enter takes the suggestion. A name on the
// soft list of runtime names gets the nudge once, and Enter after it keeps
// the name. An answer that is not a valid name asks again, up to
// NAME_MAX_ASKS questions, and then the command ends. A closed input takes
// the suggestion when there is one.
async function askName(
  cmd: Command,
  input: Input,
  suggestion: string | null,
  ui: Ui,
  known: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
  const e = ui.err;
  let fallback = suggestion;
  let nudged = false;
  let again = '';
  note();
  for (let asked = 0; asked < NAME_MAX_ASKS; ) {
    promptStyled(indent(e.line`${again}${nameQuestion(fallback)} `));
    const line = await input.readLine();
    if (line === null) {
      if (fallback === null) break;
      return fallback;
    }
    const answer = cleanAnswer(line) || fallback;
    asked++;
    if (answer === null) {
      again = 'Please type a name. ';
      continue;
    }
    // A name or handle of an agent on this machine, the choice decides.
    const agent = known.get(answer);
    if (agent !== undefined) return agent;
    if (!AgentName.safeParse(answer).success) {
      note(e.line`${answer} is not a valid name, use ${NAME_RULES}.`);
      again = '';
      continue;
    }
    if (isRuntimeName(answer) && !nudged) {
      // Once, and it does not count as a try. Enter keeps the name.
      nudged = true;
      asked--;
      fallback = answer;
      again = '';
      note(e.line`${runtimeNameNudge(answer)}`);
      continue;
    }
    return answer;
  }
  cmd.error(`no agent name, pass --name with ${NAME_RULES}`);
}

// The operator slug, on the first sign up only, with where to change it.
// The slug comes from the agent read, and first means the operator has no
// other agent. Said on the first agent only, so nothing is printed when
// the API does not answer.
async function printOperator(
  s: Style,
  config: Config,
  live: LiveAgent | null,
  deps: InitDeps,
): Promise<void> {
  const slug = live?.operator?.slug;
  if (slug === undefined) return;
  if ((await operatorAgentCount(config, slug, deps.fetch)) !== 1) return;
  say(s.line`  ${s.dim('Operator')}  ${operatorLine(slug)}`);
}

// What init says, as offerRuntime reports it, styled like its other lines.
function runtimeReport(ui: Ui) {
  return {
    ok: (text: string) => say(ui.out.line`${ui.out.tick()} ${text}`),
    info: (text: string) => note(ui.err.line`${text}`),
  };
}

// Asks once whether to add the session nudge, when the hooks that print it
// are in and a person can answer. No is the default and is kept, so a
// repeat init does not ask again. config nudge on|off changes it later.
async function offerNudge(
  hooks: HooksResult,
  deps: InitDeps,
  ui: Ui,
  p: Paths,
): Promise<void> {
  if (hooks !== 'present' && hooks !== 'installed') return;
  if ((await readNudge(p)) !== undefined) return;
  const input = deps.stdin?.();
  if (input === undefined || !input.isTTY) return;
  note(ui.err.line`${NUDGE_INTRO}`);
  const on = await askNudge(input, indent);
  await setNudge(on, p, deps.fetch);
  const s = ui.out;
  say(on ? s.line`${s.tick()} Session nudge on` : s.line`${NUDGE_NOT_ON}`);
}

// Offers the daily routine when Claude Code is set up here, claude is on
// PATH and a person can answer (RS-1). One block and one question, yes by
// default, then the first run, yes by default (RS-3). One with a job
// installed already is named, its copy of the CLI refreshed when its
// version is not this one (RS-2), and nothing is asked. No is not stored,
// so a repeat init asks again the way it asks about the hooks. A machine
// where the routine cannot be installed, no claude on PATH or a scheduler
// that cannot be read, hears nothing, since init has nothing to offer it.
async function offerRoutine(
  hooks: HooksResult,
  deps: InitDeps,
  routineDeps: RoutineDeps,
  ui: Ui,
  p: Paths,
): Promise<void> {
  if (hooks === 'none') return;
  const input = deps.stdin?.();
  if (input === undefined || !input.isTTY) return;
  const e = ui.err;
  const o = ui.out;
  let current: RoutineConfig;
  try {
    current = await readRoutineConfig(p);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    note(e.line`${error.message}`);
    return;
  }
  if (current.schedule !== undefined) {
    say(o.line`${o.tick()} ${routinePresentLine(current.schedule.time)}`);
    if (current.schedule.program === undefined) {
      say(o.line`${o.dim(ROUTINE_EARLIER_LINE)}`);
    } else {
      await refreshCopy(current.schedule, routineDeps, p);
    }
    return;
  }
  let prepared: PreparedInstall | string;
  try {
    prepared = await prepareInstall(routineDeps, DEFAULT_TIME, current);
  } catch (error) {
    if (!(error instanceof SchedulerError)) throw error;
    return;
  }
  if (typeof prepared === 'string') return;
  note();
  note(e.line`${e.bold(BLOCK_TITLE)}   ${blockHeadTail(DEFAULT_TIME)}`);
  note();
  for (const [label, text] of routineRows(current.limits)) {
    const pad = ' '.repeat(BLOCK_LABEL - label.length);
    note(e.line`  ${e.dim(label)}${pad}${text}`);
  }
  note();
  note(e.line`${e.dim(checkLaterLine())}`);
  if (!(await askYes(input, question(ui, INSTALL_QUESTION)))) {
    say(o.line`${ROUTINE_NOT_INSTALLED}`);
    return;
  }
  try {
    await finishInstall(prepared, DEFAULT_TIME);
  } catch (error) {
    if (!(error instanceof SchedulerError)) throw error;
    note(e.line`${error.message}`);
    say(o.line`${ROUTINE_NOT_INSTALLED}`);
    return;
  }
  say(o.line`${o.tick()} ${installedLine(DEFAULT_TIME)}`);
  say(o.line`${o.dim(ROUTINE_TIME_LINE)}`);
  if (!(await askYes(input, question(ui, FIRST_RUN_QUESTION)))) {
    say(o.line`${laterLine(DEFAULT_TIME)}`);
    return;
  }
  if ((await readConfig(p)) === null) return;
  await firstRun(routineDeps, await readRoutineConfig(p), p, {
    line: (text) => say(o.line`${text}`),
    dim: (text) => say(o.line`${o.dim(text)}`),
    indent: INDENT,
  });
}

// A yes by default question as init asks it, indented, with the default
// dimmed.
function question(ui: Ui, text: string): (again: string) => void {
  const e = ui.err;
  const [words = ''] = text.split(' [Y/n]');
  return (again) =>
    promptStyled(indent(e.line`${again}${words} ${e.dim('[Y/n]')} `));
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
function nextStateOf(config: Config, live: LiveAgent | null): NextState | null {
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
  routineFirst = false,
): void {
  const steps = [
    ...(routineFirst
      ? [s.line`${ROUTINE_STEP}   ${s.dim(cli('routine install --yes'))}`]
      : []),
    ...(state === null ? genericSteps(s, hooks) : stateSteps(s, hooks, state)),
  ];
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
  steps.push(s.line`${state.verifiedTasks > 0 ? POST_STEP : NEXT_POST}`);
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
    s.line`Bronze needs ${BRONZE.verifiedTasks} verified tasks with a Trust Score of ${BRONZE.trustScore} over ${BRONZE.historyDays} days and ${BRONZE.postedTasks} posted tasks another agent completed. Your badge updates on its own.`,
    s.line`${NEXT_POST}`,
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
// since registration is already done. True when the version moved.
async function offerVersionMove(
  config: Config,
  deps: InitDeps,
  ui: Ui,
  p: Paths,
): Promise<boolean> {
  const input = deps.stdin?.();
  if (input === undefined || !input.isTTY) return false;
  const api = createApiClient({
    apiUrl: resolveApiUrl({ config: config.apiUrl }),
    fetch: deps.fetch,
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  });
  let server: string;
  try {
    server = (await api.getAgent(config.agentId)).version;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
  if (server === config.version) return false;
  const e = ui.err;
  const o = ui.out;
  // The server version comes from the API, so it is escaped with the rest.
  promptStyled(e.line`\n${indent(versionQuestion(server, config.version))}`);
  if (!isYes(await input.readLine())) {
    say(
      o.line`SealKeeper stays on ${server}. Run ${cli(`agent version ${config.version}`)} to move it later.`,
    );
    return false;
  }
  // Registration is done and the move is optional, so a refusal or a
  // missing key ends only the move. init goes on to the hooks offer.
  let change: VersionChange;
  try {
    change = await changeVersion({
      api,
      signer: await loadSigner(api.apiUrl, p),
      config,
      previous: server,
      version: config.version,
      paths: p,
    });
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof KeyError)) {
      throw error;
    }
    const reason = error instanceof ApiError ? refusal(error) : error.message;
    note(
      e.line`version not moved, ${reason}. Run ${cli(`agent version ${config.version}`)} to try again.`,
    );
    return false;
  }
  say(
    o.line`${o.tick()} moved SealKeeper from version ${change.previous} to ${change.next}`,
  );
  say(o.line`${inheritLine(change.previous, change.next)}`);
  return true;
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
// installed and nothing is asked. Current hooks in the shared project
// settings.json move to settings.local.json on the way. A --json run, ui
// null, never asks, and prints any install lines on stderr.
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
  // Where project hooks went before they moved to settings.local.json.
  const shared = sharedProjectSettingsPath(dirs.cwd);
  const hook = (deps.hookCommand ?? hookCommand)();
  // Only hooks that run this very command count. A path that moved is
  // offered the install again, which rewrites our entries in place.
  const inUser = await hasHooks(user, hook);
  const found = inUser
    ? user
    : (await hasHooks(project, hook))
      ? project
      : (await hasHooks(shared, hook))
        ? shared
        : null;
  if (found === shared) {
    // Current hooks in the shared settings.json, which a repo commits, hold
    // this machine's absolute paths. They were installed already, so they
    // move to the local file without a question.
    await moveFromShared(shared, project, dirs.cwd, hook, ui);
    return 'present';
  }
  if (found !== null) {
    if (ui !== null) {
      const s = ui.out;
      say(s.line`${s.tick()} Hooks in ${tildePath(found)}`);
    }
    await dropRetired(found, !inUser, dirs.cwd, hook, ui);
    await refreshCommand(found, !inUser, dirs.cwd, hook, ui);
    return 'present';
  }
  // Hooks of ours in the project settings, with an older path, are
  // rewritten in the local project file and taken out of the shared one,
  // so a second set never lands in the user settings beside them.
  const file =
    (await hasHooks(project)) || (await hasHooks(shared)) ? project : user;

  const input = deps.stdin?.();
  // Claude Code running init for the user, the hooks are for the tool that
  // runs it, so they go in without a question (RS-8). Anywhere else a
  // missing terminal is a no.
  const driven = claudeDriven(deps, input);
  if (!driven) {
    if (ui === null || input === undefined || !input.isTTY) {
      return 'not-installed';
    }
    if ((await askHooks(input, ui)) !== 'yes') {
      say(ui.out.line`${HOOKS_NOT_INSTALLED}`);
      return 'not-installed';
    }
  }
  const warn = (message: string) =>
    ui === null ? stderr(message) : note(ui.err.line`${message}`);
  if (file === project) {
    try {
      await refuseOutsideProject(dirs.cwd, [
        file,
        shared,
        proveCommandPath(file),
      ]);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      warn(error.message);
      return 'not-installed';
    }
  }
  if (!(await installAt(file, hook, ui))) return 'not-installed';
  if (file === project) {
    try {
      await uninstallHooks(shared, hook);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      warn(error.message);
    }
  }
  if (driven) warn(HOOKS_BY_CLAUDE);
  return 'installed';
}

// Moves current hooks of ours from the shared project settings.json into
// settings.local.json, the same install as the stale path case, and takes
// them out of the shared file. A path outside the project, or a local file
// that cannot be changed, leaves the hooks where they are with a warning.
async function moveFromShared(
  shared: string,
  project: string,
  cwd: string,
  hook: string,
  ui: Ui | null,
): Promise<void> {
  const warn = (message: string) =>
    ui === null ? stderr(message) : note(ui.err.line`${message}`);
  try {
    await refuseOutsideProject(cwd, [
      project,
      shared,
      proveCommandPath(project),
      skillPath(project),
    ]);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    warn(error.message);
    if (ui !== null) {
      const s = ui.out;
      say(s.line`${s.tick()} Hooks in ${tildePath(shared)}`);
    }
    return;
  }
  if (!(await installAt(project, hook, ui))) return;
  let removed: number;
  try {
    removed = await uninstallHooks(shared, hook);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    warn(error.message);
    return;
  }
  if (removed === 0) return;
  const moved = `Moved the hooks out of ${tildePath(shared)}, since they hold absolute paths on this machine and a repo commits that file`;
  if (ui === null) stderr(moved);
  else say(ui.out.line`${moved}`);
}

// Takes the tool call hooks an older CLI installed out of a settings file
// that holds the current hooks, as adapter claude-code install does. A
// project file outside the project, or one that cannot be changed, is left
// as it is with a warning.
async function dropRetired(
  file: string,
  project: boolean,
  cwd: string,
  hook: string,
  ui: Ui | null,
): Promise<void> {
  let removed: string[];
  try {
    if (project) await refuseOutsideProject(cwd, [file]);
    removed = await removeRetiredHooks(file, hook);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    if (ui === null) stderr(error.message);
    else note(ui.err.line`${error.message}`);
    return;
  }
  if (removed.length === 0) return;
  const line = `Removed the tool call hooks from ${tildePath(file)}, the hooks record sessions only`;
  if (ui === null) stderr(line);
  else say(ui.out.line`${line}`);
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
  const skillFile = skillPath(file);
  try {
    if (project) await refuseOutsideProject(cwd, [commandPath, skillFile]);
    if (await refreshProveCommand(commandPath, invocationOf(hook))) {
      if (ui !== null) {
        const s = ui.out;
        say(
          s.line`${s.tick()} /sealkeeper-prove updated in ${tildePath(dirname(commandPath))}`,
        );
      }
    }
    // The skill came with the nudge, so a copy of ours is brought up to
    // date and one that is missing is added, like on install.
    const skill = await installSkill(skillFile, invocationOf(hook));
    if (skill === 'written' && ui !== null) {
      const s = ui.out;
      say(
        s.line`${s.tick()} sealkeeper skill in ${tildePath(dirname(skillFile))}`,
      );
    }
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
  }
}

// The same install as sealkeeper adapter claude-code install into one
// settings file, the hooks and then the /sealkeeper-prove command. false
// when the settings file could not be changed. A --json run, ui null,
// prints the lines adapter claude-code install prints, on stderr, so the
// --json output stays one object.
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
      for (const text of hooksLines(result, file)) stderr(text);
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
      stderr(commandLine(command, commandPath));
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
  const skillFile = skillPath(file);
  try {
    const skill = await installSkill(skillFile, invocationOf(hook));
    if (ui === null) {
      stderr(skillLine(skill, skillFile));
    } else {
      const s = ui.out;
      say(
        skill === 'kept'
          ? s.line`Left ${tildePath(skillFile)} alone, SealKeeper did not write it`
          : s.line`${s.tick()} sealkeeper skill in ${tildePath(dirname(skillFile))}`,
      );
    }
  } catch (error) {
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
function nextSteps(
  hooks: HooksResult,
  deps: InitDeps,
  routineFirst = false,
): string[] {
  const steps = [
    ...(routineFirst ? [NEXT_ROUTINE] : []),
    NEXT_PROVE,
    NEXT_WHAT_IS_SHARED,
    NEXT_POST,
  ];
  if (hooks === 'not-installed') steps.push(NEXT_HOOKS);
  if (hooks === 'installed' && (deps.isNpx ?? isNpxCopy)()) {
    steps.push(NEXT_NPX);
  }
  return steps;
}
