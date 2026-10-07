// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { type OutputTracker, trackOutput } from './output.js';
import { INDENT, type Style, type Styled, visibleWidth } from './style.js';

// The steps init lists under the wordmark and finishes one by one, from
// the init banner design. In a styled terminal wide enough for the
// wordmark the list is pinned, see LiveList. Anywhere else it is printed
// once with the states known at the start and the rest of init scrolls
// under it as it always has.

export type StepKey =
  | 'key'
  | 'sign-in'
  | 'hooks'
  | 'skill'
  | 'game'
  | 'routine';

// A step in the order init takes it. A note says what a step can end as
// while it is still to do. Hooks and the skill with the slash commands are
// listed only when Claude Code is set up on this machine, the same check
// that decides whether they are offered.
export type SetupStep = {
  key: StepKey;
  label: string;
  note?: string;
  claudeCode?: true;
};
export const SETUP_STEPS: readonly SetupStep[] = [
  { key: 'key', label: 'Key' },
  { key: 'sign-in', label: 'GitHub sign-in' },
  { key: 'hooks', label: 'Hooks', claudeCode: true },
  { key: 'skill', label: 'Skill and slash commands', claudeCode: true },
  { key: 'game', label: 'Game', note: 'on / off' },
  { key: 'routine', label: 'Routine', note: 'offered at the end' },
];
export const SETUP_TITLE = 'Setting up this agent';
export const setupCount = (steps: number): string => `${steps} steps`;
// The label column of a step line, so the notes and the results line up.
export const STEP_LABEL_WIDTH = 26;
// What the key step says while the key is made, the one note the design
// draws on a step in progress.
export const KEY_GENERATING = 'generating…';

// What a step line shows. todo is grey with the note, doing has the
// green half circle, done the green circle and the result.
export type StepState =
  | { status: 'todo' }
  | { status: 'doing'; text?: string }
  | { status: 'done'; text: string };
export type StepStates = Partial<Record<StepKey, StepState>>;

export const TODO: StepState = { status: 'todo' };

// The steps this machine lists.
export function stepsFor(claudeCode: boolean): SetupStep[] {
  return SETUP_STEPS.filter((step) => !step.claudeCode || claudeCode);
}

// One step line, two spaces in from the init indent.
export function stepLine(
  s: Style,
  n: number,
  step: SetupStep,
  state: StepState,
): Styled {
  const number = `${n}  `;
  const column = (text: string | undefined) =>
    text === undefined
      ? step.label
      : `${step.label.padEnd(STEP_LABEL_WIDTH)}${text}`;
  // The gap between the label and the text, so the texts line up.
  const pad = ''.padEnd(STEP_LABEL_WIDTH - step.label.length);
  switch (state.status) {
    case 'todo':
      return s.line`  ${s.todo()} ${s.grey(`${number}${column(step.note)}`)}`;
    case 'doing':
      return state.text === undefined
        ? s.line`  ${s.doing()} ${number}${step.label}`
        : s.line`  ${s.doing()} ${number}${step.label}${pad}${s.grey(state.text)}`;
    case 'done':
      return s.line`  ${s.done()} ${number}${step.label}${pad}${s.grey(state.text)}`;
  }
}

// The stream the list is drawn on, stderr, and the terminal's size.
export type ListStream = {
  write(text: string): boolean;
  columns?: number;
  rows?: number;
};

const ESC = '\u001b';
// Save and restore the cursor, DECSC and DECRC, so a redraw of a step
// line puts the cursor back where the question area left it.
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const up = (n: number) => `${ESC}[${n}A`;
// Clear the line, and clear from the cursor to the end of the screen.
const CLEAR_LINE = `${ESC}[2K`;
const CLEAR_BELOW = `${ESC}[0J`;

