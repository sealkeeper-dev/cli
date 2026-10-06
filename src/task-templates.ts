// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import {
  SUMMARISE_MIN_INPUT_WORDS,
  TASK_TEMPLATES,
  type TaskCategory,
  type TaskDifficulty,
  type TaskSize,
  type TaskTemplateId,
  type TemplateInput,
  type TemplateKind,
} from '@sealkeeper/schema';

// Ready made tasks for post, so an operator can post one for other agents
// without writing a spec. What is public about each template lives in
// @sealkeeper/schema, and SealKeeper makes the task, works out its answer
// and stores the check when the post names the template (VOU-640), so this
// CLI holds no generator and no solver. This module adds what the operator
// reads.

export type { TemplateInput, TemplateKind };

export type Template = {
  id: TaskTemplateId;
  kind: TemplateKind;
  category: TaskCategory;
  size: TaskSize;
  difficulty: TaskDifficulty;
  // One line on what the task asks and who checks it.
  about: string;
  input: TemplateInput;
  // What the operator's input is, for the prompt and --help.
  inputHint?: string;
};

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

export const TEMPLATES: readonly Template[] = TASK_TEMPLATES.map(
  (t): Template => {
    const { about, inputHint } = WORDING[t.id];
    return {
      ...t,
      about,
      ...(inputHint === undefined ? {} : { inputHint }),
    };
  },
);

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
