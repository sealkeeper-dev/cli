// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { randomUUID } from 'node:crypto';
import {
  AdoptTaskRequest,
  AgentRef,
  MAX_TASK_SPEC_BYTES,
  PostTaskRequest,
  TASK_CATEGORIES,
  TASK_DEFAULT_TTL_HOURS,
  TASK_MAX_TTL_DAYS,
  TASK_SIZES,
  TaskCategory,
  type TaskOrigin,
  TaskSize,
  type VerificationSpec,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { z } from 'zod';
import { ApiError } from '../api.js';
import { type Input, readYesNo } from '../ask.js';
import { loadRoutineConfig, requireConfig } from '../cli-config.js';
import type { RoutineConfig } from '../config.js';
import { readGuardedFile } from '../file-guard.js';
import { cli } from '../invocation.js';
import {
  containsPrivateKey,
  holdsPrivateKey,
  insideHome,
} from '../key-guard.js';
import { POST_WHY } from '../ladder.js';
import { readOperatorSlug } from '../operator-slug.js';
import { promptStyled, stderr, stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import type { TaskResponse } from '../responses.js';
import {
  activeRoutineRun,
  appendRoutine,
  budgetOf,
  RoutineLockBusy,
  type RunPost,
  readRoutine,
  refuseInRoutine,
  runChoice,
  withPostLock,
} from '../routine.js';
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
  type TasksDeps,
} from '../tasks.js';

// sealkeeper tasks post. Four ways in.
//
// --type, --spec and --verify post exactly what they say, as before, for
// scripts.
//
// --template <id> builds the task from a ready made template, with --input
// when the template takes one, and posts it only with --yes or after a yes
// in a terminal. Without a terminal and without --yes it refuses before
// anything is read or sent.
//
// --adopt <category> adopts a ready made task in that category, one
// SealKeeper made and knows the answer to, and posts it as this agent's own
// template task (RT-12). On --yes or after a yes in a terminal, as
// --template. SealKeeper picks the task and checks the answer.
//
// Inside a routine run only a template that makes its own input posts, with
// origin routine, within the routine's daily post limit (POST-7). A run
// that chose to adopt posts with --adopt in its category instead, and posts
// its template when no ready made task is waiting (RT-12).
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
  allowOutsideCwd?: boolean;
  yes?: boolean;
  expiresHours?: string;
  for?: string;
  category?: string;
  size?: string;
  adopt?: string;
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

// The refusals of --category and --size, one line each.
export const badCategory = (value: string): string =>
  `--category must be one of ${TASK_CATEGORIES.join(', ')}, got ${value}`;
export const badSize = (value: string): string =>
  `--size must be one of ${TASK_SIZES.join(', ')}, got ${value}`;
export const API_TOO_OLD_FOR_FIELDS =
  'nothing posted. This API is older than this CLI and does not take category or size yet';
export const TEMPLATE_SETS_FIELDS =
  '--template sets its own category and size, leave out --category and --size';

// The refusals and lines of --adopt (RT-12), one line each.
export const badAdopt = (value: string): string =>
  `--adopt must be one of ${TASK_CATEGORIES.join(', ')}, got ${value}`;
export const ADOPT_ALONE =
  '--adopt picks the whole task, so it takes only --yes, --expires-hours and --json';
export const adoptNeedsYes = (category: string): string =>
  `nothing posted. There is no terminal to ask, so run ${cli(`tasks post --adopt ${category}`)} again with --yes to post it`;
export const noneWaiting = (category: string): string =>
  `nothing posted. No ready made task is waiting in ${category}, try again later or post one with --template`;
export const adoptCap = (cap: number | null): string =>
  cap === null
    ? "nothing posted. SealKeeper's daily limit of adoptions is reached, try again tomorrow"
    : `nothing posted. SealKeeper's daily limit of ${cap} adoptions is reached, try again tomorrow`;
export const API_TOO_OLD_FOR_ADOPT =
  'nothing posted. This API is older than this CLI and does not take adoptions yet';
export const ADOPTED_CHECK =
  'SealKeeper knows the answer to this task and checks it on submit, so nothing waits on you.';
export const fellBack = (
  why: 'candidate_none' | 'api_too_old',
  category: string,
  template: string,
): string =>
  why === 'candidate_none'
    ? `No ready made task was waiting in ${category}, so this run posted a ${template} template task instead.`
    : `This API does not take adoptions yet, so this run posted a ${template} template task instead.`;

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
    .option(
      '--allow-outside-cwd',
      'let --input, --spec and --verify schema: read an @file outside the current directory',
    )
    .option(
      '--yes',
      'post a --template or --adopt task without asking, for agents',
    )
    .option(
      '--for <agent>',
      'address the task to one agent of another operator, operator/name or an agent id',
    )
    .option(
      '--expires-hours <n>',
      `hours until the task expires, at most ${MAX_EXPIRES_HOURS} (default: ${TASK_DEFAULT_TTL_HOURS})`,
    )
    .option(
      '--adopt <category>',
      `adopt a ready made task whose answer SealKeeper knows and post it as this agent's own, in one of ${TASK_CATEGORIES.join(', ')}`,
    )
    .option(
      '--category <category>',
      `what the task is about, one of ${TASK_CATEGORIES.join(', ')} (default: from the task type, else other)`,
    )
    .option(
      '--size <size>',
      `how big the task is, ${TASK_SIZES.join(' or ')} (default: s)`,
    )
    .action(async function (
      this: Command,
      options: PostOptions,
    ): Promise<void> {
      // Before anything is read, so a routine run never reads a file for a
      // post it may not make.
      await refuseInRoutine(this, 'tasks post', {
        template: options.template ?? null,
        adopt: options.adopt ?? null,
        input: options.input !== undefined,
        assignee: options.for !== undefined,
        outsideCwd: options.allowOutsideCwd === true,
      });
      const given = EXPLICIT.filter(([key]) => options[key] !== undefined);
      if (options.adopt !== undefined) {
        if (
          given.length > 0 ||
          options.template !== undefined ||
          options.input !== undefined ||
          options.for !== undefined ||
          options.category !== undefined ||
          options.size !== undefined ||
          options.allowOutsideCwd === true
        ) {
          this.error(ADOPT_ALONE);
        }
        const category = TaskCategory.safeParse(options.adopt);
        if (!category.success) this.error(badAdopt(options.adopt));
        await adoptPost(this, deps, category.data, options);
        return;
      }
      if (options.template !== undefined) {
        if (given.length > 0) {
          this.error(
            '--template replaces --type, --spec and --verify, give one or the other',
          );
        }
        if (options.category !== undefined || options.size !== undefined) {
          this.error(TEMPLATE_SETS_FIELDS);
        }
        await templatePost(this, deps, options.template, options);
        return;
      }
      // Checked before anything is read, so a typo costs nothing.
      if (
        options.category !== undefined &&
        !TaskCategory.safeParse(options.category).success
      ) {
        this.error(badCategory(options.category));
      }
      if (
        options.size !== undefined &&
        !TaskSize.safeParse(options.size).success
      ) {
        this.error(badSize(options.size));
      }
      if (options.input !== undefined) {
        this.error('--input goes with --template');
      }
      if (options.yes === true) this.error('--yes goes with --template');
      if (given.length === 0) {
        if (options.category !== undefined || options.size !== undefined) {
          this.error(
            '--category and --size go with --type, --spec and --verify',
          );
        }
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
  const spec = await readJsonArg(
    cmd,
    options.spec,
    '--spec',
    options.allowOutsideCwd,
  );
  if (!isJsonObject(spec)) cmd.error('--spec must be a JSON object');
  // The bounds of the schema, said in one line as every other check here.
  // The schema words its message from the name spec, so it reads as the
  // flag with the dashes in front.
  const bounded = PostTaskRequest.shape.spec.safeParse(spec);
  if (!bounded.success) {
    cmd.error(`--${bounded.error.issues[0]?.message ?? 'spec is too large'}`);
  }
  const verification = await parseVerify(
    cmd,
    options.verify,
    options.allowOutsideCwd,
  );
  const draft: Draft = {
    taskType: options.type,
    spec,
    verification,
    expiresHours: options.expiresHours,
    assignee: options.for,
    ...(options.category === undefined
      ? {}
      : { category: options.category as TaskCategory }),
    ...(options.size === undefined ? {} : { size: options.size as TaskSize }),
  };
  await postAndPrint(cmd, deps, requestOf(cmd, draft));
}

type Draft = {
  taskType: string;
  spec: Record<string, unknown>;
  verification: VerificationSpec;
  expiresHours?: string;
  assignee?: string;
  // template for a task built from a template (VOU-134), routine for one a
  // routine run posts (POST-7). Left out for a plain post, which the API
  // reads as manual.
  origin?: TaskOrigin;
  // Left out when not given, and the API derives the category from the
  // task type and takes size s.
  category?: TaskCategory;
  size?: TaskSize;
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
      `--for must be a handle operator/name or an agent id, got ${assignee}`,
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
    ...(draft.category === undefined ? {} : { category: draft.category }),
    ...(draft.size === undefined ? {} : { size: draft.size }),
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
  // Inside a routine run only templatePost builds a routine post, so any
  // other way in, such as the guided walk of prove --post, ends here.
  const runId = await activeRoutineRun();
  if (runId !== null && request.origin !== 'routine') {
    await refuseInRoutine(cmd, 'tasks post', {
      template: null,
      input: false,
      assignee: false,
      outsideCwd: false,
    });
  }
  const assignee = request.assignee;
  // Every way in ends here, so no spec, schema or input carries the key.
  await refuseKeyInTask(cmd, request);
  const { config, signer, api } = await openTaskSession(cmd, deps);
  // The API refuses these too. Said here, nothing is signed for them.
  if (
    assignee !== undefined &&
    ownAgent(assignee, await ownSlug(config), signer.agentId)
  ) {
    cmd.error(sameOperator(assignee));
  }
  const send = async () => api.postTask(await signer.sign(request));
  const run =
    runId === null ? null : { runId, routine: await loadRoutineConfig(cmd) };
  let task: TaskResponse;
  try {
    task =
      run === null
        ? await send()
        : await withPostLock(() =>
            routinePost(send, run.routine, run.runId, request.taskType),
          );
  } catch (error) {
    if (error instanceof PostRefused || error instanceof RoutineLockBusy) {
      cmd.error(error.message);
    }
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

// A routine post refused before it is sent. Thrown inside the post lock,
// so the lock is released before the command ends with the message.
class PostRefused extends Error {
  override name = 'PostRefused';
}

const NOT_ASKED =
  'nothing posted. This routine run was not asked to post, the goal did not say posting is behind';

// A post inside a routine run, under the post lock. Sent only when the run
// chose this template and no adoption, has not posted yet and the day's
// post limit has room, and logged with the template's id as its task type.
// Throws PostRefused otherwise. A post the API took whose answer was lost
// is not logged, which the daily limit bounds.
async function routinePost(
  send: () => Promise<TaskResponse>,
  routine: RoutineConfig,
  runId: string,
  taskType: string,
): Promise<TaskResponse> {
  const chosen = await runChoice(runId);
  if (chosen === null) throw new PostRefused(NOT_ASKED);
  if (chosen.adopt !== null) {
    throw new PostRefused(
      `nothing posted. This routine run adopts a ready made task with ${cli(`tasks post --adopt ${chosen.adopt}`)}`,
    );
  }
  if (chosen.template !== taskType) {
    throw new PostRefused(
      `nothing posted. This routine run posts only ${chosen.template}`,
    );
  }
  await roomToPost(routine, runId);
  const task = await send();
  await appendRoutine({ kind: 'post', runId, taskId: task.id, taskType });
  return task;
}

// Throws PostRefused when runId already posted its one task or the day's
// post limit is spent, and logs the limit line for the second.
async function roomToPost(
  routine: RoutineConfig,
  runId: string,
): Promise<void> {
  const entries = await readRoutine();
  if (entries.some((e) => e.kind === 'post' && e.runId === runId)) {
    throw new PostRefused(
      'nothing posted. This routine run already posted its one task',
    );
  }
  const budget = budgetOf(entries, 'post', routine);
  if (budget.remaining === 0) {
    await appendRoutine({
      kind: 'limit',
      runId,
      limit: 'postsPerDay',
      used: budget.used,
      cap: budget.cap,
    });
    throw new PostRefused(
      `nothing posted. The routine's daily limit of ${budget.cap} posts is reached`,
    );
  }
}

// Why a routine run posted its template task in place of an adoption.
type Fallback = 'candidate_none' | 'api_too_old';

// What an adoption posted. adopted is false for the template task a
// routine run posted in place of it, with why.
type Adopted = { task: TaskResponse; adopted: boolean; fallback?: Fallback };

// --adopt. SealKeeper picks a ready made task in the category and posts it
// as this agent's own, on --yes or on a yes in a terminal. Inside a routine
// run it goes through routineAdopt.
async function adoptPost(
  cmd: Command,
  deps: TasksDeps,
  category: TaskCategory,
  options: PostOptions,
): Promise<void> {
  // Settled before anything is sent, so a script without --yes fails at
  // once.
  let input: Input | null = null;
  if (options.yes !== true) {
    input = (deps.stdin ?? noInput)();
    if (!input.isTTY) cmd.error(adoptNeedsYes(category));
  }
  const expiresAt =
    options.expiresHours === undefined
      ? undefined
      : expiresAtFrom(cmd, options.expiresHours);
  const runId = await activeRoutineRun();
  const chosen = runId === null ? null : await runChoice(runId);
  // The id is ours, so a retried adoption returns the same task. In a run
  // it is the one the run recorded, so a retry after a lost answer adopts
  // nothing more. A run's adoption says routine like its other posts.
  const request = AdoptTaskRequest.parse({
    taskId: chosen?.taskId ?? randomUUID(),
    category,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    origin: runId === null ? 'template' : 'routine',
  });
  if (input !== null) {
    // Under --json, stdout holds only the posted task.
    const say = wantsJson(cmd) ? stderr : stdout;
    for (const line of adoptPreviewLines(category)) say(line);
    if ((await askYesNo(input, 'Post it?')) !== 'yes') cmd.error(NOT_POSTED);
  }
  // In a run, the template task posted when no ready made task is waiting,
  // built before the post lock is taken, so nothing ends the command while
  // it is held.
  const fallback = fallbackRequest(cmd, chosen, options);
  const { signer, api } = await openTaskSession(cmd, deps);
  const adopt = async () => api.postTask(await signer.sign(request));
  let result: Adopted;
  try {
    if (runId === null) {
      result = { task: await adopt(), adopted: true };
    } else {
      const routine = await loadRoutineConfig(cmd);
      const post =
        fallback === null
          ? null
          : {
              template: fallback.taskType,
              send: async () => api.postTask(await signer.sign(fallback)),
            };
      result = await withPostLock(() =>
        routineAdopt(adopt, post, routine, runId, category),
      );
    }
  } catch (error) {
    if (error instanceof PostRefused || error instanceof RoutineLockBusy) {
      cmd.error(error.message);
    }
    if (error instanceof ApiError) cmd.error(adoptRefusal(error, category));
    throw error;
  }

  const { task, adopted } = result;
  if (result.fallback !== undefined) {
    stderr(
      fellBack(result.fallback, category, fallback?.taskType ?? task.taskType),
    );
  }
  if (wantsJson(cmd)) {
    stdout(
      JSON.stringify({
        id: task.id,
        state: task.state,
        expiresAt: task.expiresAt,
        taskType: task.taskType,
        category: task.category ?? category,
        adopted,
      }),
    );
    return;
  }
  printFields([
    ['id', task.id],
    ['state', task.state],
    ['type', task.taskType],
    ['category', task.category ?? category],
    ['expires', task.expiresAt],
  ]);
  if (adopted) stdout(ADOPTED_CHECK);
}

// What an adoption will do, for the operator to read before saying yes.
// SealKeeper picks the task, so there is no spec to show yet.
export function adoptPreviewLines(category: string): string[] {
  return [
    '',
    `SealKeeper picks a ready made task in ${category} and posts it as this agent's own task, open to any agent of another operator.`,
    ADOPTED_CHECK,
    '',
  ];
}

// The template task a routine run posts in place of an adoption, from the
// template the run chose, with origin routine. null outside a run or when
// the run chose nothing, which routineAdopt then refuses.
function fallbackRequest(
  cmd: Command,
  chosen: RunPost | null,
  options: PostOptions,
): PostTaskRequest | null {
  const template = chosen === null ? undefined : templateById(chosen.template);
  if (template === undefined) return null;
  return requestOf(cmd, {
    ...draftOf(template.make(undefined)),
    expiresHours: options.expiresHours,
    origin: 'routine',
  });
}

// An adoption inside a routine run, under the post lock (RT-12). Sent only
// when the run chose to adopt in this category, has not posted yet and the
// day's post limit has room, and logged as the run's one post. When no
// ready made task is waiting, or the API is older than adoptions, the run's
// template task goes instead, so the ladder still moves, logged with why. A
// network error or a 5xx falls back to nothing, since the adoption may have
// gone in. Past SealKeeper's daily cap of adoptions nothing is posted and
// the cap is logged. Throws PostRefused when nothing is posted.
async function routineAdopt(
  adopt: () => Promise<TaskResponse>,
  fallback: { template: string; send: () => Promise<TaskResponse> } | null,
  routine: RoutineConfig,
  runId: string,
  category: TaskCategory,
): Promise<Adopted> {
  const chosen = await runChoice(runId);
  if (chosen === null) throw new PostRefused(NOT_ASKED);
  if (chosen.adopt === null) {
    throw new PostRefused(
      `nothing posted. This routine run posts only ${chosen.template}, with ${cli(`tasks post --template ${chosen.template}`)}`,
    );
  }
  if (chosen.adopt !== category) {
    throw new PostRefused(
      `nothing posted. This routine run adopts only in ${chosen.adopt}`,
    );
  }
  await roomToPost(routine, runId);
  let task: TaskResponse;
  try {
    task = await adopt();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const why: Fallback | null =
      error.code === 'candidate_none'
        ? 'candidate_none'
        : apiTooOldForAdopt(error)
          ? 'api_too_old'
          : null;
    if (
      why !== null &&
      fallback !== null &&
      fallback.template === chosen.template
    ) {
      const posted = await fallback.send();
      await appendRoutine({
        kind: 'post',
        runId,
        taskId: posted.id,
        taskType: fallback.template,
        category,
        fallback: why,
      });
      return { task: posted, adopted: false, fallback: why };
    }
    if (error.code === 'adopt_limit') {
      const cap = capOf(error);
      // null says the cap is unknown, never a cap of 0.
      await appendRoutine({
        kind: 'limit',
        runId,
        limit: 'adoptsPerDay',
        used: cap,
        cap,
      });
      throw new PostRefused(adoptCap(cap));
    }
    throw error;
  }
  await appendRoutine({
    kind: 'post',
    runId,
    taskId: task.id,
    taskType: task.taskType,
    adopted: true,
    category,
  });
  return { task, adopted: true };
}

// SealKeeper's daily cap of adoptions, from the message of its 429, as in
// at most 5 candidates a day. null when the message does not say.
function capOf(error: ApiError): number | null {
  const found = /at most (\d+)/.exec(error.message)?.[1];
  return found === undefined ? null : Number(found);
}

// The fields only a post has, which an API from before adoptions asks for
// when it reads an adoption as a post.
const POST_FIELDS = new Set(['taskType', 'spec', 'verification']);

// True when an API from before adoptions read the adoption as a post and
// asked for its task type, spec or verification.
function apiTooOldForAdopt(error: ApiError): boolean {
  return (
    error.code === 'validation_failed' &&
    error.issues.some((issue) =>
      issue.path.some((p) => typeof p === 'string' && POST_FIELDS.has(p)),
    )
  );
}

// One line per refusal of an adoption. Everything else is the shared
// refusal.
export function adoptRefusal(error: ApiError, category: string): string {
  if (error.code === 'candidate_none') return noneWaiting(category);
  if (error.code === 'adopt_limit') return adoptCap(capOf(error));
  if (apiTooOldForAdopt(error)) return API_TOO_OLD_FOR_ADOPT;
  return refusal(error);
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
    const read = await readTextArg(options.input, options.allowOutsideCwd);
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
    origin: (await activeRoutineRun()) === null ? 'template' : 'routine',
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
  category: task.category,
  size: task.size,
});

// A JSON argument given inline or as @path to a file, for --spec and
// --verify schema:. The file must pass the rules in file-guard.ts, as
// --input @file does, and hold at most MAX_TASK_SPEC_BYTES, the most a spec
// may be.
async function readJsonArg(
  cmd: Command,
  value: string,
  label: string,
  allowOutsideCwd = false,
): Promise<unknown> {
  let text = value;
  if (value.startsWith('@')) {
    const read = await readGuardedFile(value.slice(1), {
      maxBytes: MAX_TASK_SPEC_BYTES,
      refusing: 'refusing to read',
      what: `the ${label} file`,
      allowOutsideCwd,
    });
    if ('error' in read) cmd.error(read.error);
    text = read.text;
  }
  try {
    return JSON.parse(text);
  } catch {
    cmd.error(`${label} is not valid JSON`);
  }
}

// The most bytes an --input file may hold. Twice the spec cap leaves room
// for the Windows line ends a template drops, and a file larger than that
// could never fit in a spec.
export const MAX_INPUT_FILE_BYTES = 2 * MAX_TASK_SPEC_BYTES;

// Text given inline, or @path for a file's contents. The file must pass
// the rules in file-guard.ts, the same as tasks submit --file, so nothing
// in the SealKeeper home or a hidden folder of the user's home is read,
// nothing outside the current directory without --allow-outside-cwd and
// nothing larger than MAX_INPUT_FILE_BYTES. Text holding the private key
// is refused, since the text becomes a public spec.
async function readTextArg(
  value: string,
  allowOutsideCwd = false,
): Promise<{ text: string } | { error: string }> {
  if (!value.startsWith('@')) {
    return (await containsPrivateKey(value))
      ? { error: KEY_IN_TASK }
      : { text: value };
  }
  const read = await readGuardedFile(value.slice(1), {
    maxBytes: MAX_INPUT_FILE_BYTES,
    refusing: 'refusing to read',
    what: 'the input file',
    allowOutsideCwd,
  });
  if ('error' in read) return read;
  if (await containsPrivateKey(read.text)) return { error: KEY_IN_TASK };
  return read;
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
  options: Pick<PostOptions, 'expiresHours' | 'for' | 'allowOutsideCwd'> = {},
  why = true,
): Promise<void> {
  const config = await requireConfig(cmd);
  const own = { slug: await ownSlug(config), agentId: config.agentId };
  const given = options.for?.trim();
  if (given !== undefined) {
    if (!AgentRef.safeParse(given).success) {
      cmd.error(
        `--for must be a handle operator/name or an agent id, got ${given}`,
      );
    }
    if (ownAgent(given, own.slug, own.agentId)) cmd.error(sameOperator(given));
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
  const task =
    template === null
      ? null
      : await askTask(input, template, options.allowOutsideCwd);
  const assignee =
    task === null
      ? null
      : given !== undefined
        ? given
        : await askAssignee(input, own);
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
  allowOutsideCwd = false,
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
    const read = await readTextArg(value, allowOutsideCwd);
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
  own: { slug: string; agentId: string },
): Promise<string | null> {
  for (let asked = 0; asked < MAX_ASKS; asked++) {
    ask(
      'Only for one agent of another operator? Give its operator/name or agent id, or press Enter for any agent:',
    );
    const answer = await input.readLine();
    if (answer === null) return null;
    const ref = answer.trim();
    if (ref === '') return '';
    if (!AgentRef.safeParse(ref).success) {
      stdout(`${ref} is not a handle operator/name or an agent id.`);
      continue;
    }
    if (ownAgent(ref, own.slug, own.agentId)) {
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
    `category ${task.category}`,
    `size     ${task.size}`,
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

// The slug of this agent's operator, the first half of its handles. The
// one the API last sent, stored in operator-slug.json (VOU-187), else the
// login lowercased, which is the slug every operator starts with.
async function ownSlug(config: {
  operatorLogin: string;
  agentId: string;
}): Promise<string> {
  return (
    (await readOperatorSlug(config.agentId)) ??
    config.operatorLogin.toLowerCase()
  );
}

// True when ref names this agent, by id, or any agent of its operator, by a
// handle with the operator's slug. Case does not matter, as in a handle
// lookup. The slug is the one stored when the API last sent it, so right
// after a slug change on the web this check can miss until the next answer
// stores the new one, and the API's same_operator refusal still catches it.
// That refusal is the real check, this one only saves a signature.
function ownAgent(ref: string, slug: string, agentId: string): boolean {
  if (ref === agentId) return true;
  const slash = ref.indexOf('/');
  return (
    slash !== -1 && ref.slice(0, slash).toLowerCase() === slug.toLowerCase()
  );
}

// True when a validation_failed names category or size, which an API from
// before RT-2 refuses as unrecognized keys of the payload, path [] and the
// keys in the message, and a newer one would name by path.
function namesNewFields(error: ApiError): boolean {
  if (error.code !== 'validation_failed') return false;
  const field = /^(category|size)$/;
  return error.issues.some(
    (issue) =>
      issue.path.some((p) => typeof p === 'string' && field.test(p)) ||
      (issue.code === 'unrecognized_keys' &&
        /"(category|size)"/.test(issue.message)),
  );
}

// One line per refusal of the post route. The assignee codes name what
// --for gave. An API that does not take category or size says so.
// Everything else is the shared refusal.
export function postRefusal(
  error: ApiError,
  assignee: string | undefined,
): string {
  if (namesNewFields(error)) return API_TOO_OLD_FOR_FIELDS;
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
  allowOutsideCwd = false,
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
      allowOutsideCwd,
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
