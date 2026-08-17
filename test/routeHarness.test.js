// The route tests' shared fixture, tested where it carries a branch of its
// own: waitForPaneDeath provokes a SIGCHLD when tmux never reports a cause
// of death. That branch is what keeps the CI gate green, and it does not
// execute on a host whose tmux reaps the pane by itself. Driven through the
// injected seams, so what is asserted here is the control flow, not tmux's
// behaviour under CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPaneDeath } from './helpers/routeHarness.js';

const noCause = { name: 'sid', dead: true, deadStatus: null, deadSignal: null };
const killed = { name: 'sid', dead: true, deadStatus: null, deadSignal: 9 };

// Small timings: the defaults would spend seconds waiting for a pane that
// only exists as a literal here.
const fast = { attempts: 2, delayMs: 1, flushes: 2 };

test('waitForPaneDeath returns the entry without flushing when the pane reports on its own', async () => {
  let flushes = 0;
  const entry = await waitForPaneDeath('sid', {
    ...fast,
    readFn: async () => killed,
    flushFn: async () => { flushes++; },
  });

  assert.deepEqual(entry, killed);
  assert.equal(flushes, 0);
});

test('waitForPaneDeath flushes when the cause is missing and returns what the flush produced', async () => {
  let flushed = false;
  let reads = 0;
  const entry = await waitForPaneDeath('sid', {
    ...fast,
    readFn: async () => { reads++; return flushed ? killed : noCause; },
    flushFn: async () => { flushed = true; },
  });

  assert.deepEqual(entry, killed);
  // The plain wait ran to its end first, and only the read after the flush
  // saw the cause.
  assert.equal(reads, fast.attempts + 1);
});

test('waitForPaneDeath throws with the whole entry when no flush produces a cause', async () => {
  let flushes = 0;
  await assert.rejects(
    () => waitForPaneDeath('sid', {
      ...fast,
      readFn: async () => noCause,
      flushFn: async () => { flushes++; },
    }),
    (err) => {
      assert.match(err.message, /pane of sid did not report a cause of death/);
      assert.match(err.message, /"deadSignal":null/);
      return true;
    },
  );
  assert.equal(flushes, fast.flushes);
});
