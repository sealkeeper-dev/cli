// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  AgentRef,
  PostTaskRequest,
  TASK_DEFAULT_TTL_HOURS,
  TASK_MAX_TTL_DAYS,
  type TaskOrigin,
  type VerificationSpec,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { type Input, readYesNo } from '../ask.js';
import { requireConfig } from '../cli-config.js';
import { cli } from '../invocation.js';
import {
  containsPrivateKey,
  holdsPrivateKey,
  insideHome,
} from '../key-guard.js';
import { POST_WHY } from '../ladder.js';
import { promptStyled, stderr, stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { TaskResponse } from '../responses.js';
import { refuseInRoutine } from '../routine.js';
import { createStyle } from '../style.js';
import {
  TEMPLATES,
  type Template,
  TemplateInputError,
  type TemplateTask,
  templateById,
} from '../task-templates.js';
import {
  defaultTasksDeps,
  isJsonObject,
  openTaskSession,
  printFields,
  readJsonArg,
  type TasksDeps,
} from '../tasks.js';

// sealkeeper tasks post. Three ways in.
//
// --type, --spec and --verify post exactly what they say, as before, for
// scripts.
//
// --template <id> builds the task from a ready made template, with --input
// when the template takes one, and posts it only with --yes or after a yes
// in a terminal. Without a terminal and without --yes it refuses before
// anything is read or sent.
//
// No options at all in a terminal walks the operator through it. Pick a
// template, give its input, optionally name one agent, read the task, then
// post it only on a yes. prove --post runs the same walk. Without a
// terminal, no options is an error and nothing is sent.

const MAX_EXPIRES_HOURS = TASK_MAX_TTL_DAYS * 24;
// How many times the guided flow asks one question before it gives up.
const MAX_ASKS = 3;

type PostOptions = {
  type?: string;
  spec?: string;
  verify?: string;
  template?: string;
  input?: string;
  yes?: boolean;
  expiresHours?: string;
  for?: string;
};

export const NOTHING_POSTED = 'Nothing posted.';
export const NO_TERMINAL = `nothing posted. Give --type, --spec and --verify, or --template <id> with --yes. In a terminal, ${cli('tasks post')} with no options walks you through it`;
export const NO_OPTIONS_JSON =
  'nothing posted. With --json, give --type, --spec and --verify, or --template <id> with --yes';
export const NOT_POSTED = 'nothing posted';
// An @file inside the SealKeeper home, which holds the private key.
export const keyFile = (file: string, home: string): string =>
  `refusing to read ${file}, it is inside ${home}, which holds this agent's private key`;
export const KEY_IN_TASK =
  "refusing to post, the task contains this agent's private key";
export const templateNeedsYes = (id: string): string =>
  `nothing posted. There is no terminal to ask, so run ${cli(`tasks post --template ${id}`)} again with --yes to post it`;

// The refusals of an addressed post, one line each. ref is what --for gave.
export const noAssignee = (ref: string): string =>
  `no agent ${ref}, check the handle or the agent id`;
export const sameOperator = (ref: string): string =>
  `${ref} is an agent of your own operator, and tasks between your own agents never count`;
export const assigneeCap = (ref: string): string =>
  `${ref} already has the most open tasks addressed to it, try again once it claims some`;
export const assigneeOperatorCap = (ref: string): string =>
  `${ref} already has the most open tasks from your agents, try again once it claims some`;

// The options of a post as scripts give it, each with its flag as commander
// names a missing one.
const EXPLICIT = [
  ['type', '--type <task_type>'],
  ['spec', '--spec <json>'],
  ['verify', '--verify <kind>'],
] as const;

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  return parent
    .command('post')
    .description(
      'Post a task for other agents. With no options in a terminal it walks you through it',
    )
    .option('--type <task_type>', 'task type, for example summarise')
    .option('--spec <json>', 'task spec as a JSON object, or @file')
    .option('--verify <kind>', 'hash:<sha256>, schema:@file or counterparty')
    .option(
      '--template <id>',
      `a ready made task in place of --type, --spec and --verify, one of ${TEMPLATES.map((t) => t.id).join(', ')}`,
    )
    .option(
      '--input <text>',
      'the input for --template, as text or @file, for the templates that take one',
    )
    .option('--yes', 'post a --template task without asking, for agents')
    .option(
      '--for <agent>',
      'address the task to one agent of another operator, login/name or an agent id',
    )
    .option(
      '--expires-hours <n>',
      `hours until the task expires, at most ${MAX_EXPIRES_HOURS} (default: ${TASK_DEFAULT_TTL_HOURS})`,
    )
    .action(async function (
      this: Command,
      options: PostOptions,
    ): Promise<void> {
      const given = EXPLICIT.filter(([key]) => options[key] !== undefined);
      if (options.template !== undefined) {
        if (given.length > 0) {
          this.error(
            '--template replaces --type, --spec and --verify, give one or the other',
          );
        }
        await templatePost(this, deps, options.template, options);
        return;
      }
      if (options.input !== undefined) {
        this.error('--input goes with --template');
      }
      if (options.yes === true) this.error('--yes goes with --template');
      if (given.length === 0) {
        if (wantsJson(this)) this.error(NO_OPTIONS_JSON);
        const input = (deps.stdin ?? noInput)();
        const tty = (deps.isTTY ?? stdoutIsTTY)();
        if (input.isTTY && tty) {
          await guidedPost(this, deps, input, options);
          return;
        }
        this.error(NO_TERMINAL);
      }
      const missing = EXPLICIT.find(([key]) => options[key] === undefined);
      if (missing) this.error(`required option '${missing[1]}' not specified`);
      await explicitPost(this, deps, options as ExplicitOptions);
    });
}

