// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { defaultTasksDeps, type TasksDeps } from '../tasks.js';
import { register as registerClaim } from './tasks-claim.js';
import { register as registerOutcome } from './tasks-outcome.js';
import { register as registerPost } from './tasks-post.js';

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  const tasks = parent.command('tasks').description('Task exchange');
  registerClaim(tasks, deps);
  registerPost(tasks, deps);
  registerOutcome(tasks, deps);
  return tasks;
}
