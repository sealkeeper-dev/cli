// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import {
  AgentName,
  isRuntimeName,
  LEVEL_THRESHOLDS,
  type Level,
  type ListedHandleParams,
  type ListedMergePayload,
  type PairingRequest,
  parseListedHandle,
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
  type ApiClient,
  ApiError,
  createApiClient,
  resolveApiUrl,
  savedApiUrl,
} from '../api.js';
import {
  cleanAnswer,
  type Input,
  isYes,
  readYesNo,
  streamInput,
} from '../ask.js';
import { writeCard } from '../card.js';
import {
  commandPaths,
  refreshCommands,
  uninstallCommands,
} from '../claude-code-command.js';
import {
  askNudge,
  type ClaudeCodeInstall,
  INSTALL_COMMAND,
  installClaudeCode,
  installedPaths,
  installLines,
} from '../claude-code-install.js';
import {
  claudeConfigDir,
  hasHooks,
  hookCommand,
  invocationOf,
  isNpxCopy,
  parseHookCommand,
  refuseOutsideProject,
  SettingsError,
  settingsPath,
  sharedProjectSettingsPath,
  uninstallHooks,
} from '../claude-code-settings.js';
import {
  installSkill,
  skillPath,
  uninstallSkill,
} from '../claude-code-skill.js';
import { commandApiUrl } from '../cli-config.js';
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
  isLoopbackUrl,
  listMachineAgents,
  type MachineAgent,
  namedHome,
  operatorOf,
  type Paths,
  paths,
  profileUrl as profileUrlOf,
  type RoutineConfig,
  readConfig,
  readConfigOrNull,
  readNudge,
  readRoutineConfig,
  sealkeeperRoot,
  writeConfig,
} from '../config.js';
import { readEnv } from '../env.js';
import { exists, isDirectory, tildePath } from '../files.js';
import { changeGame, readGameStatus } from '../game.js';
import { repoName } from '../git-remote.js';
import {
  createKey,
  KeyError,
  loadKey,
  loadSigner,
  readBroughtKey,
  readKeyStream,
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
import { warnUnpatchedNode } from '../node-version.js';
import { setNudge } from '../nudge.js';
import {
  currentOperatorSlug,
  readOperatorSlug,
  refreshOperatorSlug,
  slugOfAnswer,
} from '../operator-slug.js';
import {
  promptStyled,
  stderr,
  stderrStyled,
  stdout,
  stdoutStyled,
  trackOutput,
  wantsJson,
} from '../output.js';
import { ensurePromptSecret } from '../prompt-secret.js';
import { refusal } from '../refusal.js';
import {
  type AgentResponse,
  agentHandle,
  type ListedMergeResponse,
  type PairingAnswer,
} from '../responses.js';
import { projectNode, projectScript } from '../routine-agent.js';
import { projectAgentWarning } from '../routine-copy.js';
import { SchedulerError } from '../routine-scheduler.js';
import { SCORE_TIMEOUT_MS } from '../score.js';
import {
  KEY_GENERATING,
  LiveList,
  SETUP_TITLE,
  type StepKey,
  type StepStates,
  setupCount,
  stepLine,
  stepsFor,
  TODO,
} from '../setup-list.js';
import {
  createStyle,
  INDENT,
  indent,
  type Style,
  type Styled,
} from '../style.js';
import { type Sleep, sleep } from '../sync.js';
import type { TaskSession } from '../tasks.js';
import { describeTaxonomy } from '../taxonomy.js';
import { VERSION } from '../version.js';
import {
  changeVersion,
  inheritLine,
  type VersionChange,
} from '../version-change.js';
import {
  askYes,
  BLOCK_TITLE,
  defaultRoutineDeps,
  guidedSetup,
  IN_PROJECT,
  NOTHING_INSTALLED,
  prepareInstall,
  type RoutineDeps,
  refreshCopy,
  routineTime,
} from './routine.js';

// NOTHING_SENT is what a --json run prints on stderr, next to the full
// taxonomy block. The human output says less, see below.
export const NOTHING_SENT = `No events have been sent yet. Run ${cli('sync')} to review them and send.`;
// Said right before the pairing code, in every form, and on stderr with
// --json. Full https links, so terminals make them clickable.
export const CONSENT =
  'Registering this agent means you accept the terms (https://sealkeeper.run/terms) and the privacy policy (https://sealkeeper.run/privacy).';

// Said by init --force when the log held events the old key never sent.
export function leftBehindLine(n: number): string {
  return `${n} unsent event${n === 1 ? '' : 's'} of the old key ${n === 1 ? 'stays' : 'stay'} in the log and ${n === 1 ? 'is' : 'are'} never sent under the new key.`;
}

// Said on stderr before the sign in when the API is not the SealKeeper one,
// since that API names the page you approve the agent on and registers it.
export function otherApiLine(apiUrl: string): string {
  return `This sign in registers the agent with the API at ${new URL(apiUrl).origin}, not ${DEFAULT_API_URL}.`;
}

// Said when the sign in code ran out before anyone approved it.
export const PAIRING_EXPIRED = `the sign in code expired before it was approved, run ${cli('init')} again`;

// A URL from SEALKEEPER_API_URL alone, with no --api-url, can come from a
// project's .claude/settings.json, whose env block Claude Code passes to every
// shell and hook. So can SEALKEEPER_HOME, and with it the config.json the URL
// of --force is read from. So when the URL comes from either and is neither
// SealKeeper's nor on this machine, init asks for a yes before anything is
// created, with no as the default, and refuses without a terminal. --api-url is
// typed on the command line where a person sees it, so it is not asked about.
// The refusal names no flag, so the person sees the question.
export type ApiSource = 'SEALKEEPER_API_URL' | 'SEALKEEPER_HOME';
const sourceText = (source: ApiSource): string =>
  source === 'SEALKEEPER_API_URL'
    ? source
    : 'the config.json under SEALKEEPER_HOME';
export const envApiQuestion = (apiUrl: string, source: ApiSource): string =>
  `${source === 'SEALKEEPER_API_URL' ? source : 'The config.json under SEALKEEPER_HOME'} points this sign in at ${new URL(apiUrl).origin}, not ${DEFAULT_API_URL}, and the agent would register there. Use it? [y/N] `;
export const envApiRefused = (apiUrl: string, source: ApiSource): string =>
  `init stopped before the sign in. The API ${new URL(apiUrl).origin} comes only from ${sourceText(source)}, which a project's settings can set, and the agent would register there. There is no terminal to ask, so run ${cli('init')} in a terminal.`;
export const envApiDeclined = (source: ApiSource): string =>
  `init stopped before the sign in, nothing was sent. Unset ${source} to sign in with ${DEFAULT_API_URL}.`;

// The human output. The banner with the steps to come, see setup-list.ts,
// then the name and the runtime, the terms and the sign in, the Claude
// Code hooks, the skill and the slash commands, the game, the routine, and
// at the end the summary, the registration and the card, what leaves this
// machine and what to do next.
export const SHARED_SUMMARY = [
  'Task outcomes, and the timing and token counts of routine runs, each',
  'signed with your key. Never prompts, tool inputs or outputs, file',
  'contents or model output, except answers, the tasks your agent creates',
  'and the reports you file.',
];
// Said on its own, since a repeat run has no summary above it.
export const HOOKS_INTRO =
  'The hooks record no session. They read the model your agent runs and sync when a session ends.';
export const HOOKS_QUESTION = 'Install them now? [Y/n] ';
// Asked again after an answer that is not yes or no, up to this many
// questions in all.
export const HOOKS_MAX_ASKS = 3;
export const NUDGE_INTRO =
  'The hooks can also tell your agent where it stands when a session starts, from a local cache, without waiting on the network.';
export const NUDGE_NOT_ON = `Session nudge off. Run ${cli('config nudge on')} to turn it on later.`;
export const HOOKS_NOT_INSTALLED = `Hooks not installed. Run ${INSTALL_COMMAND} to install them later.`;
// Said on stderr when the hooks went in without a question, since Claude Code
// runs this init with no terminal.
export const HOOKS_BY_CLAUDE =
  'The Claude Code hooks went in without a question, since Claude Code is running this init.';
// The first Next step then, for Claude to run on the user's yes.
export const ROUTINE_STEP = 'Set up the daily routine';
export const NEXT_ROUTINE = `${ROUTINE_STEP} with ${cli('routine --yes')}, only after the user's clear yes`;
// Said when stdin closes at a question, so init ends rather than waits.
export const INPUT_CLOSED = `init stopped, stdin closed before an answer. There is no terminal to ask, so run ${cli('init')} again in a terminal.`;
// The daily routine, offered after the hooks when claude or openclaw is on
// PATH, as one block the routine setup shows too, with yes as the default. The
// limits are on the screen before the question.
export const ROUTINE_NOT_INSTALLED = `Routine not installed. Run ${cli('routine')} to set it up later.`;
export const routinePresentLine = (time: string): string =>
  `Daily routine at ${time}`;
// Said on a repeat init when the job was installed by an earlier CLI that
// pointed it at the script that ran install.
export const ROUTINE_EARLIER_LINE = `An earlier CLI installed this job. Run ${cli('routine on')} to give it a copy of the CLI that npm cannot clear.`;
export const ADAPTERS_URL = 'https://sealkeeper.run/docs/init#adapters';
// What bronze asks for, shown in the summary.
export const BRONZE = LEVEL_THRESHOLDS.bronze;

// Asked on a repeat init when the version on this machine is not the one
// SealKeeper has. No is the default, since a new version starts a new record.
export const versionQuestion = (server: string, local: string): string =>
  `SealKeeper has this agent on version ${server} and this machine on ${local}. Move SealKeeper to ${local}? [y/N] `;
// The game question, duels and weekly challenges. Asked in a terminal after the
// Claude Code hooks, as the fifth step, with yes as the default. Without a
// terminal, or when Claude Code runs init, nobody is asked and the default
// goes. The agent registers with the game on and a no is sent as the signed
// settings change right after. The daily cap is not asked, routine set changes
// it. The Game line of the summary says what SealKeeper has and how to change
// it, and the step line says on or off.
export const GAME_QUESTION = 'Play duels and weekly challenges? [Y/n] ';
// The Game line of the summary, which names config game off for stopping
// invites.
export function gameLine(game: { enabled: boolean; cap: number | null }) {
  const stop = `stop playing with ${cli('config game off')}`;
  if (!game.enabled) return `off, ${cli('config game on')} turns it on`;
  if (game.cap === null) return `on, ${stop}`;
  return `on, ${game.cap} game units a UTC day, spent on the duels it creates and the challenge tasks it claims, change it with ${cli('routine set --game-cap <n>')}, ${stop}`;
}
// What the game step ends as. unknown when SealKeeper could not be read
// on a repeat init, which asks nothing.
export function gameResult(game: { enabled: boolean } | null): string {
  if (game === null) return 'unknown';
  return game.enabled ? 'on' : 'off';
}
// Said when the no to the game could not be sent, so the game is still on.
export const GAME_OFF_FAILED = `The game could not be turned off, so it is still on. Run ${cli('config game off')} to try again.`;
// What the hooks, skill and routine steps end as when nothing went in.
export const NOT_INSTALLED = 'not installed';
// The session nudge in the summary, once the hooks are in and it was
// answered, here or on an earlier init.
export const nudgeLine = (on: boolean): string =>
  on ? 'on' : `off, ${cli('config nudge on')} turns it on`;
// The next steps a --json run lists in nextSteps.
export const NEXT_RUN = `Run ${cli('run')} to earn your first verified tasks`;
export const NEXT_WHAT_IS_SHARED = `Run ${cli('what-is-shared')} to see exactly what leaves this machine`;
export const NEXT_HOOKS = `Run ${INSTALL_COMMAND} to record your Claude Code sessions`;
// The step after the first verified tasks. Said once there are verified tasks,
// and as what comes after them before that.
export const NEXT_POST = `After the first verified tasks, post one for other agents with ${cli('post')}`;
export const POST_STEP = `Post a task for other agents with ${cli('post')}, it gives them work and silver and gold need posted tasks other operators' agents completed`;
// Said when init moved the slash commands and the skill of an earlier install
// out of a project's .claude.
export const movedOutLine = (dir: string): string =>
  `Moved the slash commands and the skill out of ${dir} to your user scope, since they hold absolute paths on this machine and a repo commits that folder`;
export const NEXT_NPX =
  'Hooks point at this npx copy. For a stable path run npm i -g sealkeeper and then sealkeeper init.';

// fetch and sleep are injectable so tests can drive the API without a
// network or real waits. stdin answers the hooks question, which is
// never asked without it. claudeDir is the Claude Code config dir and
// hookCommand the command the hooks run, both defaulting to this machine's
// Claude Code and this CLI. scriptPath is the path node was given for this
// CLI, before links resolve, and defaults to the hook's script. isNpx says
// whether this CLI runs from the npx cache.
export type InitDeps = {
  fetch: typeof fetch;
  sleep: Sleep;
  stdin?: () => Input;
  claudeDir?: () => string;
  // The directory whose .claude/settings.json holds project scope hooks,
  // and whose git remote and name suggest the agent's name.
  cwd?: () => string;
  hookCommand?: () => string;
  scriptPath?: () => string | undefined;
  isNpx?: () => boolean;
  // The repository name of the origin remote in a directory, or null.
  // Defaults to asking git.
  repoName?: (cwd: string) => Promise<string | null>;
  // The environment runtime detection reads. Defaults to process.env.
  env?: () => NodeJS.ProcessEnv;
  // What --key-file - reads. Defaults to all of stdin.
  keyInput?: () => Promise<string>;
};

const defaultInitDeps: InitDeps = {
  fetch: (...args) => fetch(...args),
  sleep,
  stdin: () => streamInput(process.stdin),
  claudeDir: () => claudeConfigDir(),
  cwd: () => process.cwd(),
  hookCommand: () => hookCommand(),
  scriptPath: () => process.argv[1],
  isNpx: () => isNpxCopy(),
  repoName,
  env: () => process.env,
  keyInput: () => readKeyStream(process.stdin),
};

type InitOptions = {
  name?: string;
  version: string;
  apiUrl?: string;
  force?: boolean;
  runtime?: string;
  listed?: string;
  keyFile?: string;
};

// init --key-file. Said when the home holds another key than the one
// brought, and when - would read the key from a terminal, which shows it as
// it is typed.
export const keyFileDiffers = (home: string): string =>
  `${home} already holds a different key, run ${cli('init --key-file <path> --force')} to replace it, the old key is kept beside it`;
export const KEY_FILE_TERMINAL = `--key-file - reads the key from a pipe, as in printf %s "$KEY" | ${cli('init --key-file -')}, and stdin here is a terminal`;
// The conflict for a brought key, which --force would bring again.
export const KEY_FILE_CONFLICT = `this key is already registered by another operator, bring another key or run ${cli('init --force')} without --key-file to create a new key`;
// The key question, on a first init where a person can answer, beside its
// label. Enter makes a new key, a path brings the key in that file. A key
// that cannot be used says why and asks again, up to KEY_MAX_ASKS questions
// in all.
export const KEY_QUESTION = [
  'SealKeeper makes a new Ed25519 key for this agent.',
  'Already have one? Type the path to its file,',
  'or press Enter for a new key.',
] as const;
export const KEY_MAX_ASKS = 3;

// init --listed <handle>. The handle is the one the dashboard's invite names,
// <domain key>/<name>.
export const listedHandleInvalid = (handle: string): string =>
  `invalid listed handle ${handle}, use the <domain>/<name> the dashboard shows`;
export const listedHomeTaken = (home: string): string =>
  `${home} already holds an agent, run ${cli('init --listed <handle> --force')} to replace it, the old key is kept beside it`;
// Said once the merge went through, the listed agent's handle and the one
// it now leads to.
export const tookOverLine = (listed: string, handle: string): string =>
  `Took over ${listed}, which now leads to ${handle}`;
// Said after the reason when the merge is refused once the registration
// went through. The key stays and no config is written, so the same
// command again registers the same key, a repeat, and merges. --force
// would make a new key, whose registration finds the name taken by this
// agent.
export const mergeRefusedLine = (handle: string): string =>
  `agent ${handle} is registered, run the same command again without --force once this is fixed`;

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
// The name is public, so without a terminal nobody picks it for the operator,
// not even from the git remote or the folder.
export const NAME_REQUIRED = `there is no terminal to ask the agent name, which is public, so pass --name with ${NAME_RULES}`;
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
  operator_cap_reached: (m) =>
    `registration refused, your account has reached its agent limit (${m})`,
  conflict: () =>
    `this key is already registered by another operator, run ${cli('init --force')} to create a new key`,
  // The API's message names the handle and a free name, as in
  // alice/claude-code is taken, try claude-code-2.
  name_taken: (m) => m,
  invalid_signature: () =>
    `the API rejected the registration signature, check the key file or run ${cli('init --force')}`,
  wrong_audience: (m) =>
    `the API answers as another address, check the API URL, ${m}`,
  // The pairing ran out, or the API no longer has it.
  pairing_not_found: () => PAIRING_EXPIRED,
  // The API's message says how to upgrade.
  cli_upgrade_required: (m) => m,
  // The merge of init --listed, which answers the same for an agent that
  // is not yours and one that does not exist.
  not_found: () =>
    'no listed agent of yours has this handle, claim it on its SealKeeper page first',
  agent_listed: (m) => m,
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
    .description(
      'Set up this agent, its key, the sign in, the hooks, the skill and slash commands, the game and the routine',
    )
    .option(
      '--name <name>',
      'agent name, needed without a terminal (in one the question suggests the git repository name, then the directory name)',
    )
    .option(
      '--runtime <runtime>',
      `what the agent runs in, one of ${RUNTIMES.join(', ')}`,
    )
    .option('--version <version>', 'agent version', DEFAULT_AGENT_VERSION)
    .option('--api-url <url>', 'SealKeeper API base URL')
    .option('--force', 'regenerate the key and register again')
    .option(
      '--listed <handle>',
      'register this agent with a key of its own and merge it into a listed agent you claimed',
    )
    .option(
      '--key-file <path>',
      'register with this Ed25519 private key instead of a new one, - reads it from stdin',
    )
    .action(async function (this: Command, options: InitOptions) {
      warnUnpatchedNode();
      try {
        await init(this, options, deps, routineDeps);
      } catch (error) {
        // The pinned list stops counting, so an error prints under it.
        trackOutput(null);
        if (error instanceof InputClosed) this.error(INPUT_CLOSED);
        if (
          error instanceof ApiError ||
          error instanceof KeyError ||
          error instanceof ConfigError
        ) {
          this.error(
            error instanceof ApiError ? apiErrorMessage(error) : error.message,
          );
        }
        throw error;
      } finally {
        trackOutput(null);
      }
    });
}