type ExplicitOptions = PostOptions & {
  type: string;
  spec: string;
  verify: string;
};

const stdoutIsTTY = () => process.stdout.isTTY === true;

function noInput(): Input {
  return { isTTY: false, readLine: async () => null };
}

// The post from --type, --spec and --verify, as before.
async function explicitPost(
  cmd: Command,
  deps: TasksDeps,
  options: ExplicitOptions,
): Promise<void> {
  await refuseHomeFile(cmd, options.spec);
  if (options.verify.startsWith('schema:')) {
    await refuseHomeFile(cmd, options.verify.slice('schema:'.length));
  }
  const spec = await readJsonArg(cmd, options.spec, '--spec');
  if (!isJsonObject(spec)) cmd.error('--spec must be a JSON object');
  const verification = await parseVerify(cmd, options.verify);
  const draft: Draft = {
    taskType: options.type,
    spec,
    verification,
    expiresHours: options.expiresHours,
    assignee: options.for,
  };
  await postAndPrint(cmd, deps, requestOf(cmd, draft));
}

type Draft = {
  taskType: string;
  spec: Record<string, unknown>;
  verification: VerificationSpec;
  expiresHours?: string;
  assignee?: string;
  // template for a task built from a template (VOU-134). Left out for a
  // plain post, which the API reads as manual.
  origin?: TaskOrigin;
};

// The request for a draft, validated as the API will validate it. Ends the
// command on anything the API would refuse at the edge.
function requestOf(cmd: Command, draft: Draft): PostTaskRequest {
  const expiresAt =
    draft.expiresHours === undefined
      ? undefined
      : expiresAtFrom(cmd, draft.expiresHours);
  const assignee = draft.assignee?.trim();
  if (assignee !== undefined && !AgentRef.safeParse(assignee).success) {
    cmd.error(
      `--for must be a handle login/name or an agent id, got ${assignee}`,
    );
  }
  // The id is ours, so a retried post returns the same task.
  const request = PostTaskRequest.safeParse({
    taskId: randomUUID(),
    taskType: draft.taskType,
    spec: draft.spec,
    verification: draft.verification,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(draft.origin === undefined ? {} : { origin: draft.origin }),
  });
  if (!request.success) cmd.error(z.prettifyError(request.error));
  return request.data;
}

// Signs and sends the request, then prints the task. Every way in posts
// through here.
async function postAndPrint(
  cmd: Command,
  deps: TasksDeps,
  request: PostTaskRequest,
): Promise<void> {
  // A routine run never posts (VOU-138). Posting asks for another
  // operator's time, which needs the operator's own yes.
  await refuseInRoutine(cmd, 'tasks post');
  const assignee = request.assignee;
  // Every way in ends here, so no spec, schema or input carries the key.
  await refuseKeyInTask(cmd, request);
  const { config, signer, api } = await openTaskSession(cmd, deps);
  // The API refuses these too. Said here, nothing is signed for them.
  if (assignee !== undefined && ownAgent(assignee, config, signer.agentId)) {
    cmd.error(sameOperator(assignee));
  }
  let task: TaskResponse;
  try {
    task = await api.postTask(await signer.sign(request));
  } catch (error) {
    if (error instanceof ApiError) cmd.error(postRefusal(error, assignee));
    throw error;
  }

  if (wantsJson(cmd)) {
    stdout(
      JSON.stringify({
        id: task.id,
        state: task.state,
        expiresAt: task.expiresAt,
        // The handle, as pull, show and prove print it. Left out for an
        // open task.
        ...(task.assignee ? { assignee: task.assignee.handle } : {}),
      }),
    );
    return;
  }
  // The handle as the API holds it now, else as it was given.
  const handle =
    assignee === undefined ? undefined : (task.assignee?.handle ?? assignee);
  printFields([
    ['id', task.id],
    ['state', task.state],
    ...(handle === undefined ? [] : [['for', handle] as [string, string]]),
    ['expires', task.expiresAt],
  ]);
  for (const line of postLines(task, handle)) stdout(line);
}

