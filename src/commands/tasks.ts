// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { defaultTasksDeps, type TasksDeps } from '../tasks.js';
import { register as registerOutcome } from './tasks-outcome.js';
import { register as registerPost } from './tasks-post.js';
import { register as registerPull } from './tasks-pull.js';
import { register as registerShow } from './tasks-show.js';
import { register as registerSubmit } from './tasks-submit.js';

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  const tasks = parent.command('tasks').description('Task exchange');
  registerPull(tasks, deps);
  registerShow(tasks, deps);
  registerSubmit(tasks, deps);
  registerPost(tasks, deps);
  registerOutcome(tasks, deps);
  return tasks;
}
