// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { Command } from 'commander';
import { type CardDeps, defaultCardDeps } from '../card.js';
import { register as registerShow } from './card-show.js';
import { register as registerWrite } from './card-write.js';

export function register(
  parent: Command,
  deps: CardDeps = defaultCardDeps,
): Command {
  const card = parent.command('card').description('A2A agent card');
  registerShow(card, deps);
  registerWrite(card, deps);
  return card;
}
