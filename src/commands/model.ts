// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { ModelName, RUNTIME_LABELS } from '@sealkeeper/schema';
import type { Command } from 'commander';
import { requireConfig } from '../cli-config.js';
import { paths } from '../config.js';
import { cli } from '../invocation.js';
import {
  type DeclaredModel,
  declaredModel,
  readModelSet,
  writeModelSet,
} from '../model-name.js';
import { stdout, wantsJson } from '../output.js';

const BAD_NAME =
  'a model name is 1 to 64 letters, digits and . _ : / @ -, with a name after its last slash, and never names SealKeeper';

// Where the declared name came from, in words.
const fromText = (model: DeclaredModel) =>
  model.source === 'set'
    ? `set with ${cli('model set')}`
    : `read by the ${RUNTIME_LABELS[model.source]} adapter`;

// The model name each sync sends as text beside the fingerprint (VOU-566).
// set keeps a name for a runtime with no adapter, show prints the name the
// next sync sends and where it comes from. A name an adapter reads wins.
export function register(parent: Command): Command {
  const model = parent
    .command('model')
    .description('Show or set the model name each sync sends');

  model
    .command('show')
    .description('Print the model name the next sync sends, and where from')
    .action(async function (this: Command): Promise<void> {
      await requireConfig(this);
      const declared = await declaredModel();
      const set = await readModelSet();
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            model: declared?.name ?? null,
            source: declared?.source ?? null,
            set,
          }),
        );
        return;
      }
      if (declared === null) {
        stdout(
          `no model name, sync sends none. Set one with ${cli('model set <name>')}`,
        );
        return;
      }
      stdout(`${declared.name}, ${fromText(declared)}`);
      if (set !== null && declared.source !== 'set') {
        stdout(`${set} is set by hand, and the adapter's name wins`);
      }
    });

  model
    .command('set')
    .description(
      'Keep a model name for a runtime with no adapter, sent with the next sync',
    )
    .argument('<name>', 'the model name, as in claude-opus-4-5 or gpt-4.1')
    .action(async function (this: Command, name: string): Promise<void> {
      await requireConfig(this);
      const parsed = ModelName.safeParse(name);
      if (!parsed.success) this.error(BAD_NAME);
      await writeModelSet(parsed.data, paths());
      const declared = await declaredModel();
      if (wantsJson(this)) {
        stdout(
          JSON.stringify({
            set: parsed.data,
            model: declared?.name ?? null,
            source: declared?.source ?? null,
          }),
        );
        return;
      }
      stdout(
        declared !== null && declared.source !== 'set'
          ? `${parsed.data} set. The ${RUNTIME_LABELS[declared.source]} adapter reads ${declared.name}, which wins`
          : `${parsed.data} set, sent as text with the next sync`,
      );
    });

  return model;
}