// --template. The template's task with --input, posted on --yes or on a yes
// in a terminal.
async function templatePost(
  cmd: Command,
  deps: TasksDeps,
  id: string,
  options: PostOptions,
): Promise<void> {
  const template = templateById(id);
  if (template === undefined) {
    cmd.error(
      `no template ${id}, pick one of ${TEMPLATES.map((t) => t.id).join(', ')}`,
    );
  }
  // Settled before anything is read or sent, so a script without --yes
  // fails at once.
  let input: Input | null = null;
  if (options.yes !== true) {
    input = (deps.stdin ?? noInput)();
    if (!input.isTTY) cmd.error(templateNeedsYes(id));
  }
  if (template.input === 'none' && options.input !== undefined) {
    cmd.error(`${id} takes no --input, it makes its own`);
  }
  if (template.input === 'required' && options.input === undefined) {
    cmd.error(`${id} needs --input, ${template.inputHint}`);
  }
  let text: string | undefined;
  if (options.input !== undefined) {
    const read = await readTextArg(options.input);
    if ('error' in read) cmd.error(read.error);
    text = read.text;
  }
  let task: TemplateTask;
  try {
    task = template.make(text);
  } catch (error) {
    if (error instanceof TemplateInputError) {
      cmd.error(`--input does not fit ${id}, ${error.message}`);
    }
    throw error;
  }
  const request = requestOf(cmd, {
    ...draftOf(task),
    expiresHours: options.expiresHours,
    assignee: options.for,
    origin: 'template',
  });
  if (input !== null) {
    // The input was checked for the key as it was read, and postAndPrint
    // checks the whole task again before signing.
    // Under --json, stdout holds only the posted task.
    const say = wantsJson(cmd) ? stderr : stdout;
    for (const line of previewLines(template, task, request)) say(line);
    if ((await askYesNo(input, 'Post it?')) !== 'yes') cmd.error(NOT_POSTED);
  }
  await postAndPrint(cmd, deps, request);
}

// Ends the command when value is @file for a file inside the SealKeeper
// home. Anything else passes.
async function refuseHomeFile(cmd: Command, value: string): Promise<void> {
  if (!value.startsWith('@')) return;
  const file = value.slice(1);
  const home = await insideHome(file);
  if (home !== null) cmd.error(keyFile(file, home));
}

// Ends the command when anything in the request holds the private key.
async function refuseKeyInTask(
  cmd: Command,
  request: PostTaskRequest,
): Promise<void> {
  if (await holdsPrivateKey(request)) cmd.error(KEY_IN_TASK);
}

const draftOf = (task: TemplateTask): Draft => ({
  taskType: task.taskType,
  spec: { ...task.spec },
  verification: task.verification,
});

// Text given inline, or @path for a file's contents. A file inside the
// SealKeeper home is never read, and text holding the private key is
// refused, since the text becomes a public spec.
async function readTextArg(
  value: string,
): Promise<{ text: string } | { error: string }> {
  if (!value.startsWith('@')) {
    return (await containsPrivateKey(value))
      ? { error: KEY_IN_TASK }
      : { text: value };
  }
  const file = value.slice(1);
  const home = await insideHome(file);
  if (home !== null) return { error: keyFile(file, home) };
  try {
    const text = await readFile(file, 'utf8');
    if (await containsPrivateKey(text)) return { error: KEY_IN_TASK };
    return { text };
  } catch (error) {
    return {
      error: `could not read the input file ${file}, ${(error as Error).message}`,
    };
  }
}

// A question on stderr, with the answer typed after it.
function ask(question: string): void {
  promptStyled(createStyle(process.stderr).line`${question} `);
}

// y or n, no by default. Asked again on anything else, up to MAX_ASKS.
async function askYesNo(input: Input, question: string): Promise<'yes' | 'no'> {
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    ask(`${asked === 0 ? '' : 'Please answer y or n. '}${question} [y/N]`);
    const answer = readYesNo(await input.readLine(), 'no');
    if (answer !== 'unclear') return answer;
  }
  return 'no';
}

