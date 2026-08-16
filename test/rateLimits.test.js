// test/rateLimits.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedHeaders, colorLevel, expectedExhaustionAt } from '../src/lib/rateLimits.js';

// Header names and shape from a real API response. As a Map, because that
// mirrors the fetch Headers API: access via .get().
function headers(entries) {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(String(name).toLowerCase()) ?? null };
}

const REAL_RESPONSE = {
  'anthropic-ratelimit-unified-5h-reset': '1786198200',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.08',
  'anthropic-ratelimit-unified-7d-reset': '1786262400',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.71',
};

test('parseUnifiedHeaders reads 5h and 7d from a real response', () => {
  const result = parseUnifiedHeaders(headers(REAL_RESPONSE));
  assert.deepEqual(result.fiveHour, { percent: 8, resetsAt: 1786198200, status: 'allowed' });
  assert.deepEqual(result.sevenDay, { percent: 71, resetsAt: 1786262400, status: 'allowed' });
});

// utilization is a fraction 0..1, not a percentage. A factor-of-100 mistake
// would be hard to spot in the UI, because 8% and 8‰ both look plausible.
test('parseUnifiedHeaders converts the fraction to a percentage', () => {
  const result = parseUnifiedHeaders(headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }));
  assert.equal(result.fiveHour.percent, 50);
});

// The most interesting moment is the one where the quota is exhausted. The
// headers also come with a 429 response - so the parser must not hinge on
// the status.
test('parseUnifiedHeaders also reads an exhausted state', () => {
  const result = parseUnifiedHeaders(headers({
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': '1786198200',
  }));
  assert.equal(result.fiveHour.status, 'rejected');
  assert.equal(result.fiveHour.percent, 100);
});

// "unknown" and "nothing used" must not feel the same: a 0 instead of null
// would show an empty green bar where there's actually no information at
// all.
test('parseUnifiedHeaders returns null instead of 0 when the headers are missing', () => {
  const result = parseUnifiedHeaders(headers({}));
  assert.equal(result.fiveHour, null);
  assert.equal(result.sevenDay, null);
});

test('parseUnifiedHeaders ignores unusable values', () => {
  const result = parseUnifiedHeaders(headers({
    'anthropic-ratelimit-unified-5h-utilization': 'not-a-number',
    'anthropic-ratelimit-unified-7d-utilization': '0.2',
    'anthropic-ratelimit-unified-7d-reset': 'also-not-a-number',
  }));
  assert.equal(result.fiveHour, null);
  assert.equal(result.sevenDay.percent, 20);
  assert.equal(result.sevenDay.resetsAt, null);
});

// The color thresholds are copied verbatim from the statusline script.
// Terminal and browser should show the same color for the same situation.
const FIVE_HOURS = 18000;

test('colorLevel stays dim under 10 percent, no matter how early in the window', () => {
  // 5% after only 1% of the window would project to 500% - still dim: right
  // at the start of a window, every projection is noise.
  const reset = 10000;
  const now = reset - FIVE_HOURS + 180;
  assert.equal(colorLevel(5, reset, now, FIVE_HOURS), 'dim');
});

test('colorLevel is red from 90 percent on, regardless of the projection', () => {
  const reset = 10000;
  const now = reset - 60; // window nearly over, projection would be harmless
  assert.equal(colorLevel(95, reset, now, FIVE_HOURS), 'crit');
});

test('colorLevel is green when the pace holds out until the reset', () => {
  const reset = 10000;
  const now = reset - FIVE_HOURS / 2; // half the window used up
  assert.equal(colorLevel(30, reset, now, FIVE_HOURS), 'ok'); // projects to 60%
});

test('colorLevel warns when the pace gets tight', () => {
  const reset = 10000;
  const now = reset - FIVE_HOURS / 2;
  assert.equal(colorLevel(45, reset, now, FIVE_HOURS), 'warn'); // projects to 90%
});

test('colorLevel is red when the limit is hit before the reset', () => {
  const reset = 10000;
  const now = reset - FIVE_HOURS / 2;
  assert.equal(colorLevel(60, reset, now, FIVE_HOURS), 'crit'); // projects to 120%
});

// Without a reset time there's no elapsed fraction - so only the raw value is
// left. Same fallback as in the shell script.
test('colorLevel copes without a reset time', () => {
  assert.equal(colorLevel(80, null, 1000, FIVE_HOURS), 'warn');
  assert.equal(colorLevel(20, null, 1000, FIVE_HOURS), 'ok');
});

// expectedExhaustionAt reverses the projection from colorLevel: not "what
// percentage in the end", but "when does it reach 100". Only this direction
// can be displayed - a percentage for a point in time in the future tells no
// one how much longer they can keep working.

test('expectedExhaustionAt names the point in time when the pace runs into the limit before the reset', () => {
  const reset = 10000;
  const now = reset - FIVE_HOURS / 2; // half the window used up
  // 60% in 9000s -> the remaining 40% take another 6000s.
  assert.equal(expectedExhaustionAt(60, reset, now, FIVE_HOURS), now + 6000);
});

// The counterpart to 'colorLevel is green when the pace holds out until the
// reset': there's nothing to warn about there, so no point in time to name
// either. A line "expected to run out at ..." with a time after the reset
// would be a prediction that never happens.
test('expectedExhaustionAt stays silent when the quota holds out until the reset', () => {
  const reset = 10000;
  const now = reset - FIVE_HOURS / 2;
  assert.equal(expectedExhaustionAt(30, reset, now, FIVE_HOURS), null);
});

// Same threshold as in colorLevel: 5% after three minutes would work out to
// a point in time that only scales up the noise of the first few minutes.
test('expectedExhaustionAt stays silent at the start of the window', () => {
  const reset = 10000;
  const now = reset - FIVE_HOURS + 180;
  assert.equal(expectedExhaustionAt(5, reset, now, FIVE_HOURS), null);
});

test('expectedExhaustionAt stays silent when the quota is already exhausted', () => {
  const reset = 10000;
  const now = reset - 3600;
  assert.equal(expectedExhaustionAt(100, reset, now, FIVE_HOURS), null);
});

// Without a reset time, the start of the window is unknown, and without it
// there's no pace. Unlike colorLevel, this calculation has no fallback for
// that - it needs the elapsed time.
test('expectedExhaustionAt needs the reset time', () => {
  assert.equal(expectedExhaustionAt(60, null, 1000, FIVE_HOURS), null);
  assert.equal(expectedExhaustionAt(60, 0, 1000, FIVE_HOURS), null);
});

// Reset in the future, window mathematically not yet begun: colorLevel
// treats this state as critical, but no projection can be derived from it -
// there's no dividing by the elapsed time.
test('expectedExhaustionAt stays silent for a window that has not started yet', () => {
  const reset = 100000;
  const now = reset - FIVE_HOURS - 60;
  assert.equal(expectedExhaustionAt(80, reset, now, FIVE_HOURS), null);
});

test('expectedExhaustionAt copes without a usable percentage', () => {
  assert.equal(expectedExhaustionAt(null, 10000, 1000, FIVE_HOURS), null);
});
