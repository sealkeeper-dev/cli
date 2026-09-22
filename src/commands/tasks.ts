// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { register as registerPost } from './tasks-post.js';
import { register as registerPull } from './tasks-pull.js';
import { register as registerSubmit } from './tasks-submit.js';

export function register(parent: Command): Command {
  const tasks = parent.command('tasks').description('Task exchange');
  registerPull(tasks);
  registerSubmit(tasks);
  registerPost(tasks);
  return tasks;
}