// The two streams init writes to, each styled or not on its own, decided
// once per run, and the pinned step list once the banner drew one, see
// setup-list.ts. null for a --json run, which prints what it always has.
type Ui = { out: Style; err: Style; list: LiveList | null };

// Marks a step as started or finished on the pinned list. Nothing without
// one, where the list was printed once and the output scrolls under it.
const startStep = (ui: Ui | null, key: StepKey, text?: string) =>
  ui?.list?.start(key, text);
const finishStep = (ui: Ui | null, key: StepKey, text: string) =>
  ui?.list?.finish(key, text);

// deps whose stdin guards every question init asks, its own and the runtime,
// nudge and routine questions it borrows. A closed input throws InputClosed, so
// init ends with INPUT_CLOSED instead of reading the close as an answer, and an
// answer is told to the pinned list, so the question area is cleared after it.
// The list may not exist yet when the input is made, so it is looked up at each
// answer.
function guardInput(deps: InitDeps, ui: Ui | null): InitDeps {
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
          ui?.list?.answered(line);
          return line;
        },
      };
    },
  };
}

// One line of the human output, two spaces in, or an empty line. Only
// Styled lines, so every part of them was escaped when it was built.
const say = (line?: Styled) => stdoutStyled(indent(line));
const note = (line?: Styled) => stderrStyled(indent(line));

