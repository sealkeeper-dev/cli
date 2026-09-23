// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import { createProgram } from './program.js';

await createProgram().parseAsync(process.argv);

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