// The walk through. Every question can be left with Enter, and nothing is
// posted without a yes to the last one. --for and --expires-hours, when
// given, stand in for the question about the assignee and the default
// expiry, and --for is checked before any question. why is false when the
// caller, prove, already said why to post.
export async function guidedPost(
  cmd: Command,
  deps: TasksDeps,
  input: Input,
  options: Pick<PostOptions, 'expiresHours' | 'for'> = {},
  why = true,
): Promise<void> {
  const config = await requireConfig(cmd);
  const given = options.for?.trim();
  if (given !== undefined) {
    if (!AgentRef.safeParse(given).success) {
      cmd.error(
        `--for must be a handle login/name or an agent id, got ${given}`,
      );
    }
    if (ownAgent(given, config, config.agentId)) cmd.error(sameOperator(given));
  }
  stdout('');
  stdout('Post a task for other agents to solve.');
  if (why) stdout(POST_WHY);
  stdout('');
  const width = Math.max(...TEMPLATES.map((t) => t.id.length));
  const kinds = Math.max(...TEMPLATES.map((t) => t.kind.length));
  TEMPLATES.forEach((t, i) => {
    stdout(
      `${String(i + 1).padStart(2)}  ${t.id.padEnd(width)}  ${t.kind.padEnd(kinds)}  ${t.about}`,
    );
  });
  stdout('');

  const template = await askTemplate(input);
  const task = template === null ? null : await askTask(input, template);
  const assignee =
    task === null
      ? null
      : given !== undefined
        ? given
        : await askAssignee(input, config);
  if (template === null || task === null || assignee === null) {
    stdout(NOTHING_POSTED);
    return;
  }
  const request = requestOf(cmd, {
    ...draftOf(task),
    expiresHours: options.expiresHours,
    ...(assignee === '' ? {} : { assignee }),
    origin: 'template',
  });
  for (const line of previewLines(template, task, request)) stdout(line);
  if ((await askYesNo(input, 'Post it?')) !== 'yes') {
    stdout(NOTHING_POSTED);
    return;
  }
  await postAndPrint(cmd, deps, request);
}

// The template by number or id. null on Enter, a closed input or
// MAX_ASKS answers that name none.
async function askTemplate(input: Input): Promise<Template | null> {
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    ask(
      `${asked === 0 ? '' : 'Please answer with a number from the list. '}Pick a task, 1 to ${TEMPLATES.length}, or press Enter to stop:`,
    );
    const answer = (await input.readLine())?.trim();
    if (answer === undefined || answer === '') return null;
    const chosen = /^\d+$/.test(answer)
      ? TEMPLATES[Number(answer) - 1]
      : templateById(answer);
    if (chosen !== undefined) return chosen;
  }
  return null;
}

// The template's task, with the operator's input when it takes one. null
// when the operator stops or no input fits after MAX_ASKS tries.
async function askTask(
  input: Input,
  template: Template,
): Promise<TemplateTask | null> {
  if (template.input === 'none') return template.make(undefined);
  const hint = template.inputHint ?? 'the input';
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    ask(
      template.input === 'optional'
        ? `Your own input, ${hint}, as text or @ and a file path, or press Enter to have one made for you:`
        : `Your input, ${hint}, as text or @ and a file path, or press Enter to stop:`,
    );
    const answer = await input.readLine();
    if (answer === null) return null;
    const value = answer.trim();
    if (value === '') {
      return template.input === 'optional' ? template.make(undefined) : null;
    }
    const read = await readTextArg(value);
    if ('error' in read) {
      stdout(`${read.error}.`);
      continue;
    }
    try {
      return template.make(read.text);
    } catch (error) {
      if (!(error instanceof TemplateInputError)) throw error;
      stdout(`That input does not fit, ${error.message}.`);
    }
  }
  return null;
}

// A handle or agent id of another operator's agent, '' for any agent, null
// when the input closed or no answer fits after MAX_ASKS tries.
async function askAssignee(
  input: Input,
  config: { operatorLogin: string; agentId: string },
): Promise<string | null> {
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    ask(
      'Only for one agent of another operator? Give its login/name or agent id, or press Enter for any agent:',
    );
    const answer = await input.readLine();
    if (answer === null) return null;
    const ref = answer.trim();
    if (ref === '') return '';
    if (!AgentRef.safeParse(ref).success) {
      stdout(`${ref} is not a handle login/name or an agent id.`);
      continue;
    }
    if (ownAgent(ref, config, config.agentId)) {
      stdout(`${sameOperator(ref)}.`);
      continue;
    }
    return ref;
  }
  return null;
}

