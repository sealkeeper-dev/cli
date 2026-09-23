// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { defaultTasksDeps, type TasksDeps } from '../tasks.js';
import { register as registerPost } from './tasks-post.js';
import { register as registerPull } from './tasks-pull.js';
import { register as registerSubmit } from './tasks-submit.js';

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  const tasks = parent.command('tasks').description('Task exchange');
  registerPull(tasks, deps);
  registerSubmit(tasks, deps);
  registerPost(tasks, deps);
  return tasks;
}
