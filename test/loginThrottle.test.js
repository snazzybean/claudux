import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginThrottle } from '../src/lib/loginThrottle.js';

function fixedClock(start = 0) {
  const clock = { now: start };
  return { nowFn: () => clock.now, advance: (ms) => { clock.now += ms; } };
}

test('the first four failures are free, then the wait grows', () => {
  const { nowFn } = fixedClock();
  const t = createLoginThrottle({ nowFn });
  for (let i = 0; i < 4; i++) {
    assert.equal(t.delayMs('a'), 0);
    t.recordFailure('a');
  }
  assert.equal(t.delayMs('a'), 0, 'four failures are still free');
  t.recordFailure('a');
  assert.equal(t.delayMs('a'), 1000);
  t.recordFailure('a');
  assert.equal(t.delayMs('a'), 2000);
});

test('the wait is capped at 30 seconds', () => {
  const { nowFn } = fixedClock();
  const t = createLoginThrottle({ nowFn });
  for (let i = 0; i < 40; i++) t.recordFailure('a');
  assert.equal(t.delayMs('a'), 30000);
});

test('a successful login clears the record', () => {
  const { nowFn } = fixedClock();
  const t = createLoginThrottle({ nowFn });
  for (let i = 0; i < 10; i++) t.recordFailure('a');
  t.recordSuccess('a');
  assert.equal(t.delayMs('a'), 0);
});

// Otherwise one noisy client would lock everybody else out.
test('two clients are counted separately', () => {
  const { nowFn } = fixedClock();
  const t = createLoginThrottle({ nowFn });
  for (let i = 0; i < 10; i++) t.recordFailure('a');
  assert.equal(t.delayMs('b'), 0);
});

// Without this the map grows for the lifetime of the process.
test('a record is forgotten after an hour of quiet', () => {
  const { nowFn, advance } = fixedClock();
  const t = createLoginThrottle({ nowFn });
  for (let i = 0; i < 10; i++) t.recordFailure('a');
  advance(60 * 60 * 1000 + 1);
  assert.equal(t.delayMs('a'), 0);
});