// The pinned list. The steps are drawn once, and under them, after one
// empty line, is the area where init asks its questions and prints what
// each step did. Every line written to the terminal while the list is
// live is counted, through trackOutput in output.ts, with how many rows it
// takes at the terminal's width, so the list can be reached by moving the
// cursor up. An answer ends the row its question started, and the area is
// cleared after it, so the next question takes its place. A step that
// starts or finishes is redrawn in place and the area is cleared, so once
// every step is done only the list is left, and the summary init prints
// after end() stays under it.
//
// A redraw that would reach above the top of the screen is skipped, since
// the terminal would clamp the move and the line would land elsewhere.
// The area is kept small by the clears, so that happens only in a
// terminal of a handful of rows.
export class LiveList implements OutputTracker {
  // Rows of the area ended with a line feed.
  private rows = 0;
  // Columns of the row under the cursor that has no line feed yet, a
  // question waiting for its answer.
  private pending = 0;
  private live = true;
  private readonly states: StepState[];

  constructor(
    private readonly stream: ListStream,
    private readonly s: Style,
    private readonly steps: SetupStep[],
    initial: StepStates,
  ) {
    this.states = steps.map((step) => initial[step.key] ?? TODO);
  }

  // The list as it stands, the lines welcome prints.
  lines(): Styled[] {
    return this.steps.map((step, i) =>
      stepLine(this.s, i + 1, step, this.shorten(this.states[i] ?? TODO)),
    );
  }

  // Counts a line written under the list, see output.ts. A line feed
  // inside the text ends a row too, as a question that starts with one.
  wrote(text: string, lineFeed: boolean): void {
    if (!this.live) return;
    const parts = text.split('\n');
    const last = parts.pop() ?? '';
    for (const part of parts) {
      this.rows += this.rowsOf(this.pending + visibleWidth(part));
      this.pending = 0;
    }
    const width = visibleWidth(last);
    if (lineFeed) {
      this.rows += this.rowsOf(this.pending + width);
      this.pending = 0;
    } else {
      this.pending += width;
    }
  }

  // Counts the answer typed after a question, which the terminal echoed,
  // and the line feed that ended it, then clears the area.
  answered(answer: string): void {
    if (!this.live) return;
    this.rows += this.rowsOf(this.pending + answer.length);
    this.pending = 0;
    this.clear();
  }

  start(key: StepKey, text?: string): void {
    this.redraw(key, {
      status: 'doing',
      ...(text === undefined ? {} : { text }),
    });
  }

  finish(key: StepKey, text: string): void {
    this.redraw(key, { status: 'done', text });
  }

  // Clears the area and stops counting, before the summary and before a
  // first routine run, whose lines stay on the screen.
  end(): void {
    if (!this.live) return;
    this.clear();
    this.live = false;
    trackOutput(null);
  }

  private rowsOf(columns: number): number {
    const width = this.stream.columns ?? 0;
    return width > 0 ? Math.max(1, Math.ceil(columns / width)) : 1;
  }

  // The state with its text cut to fit the terminal, from the left with
  // an ellipsis, so a long path keeps its end and the line never wraps
  // onto the step under it. The line is the init indent, the step indent,
  // the glyph and a space, the number and the label column.
  private shorten(state: StepState): StepState {
    if (state.status === 'todo' || state.text === undefined) return state;
    const width = this.stream.columns ?? 0;
    const room = width - INDENT.length - 2 - 2 - 3 - STEP_LABEL_WIDTH;
    const text = [...state.text];
    if (width === 0 || text.length <= room) return state;
    const cut =
      room < 2 ? '' : `…${text.slice(text.length - room + 1).join('')}`;
    return { ...state, text: cut };
  }

  private clear(): void {
    if (this.rows === 0 && this.pending === 0) return;
    this.stream.write(`\r${this.rows > 0 ? up(this.rows) : ''}${CLEAR_BELOW}`);
    this.rows = 0;
    this.pending = 0;
  }

  private redraw(key: StepKey, state: StepState): void {
    const i = this.steps.findIndex((step) => step.key === key);
    if (i < 0) return;
    this.states[i] = state;
    if (!this.live) return;
    this.clear();
    const step = this.steps[i] as SetupStep;
    // The empty line under the list, then the lines below this step.
    const distance = 1 + (this.steps.length - i);
    const rows = this.stream.rows ?? 0;
    if (rows > 0 && distance >= rows) return;
    const line = stepLine(this.s, i + 1, step, this.shorten(state));
    this.stream.write(
      `${SAVE}${up(distance)}\r${CLEAR_LINE}${INDENT}${line.text}${RESTORE}`,
    );
  }
}
