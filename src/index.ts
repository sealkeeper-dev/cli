// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { stderr } from './output.js';
import { createProgram } from './program.js';

// A reader that goes away early, as in sealkeeper status | head -1, is not an
// error. Anything else on stdout still is.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw error;
});

// Commands end expected failures through commander with a message of their
// own. Whatever else escapes is a bug or an environment problem, such as a
// file where the home expects a directory, and prints as one line rather
// than a stack. SEALKEEPER_DEBUG adds the stack.
try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  stderr(
    `sealkeeper: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (process.env.SEALKEEPER_DEBUG && error instanceof Error && error.stack) {
    stderr(error.stack);
  }
  process.exitCode = 1;
}

// Every command awaits its own work, so once parseAsync is done there is
// nothing left to wait for. A fetch that timed out can still hold a socket
// open until undici gives up on the connect, about ten seconds later on a
// network that drops packets. Exit now instead. The empty writes let piped
// output drain first, since pipe writes are async on macOS.
await Promise.all([
  new Promise((resolve) => process.stdout.write('', resolve)),
  new Promise((resolve) => process.stderr.write('', resolve)),
]);
process.exit(process.exitCode ?? 0);
