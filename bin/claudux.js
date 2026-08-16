#!/usr/bin/env node
import readline from 'node:readline/promises';
import { ensurePrerequisites } from '../scripts/setup.js';
import { startServer } from '../src/server.js';

// Offered, never silent: an `npx` invocation that starts installing system
// packages unasked would surprise someone at the very moment they first
// meet the program.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let missing;
try {
  ({ missing } = await ensurePrerequisites({
    confirmFn: async (question) => (await rl.question(`${question} [y/N] `)).trim().toLowerCase() === 'y',
  }));
} finally {
  rl.close();
}

if (missing.length > 0) {
  console.error(`\nCannot start without: ${missing.join(', ')}`);
  process.exit(1);
}

startServer();
