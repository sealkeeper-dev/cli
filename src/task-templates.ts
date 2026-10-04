// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, randomInt } from 'node:crypto';
import {
  SUMMARISE_MIN_INPUT_WORDS,
  solveTemplate,
  TASK_TEMPLATES,
  type TaskCategory,
  type TaskDifficulty,
  type TaskSize,
  type TaskTemplateId,
  TEMPLATE_MAX_INPUT_CHARS,
  type TemplateDraft,
  type TemplateDraw,
  type TemplateInput,
  TemplateInputError,
  type TemplateKind,
  type TemplateSpec,
} from '@sealkeeper/schema';

// Ready made tasks for post, so an operator can post one for other
// agents without writing a spec. The templates and their answers live in
// @sealkeeper/schema, where the server's taker solves the same tasks, so
// the answer hashed here and the answer the server computes are the same
// bytes. This module adds what the operator reads, the random draw and the
// sha256 of what solveTemplate returns. The answer is never sent.

export type { TemplateInput, TemplateKind, TemplateSpec };
export { TemplateInputError };

export type TemplateVerification =
  | { kind: 'hash'; sha256: string }
  | { kind: 'schema'; jsonSchema: Record<string, unknown> }
  | { kind: 'counterparty' };

export type TemplateTask = {
  taskType: string;
  spec: TemplateSpec;
  verification: TemplateVerification;
  // The template's category, size and difficulty, which its post carries
  // (RT-2, D-TS-3).
  category: TaskCategory;
  size: TaskSize;
  difficulty: TaskDifficulty;
  // The answer that passes, for hash and schema tasks. For tests and the
  // poster's own preview only, never part of the task.
  answer?: string;
};

// A whole number from lo to hi, both included. Tests pass their own.
export type Draw = TemplateDraw;
export const cryptoDraw: Draw = (lo, hi) => randomInt(lo, hi + 1);

export type Template = {
  id: string;
  kind: TemplateKind;
  category: TaskCategory;
  size: TaskSize;
  difficulty: TaskDifficulty;
  // One line on what the task asks and who checks it.
  about: string;
  input: TemplateInput;
  // What the operator's input is, for the prompt and --help.
  inputHint?: string;
  make(input?: string, draw?: Draw): TemplateTask;
};

// Operator input is at most this many characters, well inside the spec cap.
export const MAX_INPUT_CHARS = TEMPLATE_MAX_INPUT_CHARS;

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const LINES_HINT = 'text with one item per line, @file for more than one line';

// What the operator reads for each template.
const WORDING: Record<TaskTemplateId, { about: string; inputHint?: string }> = {
  text_dedupe: {
    about: 'Remove duplicate lines from a text. SealKeeper checks the answer.',
    inputHint: `${LINES_HINT}, some lines repeated`,
  },
  line_sort: {
    about: 'Sort the lines of a text. SealKeeper checks the answer.',
    inputHint: LINES_HINT,
  },
  json_shape: {
    about:
      'Turn a sentence into a JSON object. SealKeeper checks it against a schema.',
  },
  summarise: {
    about: 'Summarise a text you give. You judge the summary.',
    inputHint: `the text to summarise, at least ${SUMMARISE_MIN_INPUT_WORDS} words, nothing private`,
  },
  answer_question: {
    about: 'Answer a question you know the answer to. You judge the answer.',
    inputHint: 'one question whose answer you know, nothing private',
  },
};

// The made task with its answer, and for a hash task the sha256 of that
// answer, both from solveTemplate.
function withAnswer(
  draft: TemplateDraft,
  fields: Pick<TemplateTask, 'category' | 'size' | 'difficulty'>,
): TemplateTask {
  const { taskType, spec, verification } = draft;
  if (verification.kind === 'counterparty') {
    return { taskType, spec, verification, ...fields };
  }
  const answer = solveTemplate(taskType, spec);
  return {
    taskType,
    spec,
    ...fields,
    verification:
      verification.kind === 'hash'
        ? { kind: 'hash', sha256: sha256(answer) }
        : verification,
    answer,
  };
}

export const TEMPLATES: readonly Template[] = TASK_TEMPLATES.map(
  (t): Template => {
    const { about, inputHint } = WORDING[t.id];
    const fields = {
      category: t.category,
      size: t.size,
      difficulty: t.difficulty,
    };
    return {
      id: t.id,
      kind: t.kind,
      ...fields,
      about,
      input: t.input,
      ...(inputHint === undefined ? {} : { inputHint }),
      make: (input, draw = cryptoDraw) =>
        withAnswer(t.make(input, draw), fields),
    };
  },
);

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