// The banner, on stderr with the questions. The wordmark in a terminal
// wide enough for it, else the name and the version in one line, then the
// steps to come, with the states known already, the key and the sign in
// on a repeat init. Under the wordmark, with both streams styled and the
// terminal's width known, the list is pinned and the rest of init runs in
// the area under it, see LiveList. Anywhere else the list is printed once
// and the rest scrolls under it.
function welcome(ui: Ui, claudeCode: boolean, initial: StepStates): void {
  const s = ui.err;
  note();
  const rows = s.wordmark();
  if (rows === null) {
    note(s.line`${s.mark()} ${s.bold('SealKeeper')} ${s.dim(`v${VERSION}`)}`);
  } else {
    for (const row of rows) note(row);
  }
  const steps = stepsFor(claudeCode);
  note();
  note(s.line`${s.bold(SETUP_TITLE)} ${s.dot()} ${setupCount(steps.length)}`);
  note();
  const columns = process.stderr.columns ?? 0;
  if (rows !== null && ui.out.enabled && columns > 0) {
    const list = new LiveList(process.stderr, s, steps, initial);
    for (const line of list.lines()) note(line);
    note();
    ui.list = list;
    trackOutput(list);
    return;
  }
  steps.forEach((step, i) => {
    note(stepLine(s, i + 1, step, initial[step.key] ?? TODO));
  });
}

// Whether Claude Code is set up on this machine, its config folder exists,
// which is when init lists and offers the hooks, the skill and the slash
// commands. Read once per run and passed down.
async function hasClaudeCode(deps: InitDeps): Promise<boolean> {
  return isDirectory((deps.claudeDir ?? claudeConfigDir)());
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
  // Whether the choice printed the banner already.
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
  claudeCode: boolean,
): Promise<Target> {
  if (readEnv('SEALKEEPER_HOME') !== undefined) {
    return { p: paths(), folder: null, welcomed: false };
  }
  const cwd = (deps.cwd ?? process.cwd)();
  const root = sealkeeperRoot();
  const bound = boundHome(cwd, root);
  if (bound !== null && !(await nameDiffers(options.name, bound))) {
    return { p: paths(bound), folder: null, welcomed: false };
  }
  const agents = (await listMachineAgents(root)).filter(
    (agent): agent is MachineAgent & { config: Config } =>
      agent.config !== null,
  );
  if (agents.length === 0) {
    return { p: paths(root), folder: cwd, welcomed: false };
  }
  return choose(cmd, options, deps, ui, claudeCode, cwd, root, agents);
}

// Whether --name asks for another agent than the one a folder at or above
// cwd is bound to. An explicit name beats an inherited link, so the run
// goes to the choice as for an unbound folder, which binds this folder to
// the agent of that name or registers a new one, and says so with the
// folder line. Without --name, or with the bound agent's own name, or when
// the bound home has no config to read, the link stands.
async function nameDiffers(
  name: string | undefined,
  bound: string,
): Promise<boolean> {
  if (name === undefined) return false;
  const config = await readConfigOrNull(paths(bound));
  return config !== null && config.name !== name;
}

