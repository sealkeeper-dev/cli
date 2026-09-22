// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { register as registerShow } from './card-show.js';
import { register as registerWrite } from './card-write.js';

export function register(parent: Command): Command {
  const card = parent.command('card').description('A2A agent card');
  registerShow(card);
  registerWrite(card);
  return card;
}