const CHECKS: Record<Template['kind'], string> = {
  hash: 'hash, SealKeeper checks the answer on submit',
  schema: 'schema, SealKeeper checks the answer on submit',
  counterparty: 'counterparty, you confirm or reject the answer',
};

// What will be posted, for the operator to read before saying yes. The
// spec in full, who can claim it, when it expires and who checks it.
export function previewLines(
  template: Template,
  task: TemplateTask,
  request: PostTaskRequest,
  now: number = Date.now(),
): string[] {
  const hours =
    request.expiresAt === undefined
      ? TASK_DEFAULT_TTL_HOURS
      : Math.round((Date.parse(request.expiresAt) - now) / 3_600_000);
  const lines = [
    '',
    `type     ${task.taskType}`,
    `check    ${CHECKS[template.kind]}`,
    `for      ${request.assignee ?? 'any agent of another operator'}`,
    `expires  in ${hours} hour${hours === 1 ? '' : 's'}`,
    'spec',
    ...JSON.stringify(task.spec, null, 2)
      .split('\n')
      .map((line) => `  ${line}`),
  ];
  if (task.verification.kind === 'hash') {
    lines.push(
      'The sha256 of the right answer was computed here from this input. The answer itself is never sent.',
    );
  } else if (task.verification.kind === 'schema') {
    lines.push(
      'The schema pins every value. Other agents see it without the values.',
    );
  } else {
    lines.push(
      `You judge the answer. Once it is submitted, run ${cli('tasks outcome <id> success')} or failure.`,
    );
  }
  lines.push(
    'The spec is public on sealkeeper.run, so it must hold nothing private.',
    '',
  );
  return lines;
}

// What happens next. Who can claim an addressed task and how it finds it,
// and for a counterparty task that the poster gives the verdict.
export function postLines(
  task: TaskResponse,
  handle: string | undefined,
): string[] {
  const lines: string[] = [];
  if (handle !== undefined) {
    lines.push(
      `Only ${handle} can claim this task. It sees it in ${cli('prove')} and ${cli('status')}, and claims it with ${cli('tasks pull --addressed')}.`,
    );
  }
  if (task.verification.kind === 'counterparty') {
    lines.push(
      `You judge the result. Once it is submitted, run ${cli(`tasks outcome ${task.id} success`)} or failure.`,
    );
  }
  return lines;
}

// True when ref names this agent, by id, or any agent of its operator, by a
// handle with the operator's login. Logins ignore case, as on GitHub. The
// login is the one saved in config.json at init, so after a GitHub rename
// this check misses and the API's same_operator refusal still catches it.
function ownAgent(
  ref: string,
  config: { operatorLogin: string },
  agentId: string,
): boolean {
  if (ref === agentId) return true;
  const slash = ref.indexOf('/');
  return (
    slash !== -1 &&
    ref.slice(0, slash).toLowerCase() === config.operatorLogin.toLowerCase()
  );
}

// One line per refusal of the post route. The assignee codes name what
// --for gave. Everything else is the shared refusal.
export function postRefusal(
  error: ApiError,
  assignee: string | undefined,
): string {
  if (assignee !== undefined) {
    switch (error.code) {
      case 'not_found':
        return noAssignee(assignee);
      case 'same_operator':
        return sameOperator(assignee);
      case 'assignee_cap':
        return assigneeCap(assignee);
      case 'assignee_operator_cap':
        return assigneeOperatorCap(assignee);
    }
  }
  return refusal(error);
}

async function parseVerify(
  cmd: Command,
  value: string,
): Promise<VerificationSpec> {
  if (value === 'counterparty') return { kind: 'counterparty' };
  if (value.startsWith('hash:')) {
    const sha256 = value.slice('hash:'.length).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      cmd.error('--verify hash: needs a sha256 as 64 hex characters');
    }
    return { kind: 'hash', sha256 };
  }
  if (value.startsWith('schema:')) {
    const jsonSchema = await readJsonArg(
      cmd,
      value.slice('schema:'.length),
      'schema',
    );
    if (!isJsonObject(jsonSchema))
      cmd.error('the schema must be a JSON object');
    return { kind: 'schema', jsonSchema };
  }
  cmd.error(
    `--verify must be hash:<sha256>, schema:@file or counterparty, got ${value}`,
  );
}

function expiresAtFrom(cmd: Command, hours: string): string {
  const n = Number(hours);
  if (!/^\d+(\.\d+)?$/.test(hours.trim()) || n <= 0 || n > MAX_EXPIRES_HOURS) {
    cmd.error(
      `--expires-hours must be a number above 0 and at most ${MAX_EXPIRES_HOURS}, got ${hours}`,
    );
  }
  return new Date(Date.now() + n * 3_600_000).toISOString();
}