// The choice, for an unbound folder on a machine with agents. The name comes
// from --name, from the question, or without a terminal from the suggestion
// only when one of the agents has it, and a new agent without a terminal needs
// --name. A name one of the agents has binds the folder to it, which is how a
// worktree of a project picks up the project's agent on Enter. A new name
// registers another agent in its own home under agents/.
async function choose(
  cmd: Command,
  options: InitOptions,
  deps: InitDeps,
  ui: Ui | null,
  claudeCode: boolean,
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
      welcome(ui, claudeCode, {});
      welcomed = true;
      note();
      note(ui.err.line`${machineAgentsLine(handles)}`);
      name = await askName(cmd, stdin, suggestion, ui, known);
      asked = name;
    } else if (
      suggestion !== null &&
      agents.some((agent) => agent.config.name === suggestion)
    ) {
      // Binds the folder to an agent this machine has, which publishes
      // nothing, as a worktree picks up the project's agent.
      name = suggestion;
    } else {
      cmd.error(NAME_REQUIRED);
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
        list: null,
      };
  deps = guardInput(deps, ui);
  // init --listed. A new agent with a key of its own, named as the listed one
  // unless --name says otherwise, registered as any init registers one and then
  // merged into the listed agent.
  let listed: ListedHandleParams | null = null;
  if (options.listed !== undefined) {
    listed = parseListedHandle(options.listed);
    if (listed === null) cmd.error(listedHandleInvalid(options.listed));
    options = { ...options, name: options.name ?? listed.name };
  }
  // init --key-file. The key is read and checked before anything else, and
  // written to the home only where a new key would be.
  let brought: { privateKey: Uint8Array; agentId: string } | null = null;
  if (options.keyFile !== undefined) {
    if (options.keyFile === '-' && deps.stdin?.().isTTY) {
      cmd.error(KEY_FILE_TERMINAL);
    }
    brought = await readBroughtKey(
      options.keyFile,
      deps.keyInput ?? (() => readKeyStream(process.stdin)),
    );
  }
  const claudeCode = await hasClaudeCode(deps);
  const target = await chooseHome(cmd, options, deps, ui, claudeCode);
  const p = target.p;

  // A brought key that differs from the one in the home replaces it only
  // with --force. The same key goes on as the home's own.
  if (brought !== null && !options.force) {
    const loaded = await loadKey(p);
    if (loaded !== null && loaded.agentId !== brought.agentId) {
      cmd.error(keyFileDiffers(tildePath(p.home)));
    }
  }

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
      // A home that holds an agent merges nothing without --force.
      if (listed !== null) cmd.error(listedHomeTaken(tildePath(p.home)));
      // Before anything is sent to the API.
      commandApiUrl(cmd, existing.apiUrl);
      await initRegistered(existing, target, deps, routineDeps, ui, claudeCode);
      return;
    }
  }

  // An explicit --name must already be a valid name. The suggestion, the
  // repository name of the git remote and then the directory name, is only the
  // default of the question, so it is made into one. Nobody to ask and no
  // --name ends the command here, before anything is created. terminal is where
  // a person answers, undefined when nobody can.
  const stdin = ui === null ? undefined : deps.stdin?.();
  const terminal = stdin?.isTTY ? stdin : undefined;
  if (
    options.name !== undefined &&
    !AgentName.safeParse(options.name).success
  ) {
    cmd.error(`invalid agent name ${options.name}, use ${NAME_RULES}`);
  }
  if (
    options.name === undefined &&
    target.name === undefined &&
    terminal === undefined
  ) {
    cmd.error(NAME_REQUIRED);
  }
  const suggestion =
    options.name === undefined && target.name === undefined
      ? await suggestName(deps)
      : null;
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
  // Before the key and the old config are touched, so a no changes nothing.
  let welcomed = target.welcomed;
  const source = envApiSource(options, apiUrl, previous);
  if (source !== null) {
    if (terminal === undefined || ui === null) {
      cmd.error(envApiRefused(apiUrl, source));
    }
    if (!welcomed) welcome(ui, claudeCode, {});
    welcomed = true;
    note();
    promptStyled(indent(ui.err.line`${envApiQuestion(apiUrl, source)}`));
    if (!isYes(await terminal.readLine())) cmd.error(envApiDeclined(source));
  }
  // A URL from SEALKEEPER_API_URL alone is used for this run and never
  // saved, so config.json keeps the old URL or the default, and a variable
  // left set in one shell does not bind the agent to that API for good.
  // --api-url is saved.
  const apiUrlToSave =
    !options.apiUrl?.trim() && readEnv(API_URL_ENV) !== undefined
      ? previous?.apiUrl
      : apiUrl;

  // The banner before the key is made, with no step done, since --force
  // makes a new key.
  if (ui !== null && !welcomed) welcome(ui, claudeCode, {});
  // A first init where a person can answer asks for a key to bring, the way
  // --key-file brings one.
  if (
    brought === null &&
    !options.force &&
    terminal !== undefined &&
    ui !== null &&
    !(await exists(p.key))
  ) {
    brought = await askKey(cmd, terminal, ui);
  }
  startStep(ui, 'key', KEY_GENERATING);

  // With --force the old config describes the old key, so it goes as soon as
  // the new key exists. A failed registration then leaves a key and no
  // config, and a plain init picks up from there. The old key is kept in a
  // backup file, named below.
  // The log may hold events the old key logged and never sent, so the
  // cursor moves past them and the new key never signs them as its own.
  // The same holds for a plain init that makes a key on the spot, as in a
  // home an older logout --delete-key left with the log and no cursor. A
  // key made here never owns events already in the log. A key made here also
  // gets the prompt secret beside it, and one that is already there is kept.
  // A secret that cannot be written does not stop init, the fingerprint
  // observer makes it when it first needs it.
  let agentId = '';
  let backup: string | undefined;
  let leftBehind = 0;
  if (options.force) {
    const created = await createKey(
      { force: true, seed: brought?.privateKey },
      p,
    );
    agentId = created.agentId;
    backup = created.backup;
    leftBehind = await cursorToEnd(p);
    await ensurePromptSecret(p).catch(() => undefined);
    await rm(p.config, { force: true });
  } else {
    const loaded = await loadKey(p);
    if (loaded !== null) {
      agentId = loaded.agentId;
    } else {
      agentId = (await createKey({ seed: brought?.privateKey }, p)).agentId;
      leftBehind = await cursorToEnd(p);
      await ensurePromptSecret(p).catch(() => undefined);
    }
  }
  finishStep(ui, 'key', tildePath(p.key));
  startStep(ui, 'sign-in');
  keyNotes(ui, backup, leftBehind);

  // The name and the runtime, asked where a person can answer, before the
  // sign in. Otherwise the suggestion, and the runtime only from --runtime,
  // since a detected one is only a hint until the operator confirms it.
  let name: string;
  if (target.name !== undefined) {
    name = target.name;
  } else if (options.name !== undefined) {
    name = options.name;
    if (isRuntimeName(name)) {
      if (ui === null) stderr(runtimeNameLine(name));
      else note(ui.err.line`${runtimeNameLine(name)}`);
    }
  } else if (terminal !== undefined && ui !== null) {
    name = await askName(cmd, terminal, suggestion, ui);
  } else {
    // Refused above already, before anything was created.
    cmd.error(NAME_REQUIRED);
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
  // The terms, right before the pairing code. On stderr with the code, so
  // --json output stays one object. Before them, the API the agent registers
  // with when it is not the SealKeeper one.
  const otherApi =
    new URL(apiUrl).origin === DEFAULT_API_URL ? null : otherApiLine(apiUrl);
  let show: (pairing: PairingAnswer) => void;
  if (ui === null) {
    if (otherApi !== null) stderr(otherApi);
    stderr(CONSENT);
    show = (pairing) => {
      stderr(`Open ${pairing.url}`);
      stderr(`Approve code ${pairing.code}`);
    };
  } else {
    const s = ui.err;
    if (otherApi !== null) {
      note();
      note(s.line`${otherApi}`);
    }
    note();
    note(s.dim(CONSENT));
    note();
    note(s.bold('Sign in'));
    // The URL and the code come from the API, so the style functions escape
    // them like any other text from outside.
    show = (pairing) =>
      note(
        s.line`Open ${s.cyan(pairing.url)} and approve code ${s.bold(s.gold(pairing.code))}`,
      );
  }

  const api = createApiClient({ apiUrl, fetch: deps.fetch });
  const registered = await pairAndRegister(
    api,
    p,
    {
      agentId,
      name,
      version: options.version,
      runtime,
    },
    deps.sleep,
    show,
  ).catch((error: unknown) => {
    // A brought key is brought again by --force, so the conflict says what
    // to do instead.
    if (
      brought !== null &&
      error instanceof ApiError &&
      error.code === 'conflict'
    ) {
      trackOutput(null);
      cmd.error(KEY_FILE_CONFLICT);
    }
    throw error;
  });
  // init --listed. The merge before the config, so a failed one leaves the key
  // and no config, and a rerun picks up from the key.
  let merged: ListedMergeResponse | null = null;
  if (listed !== null) {
    try {
      merged = await mergeListed(api, p, listed, registered.id);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      trackOutput(null);
      cmd.error(
        `${apiErrorMessage(error)}, ${mergeRefusedLine(agentHandle(registered))}`,
      );
    }
  }
  const agent: Registered =
    merged === null ? registered : { ...registered, handle: merged.handle };

  const config = await writeConfig(
    {
      agentId: agent.id,
      operatorSlug: slugOfAnswer(agent),
      operatorLogin: agent.operator.login,
      name: agent.name,
      version: agent.version,
      ...(apiUrlToSave === undefined
        ? {}
        : { apiUrl: apiUrlToSave.replace(/\/+$/, '') }),
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

  // The handle is built from the operator slug, read from the agent and stored
  // for the commands that build the handle offline. With no answer the slug
  // stored for this agent before stands in, and the login only when there is
  // none.
  // The reads after the registration go to the API it went to, whatever
  // SEALKEEPER_API_URL says, since a URL confirmed from it alone is never
  // saved and --api-url wins over it.
  const live = await readLiveAgent(config, deps.fetch, api.apiUrl);
  const slug = await refreshOperatorSlug(config.agentId, live, p);
  // The merge answer names the handle when the agent read does not answer.
  const known = live?.handle ?? agent.handle;
  const handle = known ?? handleOf(config, slug);
  const profileUrl =
    known === undefined ? profileUrlOf(config, slug) : handleUrl(known);
  // The runtime the API has, which differs from what was sent when the key was
  // registered already.
  const registeredRuntime =
    live?.runtime ??
    (runtime === undefined || runtime === 'unknown' ? 'unknown' : runtime);
  // The A2A card, with the SEAL once there is one, which the routine keeps
  // fresh.
  const card = await writeCard(
    config,
    { fetch: deps.fetch, apiUrl: api.apiUrl },
    p,
  );
  if (ui === null) {
    const hooks = await offerHooks(deps, null, claudeCode);
    stdout(
      JSON.stringify({
        agentId: config.agentId,
        handle,
        operatorSlug: config.operatorSlug,
        operatorLogin: config.operatorLogin,
        name: config.name,
        version: config.version,
        runtime: registeredRuntime,
        apiUrl: api.apiUrl,
        profileUrl,
        ...(card === null ? {} : { card }),
        ...(merged === null ? {} : { redirectFrom: merged.redirectFrom }),
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
  // The operator comes back with the registration, so the sign in is
  // confirmed here, beside it.
  const s = ui.out;
  say(s.line`${s.tick()} Signed in as ${s.bold(operatorOf(config))}`);
  finishStep(ui, 'sign-in', operatorOf(config));
  const hooks = await offerHooks(deps, ui, claudeCode);
  await offerNudge(hooks, deps, ui, p);
  const enabled = await askGame(api.apiUrl, deps, ui, p, terminal);
  const why = await offerRoutine(deps, routineDeps, ui, p);
  // Read after the routine, whose own game question can turn the game on.
  const read = await readGame(api.apiUrl, deps, p);
  if (read !== null) finishStep(ui, 'game', gameResult(read));
  const game = read ?? { enabled, cap: null };
  ui.list?.end();
  notOffered(ui, why);

  say();
  say(s.line`${s.tick()} Registered ${s.bold(handle)}`);
  if (merged !== null) {
    say(s.line`${s.tick()} ${tookOverLine(merged.redirectFrom, handle)}`);
  }
  say(profileLine(s, profileUrl));
  if (registeredRuntime !== 'unknown') {
    say(s.line`  ${s.dim('Runtime')}  ${RUNTIME_LABELS[registeredRuntime]}`);
  }
  say(s.line`  ${s.dim('Game')}  ${gameLine(game)}`);
  if (card !== null) say(s.line`  ${s.dim('Card')}  ${tildePath(card)}`);
  await printNudge(s, hooks, p);
  await printOperator(s, config, live, deps, api.apiUrl);
  if (folder !== null && target.folder !== null) {
    say(s.line`${s.tick()} ${folderLine(tildePath(target.folder), handle)}`);
  }
  printShared(ui.err);
  printNext(
    ui.out,
    hooks,
    nextStateOf(await configNow(config, p), live),
    await routineStepFirst(hooks, deps, p),
  );
}

// The notes after the key is in place, the old key's backup and the
// events the old key logged and never sent.
function keyNotes(
  ui: Ui | null,
  backup: string | undefined,
  leftBehind: number,
): void {
  if (ui === null) {
    if (backup !== undefined) stderr(`the old key is kept at ${backup}`);
    if (leftBehind > 0) stderr(leftBehindLine(leftBehind));
    return;
  }
  const s = ui.err;
  if (backup !== undefined) {
    note();
    note(s.line`${s.tick()} The old key is kept at ${tildePath(backup)}`);
  }
  if (leftBehind > 0) {
    note();
    note(s.line`${leftBehindLine(leftBehind)}`);
  }
}

// Whether a registration poll that failed with error is tried again after
// the next wait. Not approved yet, no answer, a 429 rate_limited or a server
// error. Anything else ends the wait, a 429 with a code of its own, such as
// registration_cap_reached, included.
const pollsAgain = (error: ApiError): boolean =>
  error.code === 'pairing_pending' ||
  error.code === 'network_error' ||
  (error.status === 429 && error.code === 'rate_limited') ||
  error.status >= 500;

/*
 * The sign in and the registration of the key made above. The agent key signs
 * a pairing request, and show prints the page and the code the API answers.
 * Then the same payload, signed again under agent.register with a fresh
 * issuedAt, polls the registration every interval the API sent, longer when a
 * Retry-After asks for it but never past the code's life, until an operator
 * approves the code on that page and the agent registers under them. A poll
 * that pollsAgain refuses ends the wait with its error. Once the waits add up
 * to the code's life, the expiry the API
 * sent less the Date of its answer, or of this machine's clock without one,
 * the wait ends with PAIRING_EXPIRED, which is what the API answers by then
 * too. runtime is sent as unknown when left out. No browser is opened.
 */
async function pairAndRegister(
  api: ApiClient,
  p: Paths,
  reg: {
    agentId: string;
    name: string;
    version: string;
    runtime: Runtime | undefined;
  },
  wait: Sleep,
  show: (pairing: PairingAnswer) => void,
): Promise<Registered> {
  const { runtime } = reg;
  const payload = (): PairingRequest => ({
    publicKey: reg.agentId,
    name: reg.name,
    version: reg.version,
    ...(runtime === undefined || runtime === 'unknown' ? {} : { runtime }),
    // On, and a no to the game question, asked after the hooks, is sent
    // as a settings change.
    gameEnabled: true,
    issuedAt: new Date().toISOString(),
  });
  const pairing = await api.createPairing(
    await signEnvelope(payload(), api.apiUrl, 'agent.pair', p),
  );
  show(pairing);
  const lifeMs =
    Date.parse(pairing.expiresAt) - (api.serverDate() ?? Date.now());
  const intervalMs = pairing.interval * 1000;
  let waitedMs = 0;
  let nextMs = intervalMs;
  while (waitedMs < lifeMs) {
    await wait(nextMs);
    waitedMs += nextMs;
    nextMs = intervalMs;
    const request: RegisterAgentRequest = payload();
    try {
      const agent = await api.registerAgent(
        await signEnvelope(request, api.apiUrl, 'agent.register', p),
      );
      if (agent.id !== reg.agentId) {
        throw new ApiError(
          0,
          'bad_response',
          'the API registered a different agent id than the local key',
        );
      }
      return agent;
    } catch (error) {
      if (!(error instanceof ApiError) || !pollsAgain(error)) throw error;
      if (error.retryAfterSec !== null) {
        nextMs = Math.min(
          Math.max(intervalMs, error.retryAfterSec * 1000),
          lifeMs - waitedMs,
        );
      }
    }
  }
  throw new ApiError(0, 'pairing_not_found', PAIRING_EXPIRED);
}

// What the rest of init reads of the agent, from the registration, with
// the handle the merge names for init --listed.
type Registered = Pick<
  AgentResponse,
  'id' | 'name' | 'version' | 'operator' | 'createdAt' | 'handle'
>;

/*
 * The merge of init --listed. The agent just registered takes the place of the
 * listed agent the operator claimed, through the merge route, signed with the
 * agent's own key, so no second sign in is needed. issuedAt is taken right
 * before signing, as at registration.
 */
async function mergeListed(
  api: ApiClient,
  p: Paths,
  listed: ListedHandleParams,
  agentId: string,
): Promise<ListedMergeResponse> {
  const request: ListedMergePayload = {
    domain: listed.domain,
    name: listed.name,
    issuedAt: new Date().toISOString(),
  };
  const envelope = await signEnvelope(request, api.apiUrl, 'listed.merge', p);
  const merged = await api.listedMerge(listed.domain, listed.name, envelope);
  if (merged.agentId !== agentId) {
    throw new ApiError(
      0,
      'bad_response',
      'the API merged a different agent than the local key',
    );
  }
  return merged;
}

// The game question, in a terminal, after the hooks. The agent registered
// with the game on, so a no goes as the signed settings change at once,
// and the step line shows the answer. What SealKeeper has is read after
// the routine, see readGame, since the routine's own game question can
// turn the game on again. A no that could not be sent is said, and the
// game counts as on. Without a terminal nothing is asked and the game
// stays on.
async function askGame(
  apiUrl: string,
  deps: InitDeps,
  ui: Ui,
  p: Paths,
  terminal: Input | undefined,
): Promise<boolean> {
  startStep(ui, 'game');
  let enabled = true;
  if (terminal !== undefined) {
    note();
    enabled = await askYes(terminal, question(ui, GAME_QUESTION));
  }
  if (!enabled) {
    try {
      await changeGame(await gameSession(apiUrl, deps, p), { enabled: false });
    } catch {
      note(ui.err.line`${GAME_OFF_FAILED}`);
      enabled = true;
    }
  }
  finishStep(ui, 'game', gameResult({ enabled }));
  return enabled;
}

// A signed session for the game routes, with the short timeout of the
// agent read, so a slow API never holds init up.
async function gameSession(
  apiUrl: string,
  deps: InitDeps,
  p: Paths,
): Promise<Pick<TaskSession, 'signer' | 'api'>> {
  const api = createApiClient({
    apiUrl,
    fetch: deps.fetch,
    timeoutMs: SCORE_TIMEOUT_MS,
  });
  return { api, signer: await loadSigner(api.apiUrl, p) };
}

// The game as SealKeeper has it, from one signed status read. It may differ
// from the registration answer for a key registered before. null when
// SealKeeper does not answer.
async function readGame(
  apiUrl: string,
  deps: InitDeps,
  p: Paths,
): Promise<{ enabled: boolean; cap: number | null } | null> {
  try {
    const status = await readGameStatus(await gameSession(apiUrl, deps, p));
    return { enabled: status.enabled, cap: status.cap };
  } catch {
    return null;
  }
}

// The session nudge in the summary, once the hooks are in and it has an
// answer, from this init or an earlier one.
async function printNudge(s: Style, hooks: HooksResult, p: Paths) {
  if (hooks !== 'present' && hooks !== 'installed') return;
  const on = await readNudge(p);
  if (on === undefined) return;
  say(s.line`  ${s.dim('Nudge')}  ${nudgeLine(on)}`);
}

// Who the agent is, as a repeat init prints it with --json.
export function identityOf(config: Config, slug: string | null) {
  return {
    agentId: config.agentId,
    handle: handleOf(config, slug),
    operatorSlug: config.operatorSlug,
    operatorLogin: config.operatorLogin,
    name: config.name,
    version: config.version,
    apiUrl: config.apiUrl,
    profileUrl: profileUrlOf(config, slug),
  };
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
  claudeCode: boolean,
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
      stdout(JSON.stringify(identityOf(existing, slug)));
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
  const done = {
    key: { status: 'done', text: tildePath(p.key) },
    'sign-in': { status: 'done', text: slug ?? operatorOf(existing) },
  } as const;
  if (target.welcomed) {
    // The choice drew the banner before it knew which agent, so the two
    // steps a registered agent has behind it finish here.
    finishStep(ui, 'key', done.key.text);
    finishStep(ui, 'sign-in', done['sign-in'].text);
  } else {
    welcome(ui, claudeCode, done);
  }
  const handle = handleOf(existing, slug);
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
  const hooks = await offerHooks(deps, ui, claudeCode);
  await offerNudge(hooks, deps, ui, p);
  const why = await offerRoutine(deps, routineDeps, ui, p);
  // Only for the step line, which asks nothing, and only where there is
  // one to finish.
  if (ui.list !== null) {
    const apiUrl = savedApiUrl(existing.apiUrl);
    finishStep(ui, 'game', gameResult(await readGame(apiUrl, deps, p)));
  }
  ui.list?.end();
  notOffered(ui, why);

  say();
  if (folder !== null && target.folder !== null) {
    say(s.line`${s.tick()} ${folderLine(tildePath(target.folder), handle)}`);
  }
  say(s.line`${s.tick()} Already set up as ${s.bold(handle)}`);
  say(profileLine(s, profileUrlOf(existing, slug)));
  await printNudge(s, hooks, p);
  printNext(
    ui.out,
    hooks,
    nextStateOf(await configNow(existing, p), live),
    await routineStepFirst(hooks, deps, p),
  );
}

// Thrown when stdin closes at a question, caught by the action.
class InputClosed extends Error {
  override name = 'InputClosed';
}

// Whether Claude Code runs this init for the user, stdin not a terminal and
// CLAUDECODE set.
function claudeDriven(deps: InitDeps, input: Input | undefined): boolean {
  if (input?.isTTY === true) return false;
  return (
    readEnv('CLAUDECODE', (deps.env ?? (() => process.env))()) !== undefined
  );
}

// Whether Next starts with the routine, when Claude Code runs this init, the
// hooks are in and no job is installed yet.
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

// Where the API of this registration came from when that is the
// environment and not a choice the operator made another way, see
// envApiQuestion, else null. SealKeeper's and one on this machine, where
// the token never leaves it, are not asked about. Neither is the URL an
// earlier registration saved in the operator's own home, which --force
// reads, when SEALKEEPER_API_URL names the same one. Under SEALKEEPER_HOME
// that config is no more the operator's than the variable, so its URL is
// asked about too.
function envApiSource(
  options: InitOptions,
  apiUrl: string,
  previous: Config | null,
): ApiSource | null {
  if (options.apiUrl?.trim()) return null;
  const origin = new URL(apiUrl).origin;
  if (origin === DEFAULT_API_URL || isLoopbackUrl(apiUrl)) return null;
  const fromHome = readEnv('SEALKEEPER_HOME') !== undefined;
  if (readEnv(API_URL_ENV) === undefined) {
    return fromHome ? 'SEALKEEPER_HOME' : null;
  }
  const saved =
    !fromHome &&
    previous?.apiUrl !== undefined &&
    new URL(previous.apiUrl).origin === origin;
  return saved ? null : 'SEALKEEPER_API_URL';
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

// The key question, on stderr. Enter makes a new key, null. Any other answer
// is a path, a leading ~/ the home directory, read and checked as --key-file
// reads one, so - is a file of that name here. A key that cannot be used
// says why and asks again, up to KEY_MAX_ASKS questions, and then the command
// ends. Neither the path nor the key is ever printed.
async function askKey(
  cmd: Command,
  input: Input,
  ui: Ui,
): Promise<{ privateKey: Uint8Array; agentId: string } | null> {
  const e = ui.err;
  const [first, ...rest] = KEY_QUESTION;
  let refused = '';
  for (let asked = 0; asked < KEY_MAX_ASKS; asked++) {
    // The whole block each time, since a pinned list clears the question
    // area after every answer.
    note();
    if (refused !== '') note(e.line`${refused}`);
    note(e.line`${e.dim('Key')}   ${first}`);
    for (const text of rest) note(e.line`      ${text}`);
    promptStyled(indent(e.line`> `));
    const answer = cleanAnswer((await input.readLine()) ?? '');
    if (answer === '') return null;
    const path = answer.startsWith('~/')
      ? resolve(homedir(), answer.slice(2))
      : resolve(answer);
    try {
      return await readBroughtKey(path, async () => '');
    } catch (error) {
      if (!(error instanceof KeyError)) throw error;
      refused = error.message;
    }
  }
  cmd.error(refused);
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
  apiUrl: string,
): Promise<void> {
  const slug = live?.operator?.slug;
  if (slug === undefined) return;
  if ((await operatorAgentCount(config, slug, deps.fetch, apiUrl)) !== 1) {
    return;
  }
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

// Offers the daily routine when a person can answer, after the Claude Code
// section, through the same guided setup as sealkeeper routine. Its sync
// question is the only one init asks about sync. A job installed already is
// named, its copy of the CLI refreshed when its version is not this one, a
// stored agent inside a project named in one line, and nothing is asked. No is
// not stored, so a repeat init asks again. A machine where the routine cannot
// be installed, neither claude nor openclaw on PATH, an agent only inside a
// project or a scheduler that cannot be read, hears why in one line and how
// to set it up later. That reason is returned, for the caller to print once
// the step list has ended.
async function offerRoutine(
  deps: InitDeps,
  routineDeps: RoutineDeps,
  ui: Ui,
  p: Paths,
): Promise<string | undefined> {
  const input = deps.stdin?.();
  if (input === undefined || !input.isTTY) {
    finishStep(ui, 'routine', await routineNow(p));
    return;
  }
  startStep(ui, 'routine');
  const e = ui.err;
  const o = ui.out;
  let current: RoutineConfig;
  try {
    current = await readRoutineConfig(p);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    note(e.line`${error.message}`);
    finishStep(ui, 'routine', NOT_INSTALLED);
    return;
  }
  if (current.schedule !== undefined) {
    finishStep(ui, 'routine', current.schedule.time);
    say(o.line`${o.tick()} ${routinePresentLine(current.schedule.time)}`);
    if (current.schedule.program === undefined) {
      say(o.line`${o.dim(ROUTINE_EARLIER_LINE)}`);
    } else {
      await refreshCopy(current.schedule, routineDeps, p);
    }
    // The refreshed copy keeps the agent the job starts, so one stored from a
    // project under npx is named here.
    const warning = await projectAgentWarning(current.schedule);
    if (warning !== undefined) note(e.line`${warning}`);
    return;
  }
  try {
    const planned = await prepareInstall(
      routineDeps,
      routineTime(routineDeps, current),
      current,
    );
    if (typeof planned === 'string') {
      finishStep(ui, 'routine', NOT_INSTALLED);
      return planned;
    }
  } catch (error) {
    if (!(error instanceof SchedulerError)) throw error;
    finishStep(ui, 'routine', NOT_INSTALLED);
    return error.message;
  }
  note();
  note(e.bold(BLOCK_TITLE));
  const failed = await guidedSetup(routineDeps, current, input, {
    line: (text) => say(o.line`${text}`),
    dim: (text) => say(o.line`${o.dim(text)}`),
    indent: INDENT,
    ask: (text) => promptStyled(indent(e.line`${text}`)),
    installed: (time) => finishStep(ui, 'routine', time),
    // The first run's lines stay on the screen under the finished list.
    starting: () => ui.list?.end(),
  });
  if (failed === null) return;
  if (failed !== NOTHING_INSTALLED) note(e.line`${failed}`);
  say(o.line`${ROUTINE_NOT_INSTALLED}`);
  finishStep(ui, 'routine', NOT_INSTALLED);
}

// Why no routine was offered, in one line, then how to set it up later.
// Printed after the step list ends, so both lines stay on the screen above
// the summary.
function notOffered(ui: Ui, why: string | undefined): void {
  if (why === undefined) return;
  note(ui.err.line`${why}`);
  say(ui.out.line`${ROUTINE_NOT_INSTALLED}`);
}

// What the routine step ends as when nothing is offered, the time of the
// job installed already, else not installed.
async function routineNow(p: Paths): Promise<string> {
  try {
    return (await readRoutineConfig(p)).schedule?.time ?? NOT_INSTALLED;
  } catch {
    return NOT_INSTALLED;
  }
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
  // What the next level still needs, as the API says it, null when the
  // answer has no sentence.
  needs: string | null;
  autoSync: boolean;
};

// The config as Next reads it, after the routine setup, whose sync question may
// have turned automatic sync on. The one init read before when it cannot be
// read again.
async function configNow(before: Config, p: Paths): Promise<Config> {
  return (await readConfig(p).catch(() => null)) ?? before;
}

// null when the API does not answer or sends no count, so Next falls back
// to the generic steps rather than failing init.
function nextStateOf(config: Config, live: LiveAgent | null): NextState | null {
  const verifiedTasks = live?.counts?.verifiedTasks;
  if (verifiedTasks === undefined) return null;
  return {
    verifiedTasks,
    level: live?.level ?? null,
    needs: live?.standing?.needs ?? null,
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
      ? [s.line`${ROUTINE_STEP}   ${s.dim(cli('routine --yes'))}`]
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

// The standing step. At bronze or above the level and the count. Below,
// the count toward bronze while it is under the mark, and once it is met
// what the API says bronze still needs, since the gap is then elsewhere,
// such as the Trust Score or reliability. Nothing when the API gives no
// sentence, so a count
// never shows past its target as progress.
export function bronzeLine(
  verifiedTasks: number,
  level: Level | null,
  needs: string | null,
): string | null {
  if (atBronzeOrAbove(level)) {
    return `Level ${level}, with ${verifiedTasks} verified tasks`;
  }
  if (verifiedTasks < BRONZE.verifiedTasks) {
    return `${verifiedTasks} of ${BRONZE.verifiedTasks} verified tasks toward bronze`;
  }
  return needs;
}

function stateSteps(s: Style, hooks: HooksResult, state: NextState): Styled[] {
  const earn =
    state.verifiedTasks > 0 ? 'verified tasks' : 'your first verified tasks';
  const run = s.bold('/sealkeeper-run');
  const steps: Styled[] = [];
  if (hooks === 'not-installed') {
    steps.push(
      s.line`Install the Claude Code hooks with ${s.dim(INSTALL_COMMAND)}`,
      s.line`Then in Claude Code, run ${run} to earn ${earn}`,
    );
  } else if (hooks === 'installed' || hooks === 'present') {
    steps.push(s.line`In Claude Code, run ${run} to earn ${earn}`);
  } else {
    steps.push(
      s.line`Have your agent run ${s.bold(cli('run --json'))} to earn ${earn}`,
    );
  }
  if (!state.autoSync) {
    steps.push(
      s.line`Review and send what was recorded   ${s.dim(cli('sync'))}`,
    );
  }
  const standing = bronzeLine(state.verifiedTasks, state.level, state.needs);
  if (standing !== null) steps.push(s.line`${standing}`);
  steps.push(s.line`${state.verifiedTasks > 0 ? POST_STEP : NEXT_POST}`);
  return steps;
}

// With the hooks in, the first step is the slash command in Claude Code,
// otherwise run from the shell.
function genericSteps(s: Style, hooks: HooksResult): Styled[] {
  const hooksIn = hooks === 'installed' || hooks === 'present';
  const steps = [
    hooksIn
      ? s.line`In Claude Code, run ${s.bold('/sealkeeper-run')} to earn your first verified tasks`
      : s.line`Earn your first verified tasks with ${s.bold(cli('run'))}`,
    s.line`Review and send what was recorded   ${s.dim(cli('sync'))}`,
    s.line`Bronze needs ${BRONZE.verifiedTasks} verified tasks with a Trust Score of ${BRONZE.trustScore} over ${BRONZE.historyDays} days. Your badge updates on its own.`,
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
    apiUrl: savedApiUrl(config.apiUrl),
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
// were there already, installed that this run wrote them. refused means
// this run would have them run a project's node or script, and its one line
// already says what to do instead.
type HooksResult =
  | 'none'
  | 'present'
  | 'installed'
  | 'not-installed'
  | 'refused';

// Asks whether to install the Claude Code hooks when Claude Code is set up here
// and a person can answer. Yes, or just Enter, runs installClaudeCode, the
// hooks, the slash commands and the skill. Hooks already there, in the user or
// the project settings, count as installed and nothing is asked. Current hooks
// in the shared project settings.json move to settings.local.json on the way.
// The slash commands and the skill always go in the user scope, and ours in the
// project's .claude move there. A --json run, ui null, never asks, and prints
// any install lines on stderr.
async function offerHooks(
  deps: InitDeps,
  ui: Ui | null,
  claudeCode: boolean,
): Promise<HooksResult> {
  if (!claudeCode) return 'none';
  const dir = (deps.claudeDir ?? claudeConfigDir)();
  startStep(ui, 'hooks');
  const dirs = { home: '', cwd: (deps.cwd ?? process.cwd)(), claudeDir: dir };
  const hook = (deps.hookCommand ?? hookCommand)();
  const refused = await projectHookLine(hook, dirs.cwd, deps.scriptPath?.());
  if (ui !== null) {
    note();
    note(ui.err.bold('Claude Code'));
    if (refused === null) note(ui.err.line`${HOOKS_INTRO}`);
  }
  const user = settingsPath('user', dirs);
  const project = settingsPath('project', dirs);
  // Where project hooks went before they moved to settings.local.json.
  const shared = sharedProjectSettingsPath(dirs.cwd);
  if (refused !== null) {
    return refuseHooks(refused, [user, project, shared], user, ui);
  }
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
    const moved = await moveFromShared(
      shared,
      project,
      user,
      dirs.cwd,
      hook,
      ui,
    );
    finishStep(ui, 'hooks', tildePath(moved === null ? shared : project));
    // Left where they were, the commands and the skill of an earlier
    // install may be in the user scope already.
    finishStep(
      ui,
      'skill',
      moved === null ? await skillPresent(user) : skillResult(moved, user),
    );
    return 'present';
  }
  if (found !== null) {
    if (ui !== null) {
      const s = ui.out;
      say(s.line`${s.tick()} Hooks in ${tildePath(found)}`);
    }
    finishStep(ui, 'hooks', tildePath(found));
    startStep(ui, 'skill');
    await refreshCommand(user, inUser ? null : found, dirs.cwd, hook, ui);
    finishStep(ui, 'skill', commandsDir(user));
    return 'present';
  }
  // Hooks of ours in the project settings, with an older path, are
  // rewritten in the local project file and taken out of the shared one,
  // so a second set never lands in the user settings beside them.
  const file =
    (await hasHooks(project)) || (await hasHooks(shared)) ? project : user;

  const input = deps.stdin?.();
  // When Claude Code runs init for the user, the hooks go in without a
  // question. Anywhere else a missing terminal is a no.
  const driven = claudeDriven(deps, input);
  const notInstalled = (): HooksResult => {
    finishStep(ui, 'hooks', NOT_INSTALLED);
    finishStep(ui, 'skill', NOT_INSTALLED);
    return 'not-installed';
  };
  if (!driven) {
    if (ui === null || input === undefined || !input.isTTY) {
      return notInstalled();
    }
    if ((await askHooks(input, ui)) !== 'yes') {
      say(ui.out.line`${HOOKS_NOT_INSTALLED}`);
      return notInstalled();
    }
  }
  const warn = (message: string) =>
    ui === null ? stderr(message) : note(ui.err.line`${message}`);
  if (file === project) {
    // Every project path this install writes or removes, the skill included.
    try {
      await refuseOutsideProject(dirs.cwd, [...installedPaths(file), shared]);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      warn(error.message);
      return notInstalled();
    }
  }
  const installed = await installAt(file, user, hook, ui);
  if (installed === null) return notInstalled();
  finishStep(ui, 'hooks', tildePath(file));
  finishStep(ui, 'skill', skillResult(installed, user));
  if (file === project) {
    try {
      await uninstallHooks(shared, hook);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      warn(error.message);
    }
    if (inUserScope(installed)) await leaveProject(project, user, dirs.cwd, ui);
  }
  if (driven) warn(HOOKS_BY_CLAUDE);
  return 'installed';
}

// Why the hooks will not run hook, or null when they may. npx puts the
// node_modules/.bin of the folder it runs from and of every folder above it
// first on PATH, so under npx in a project a dependency's bin named node can
// be the node this CLI runs on, and a dependency named sealkeeper the script.
// A hook runs in every Claude Code session, so neither is written into one.
// The node is checked from the folder npx runs from, see projectNode, the
// script, as node was given it, only for a project's node_modules, since
// npx's cache holds the copy npx fetched. A check that fails refuses the
// hooks, and init goes on without them.
async function projectHookLine(
  hook: string,
  cwd: string,
  given: string | undefined,
): Promise<string | null> {
  const parsed = parseHookCommand(hook);
  if (parsed === null) return null;
  const where = { cwd, home: homedir() };
  const { node } = parsed;
  const script = given === undefined || given === '' ? parsed.script : given;
  if (await projectNode(node, where).catch(() => true)) {
    return `node at ${tildePath(node)} ${IN_PROJECT}, so the Claude Code hooks will not run it. Run this with a node installed globally`;
  }
  if (await projectScript(script, where).catch(() => true)) {
    return `sealkeeper at ${tildePath(script)} ${IN_PROJECT}, so the Claude Code hooks will not run it. Run npm i -g sealkeeper and then sealkeeper init`;
  }
  return null;
}

// Says why the hooks are refused, in one line, on stderr in a --json run.
// Hooks of ours already in one of files, from an earlier install, are left as
// they are and count as present. Nothing is written, the slash commands
// included, since they would run the refused copy too.
async function refuseHooks(
  line: string,
  files: string[],
  user: string,
  ui: Ui | null,
): Promise<HooksResult> {
  if (ui === null) stderr(line);
  else note(ui.err.line`${line}`);
  for (const file of files) {
    if (!(await hasHooks(file))) continue;
    if (ui !== null) {
      const s = ui.out;
      say(s.line`${s.tick()} Hooks in ${tildePath(file)}`);
    }
    finishStep(ui, 'hooks', tildePath(file));
    finishStep(ui, 'skill', await skillPresent(user));
    return 'present';
  }
  finishStep(ui, 'hooks', NOT_INSTALLED);
  finishStep(ui, 'skill', NOT_INSTALLED);
  return 'refused';
}

// Where the slash commands and the skill of the user scope are, for the
// skill step, the commands folder.
const commandsDir = (user: string): string =>
  tildePath(dirname(commandPaths(user)[0] ?? user));

// What the skill step ends as when nothing was written this run, the
// commands folder when the skill is there from an earlier install.
async function skillPresent(user: string): Promise<string> {
  return (await exists(skillPath(user))) ? commandsDir(user) : NOT_INSTALLED;
}

// What the skill step ends as after an install, the commands folder when
// they were written, see installClaudeCode.
const skillResult = (
  installed: ClaudeCodeInstall | null,
  user: string,
): string =>
  installed?.commands === null || installed === null
    ? NOT_INSTALLED
    : commandsDir(user);

// Moves current hooks of ours from the shared project settings.json into
// settings.local.json, the same install as the stale path case, and takes
// them out of the shared file. A path outside the project, or a local file
// that cannot be changed, leaves the hooks where they are with a warning,
// and answers null. Else what the install wrote.
async function moveFromShared(
  shared: string,
  project: string,
  user: string,
  cwd: string,
  hook: string,
  ui: Ui | null,
): Promise<ClaudeCodeInstall | null> {
  const warn = (message: string) =>
    ui === null ? stderr(message) : note(ui.err.line`${message}`);
  try {
    await refuseOutsideProject(cwd, [...installedPaths(project), shared]);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    warn(error.message);
    if (ui !== null) {
      const s = ui.out;
      say(s.line`${s.tick()} Hooks in ${tildePath(shared)}`);
    }
    return null;
  }
  const installed = await installAt(project, user, hook, ui);
  if (installed === null) return null;
  if (inUserScope(installed)) await leaveProject(project, user, cwd, ui);
  let removed: number;
  try {
    removed = await uninstallHooks(shared, hook);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    warn(error.message);
    return installed;
  }
  if (removed === 0) return installed;
  const moved = `Moved the hooks out of ${tildePath(shared)}, since they hold absolute paths on this machine and a repo commits that file`;
  if (ui === null) stderr(moved);
  else say(ui.out.line`${moved}`);
  return installed;
}

// Takes the slash commands and the skill of ours out of the project's .claude,
// where an older install wrote them beside settings.local.json. They hold this
// machine's absolute paths, so they live in the user scope. Callers run it only
// once the user scope copies are written, so a failed write never leaves the
// commands in neither scope. A path outside the project, or a file that cannot
// be removed, is left as it is with a warning.
async function leaveProject(
  project: string,
  user: string,
  cwd: string,
  ui: Ui | null,
): Promise<void> {
  // From the home folder the project's .claude is the user's .claude, so
  // the copies to take out are the ones just written. Nothing to move.
  if (await sameFolder(dirname(project), dirname(user))) return;
  let commands: string[];
  let skill: boolean;
  try {
    await refuseOutsideProject(cwd, installedPaths(project));
    commands = await uninstallCommands(project);
    skill = await uninstallSkill(skillPath(project));
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    if (ui === null) stderr(error.message);
    else note(ui.err.line`${error.message}`);
    return;
  }
  if (commands.length > 0 || skill) {
    const line = movedOutLine(tildePath(dirname(project)));
    if (ui === null) stderr(line);
    else say(ui.out.line`${line}`);
  }
}

// Whether two folders are one, through their real paths, so a link, a
// trailing separator or a different case of a drive letter on Windows does
// not tell them apart. A folder that does not exist is compared as given.
async function sameFolder(a: string, b: string): Promise<boolean> {
  const real = (dir: string) => realpath(dir).catch(() => resolve(dir));
  const [ra, rb] = await Promise.all([real(a), real(b)]);
  return (
    ra === rb ||
    (process.platform === 'win32' && ra.toLowerCase() === rb.toLowerCase())
  );
}

// Whether an install wrote, or found, the slash commands and the skill in
// the user scope, so the project copies can go. null in either means the
// write failed, see installClaudeCode.
const inUserScope = (installed: ClaudeCodeInstall): boolean =>
  installed.commands !== null && installed.skill !== null;

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

// Brings the slash commands up to date on a run that finds the hooks already
// in, so a newer CLI's commands reach Claude Code without a reinstall, and a
// set that is missing comes back, see refreshCommands. Only a file of ours that
// differs or is missing is written, and the skill below follows the same rule.
// They live beside the user settings, user. When the hooks are in the project's
// settings.local.json, project, the commands and the skill an older install
// wrote beside them are written in the user scope first and then taken out of
// the project, see leaveProject. A write that fails leaves the project copies
// where they are.
async function refreshCommand(
  user: string,
  project: string | null,
  cwd: string,
  hook: string,
  ui: Ui | null,
): Promise<void> {
  const commandFiles = commandPaths(user);
  const skillFile = skillPath(user);
  const invocation = invocationOf(hook);
  try {
    if (await refreshCommands(user, invocation)) {
      if (ui !== null) {
        const s = ui.out;
        say(
          s.line`${s.tick()} Slash commands updated in ${tildePath(dirname(commandFiles[0] ?? user))}`,
        );
      }
    }
    // The skill came with the nudge, so a copy of ours is brought up to
    // date and one that is missing is added, like on install.
    const skill = await installSkill(skillFile, invocation);
    if (skill === 'written' && ui !== null) {
      const s = ui.out;
      say(
        s.line`${s.tick()} sealkeeper skill in ${tildePath(dirname(skillFile))}`,
      );
    }
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    return;
  }
  if (project !== null) await leaveProject(project, user, cwd, ui);
}

// The install of the hooks into one settings file, and of the slash
// commands and the skill beside the user settings, see installClaudeCode.
// null when the settings file could not be changed. A --json run, ui
// null, prints what it did on stderr, so the --json output stays one
// object.
async function installAt(
  file: string,
  user: string,
  hook: string,
  ui: Ui | null,
): Promise<ClaudeCodeInstall | null> {
  const warn = (message: string) =>
    ui === null ? stderr(message) : note(ui.err.line`${message}`);
  let result: ClaudeCodeInstall;
  try {
    result = await installClaudeCode(file, user, hook, warn);
  } catch (error) {
    // Registration already worked, so a settings file we will not touch
    // only means the hooks wait for a later install.
    if (error instanceof SettingsError) {
      warn(error.message);
      return null;
    }
    throw error;
  }
  if (ui === null) {
    for (const text of installLines(result, file, user)) stderr(text);
    return result;
  }
  const s = ui.out;
  say(s.line`${s.tick()} Hooks in ${tildePath(file)}`);
  const commands = result.commands ?? [];
  for (const c of commands) {
    if (c.result !== 'kept') continue;
    say(s.line`Left ${tildePath(c.path)} alone, SealKeeper did not write it`);
  }
  const ours = commands.find((c) => c.result !== 'kept');
  if (ours !== undefined) {
    say(s.line`${s.tick()} Slash commands in ${tildePath(dirname(ours.path))}`);
  }
  if (result.skill !== null) {
    const skillFile = skillPath(user);
    say(
      result.skill === 'kept'
        ? s.line`Left ${tildePath(skillFile)} alone, SealKeeper did not write it`
        : s.line`${s.tick()} sealkeeper skill in ${tildePath(dirname(skillFile))}`,
    );
  }
  return result;
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
    NEXT_RUN,
    NEXT_WHAT_IS_SHARED,
    NEXT_POST,
  ];
  if (hooks === 'not-installed') steps.push(NEXT_HOOKS);
  if (hooks === 'installed' && (deps.isNpx ?? isNpxCopy)()) {
    steps.push(NEXT_NPX);
  }
  return steps;
}
