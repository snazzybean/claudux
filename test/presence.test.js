// test/presence.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportVisible, reportHidden, isVisible, PRESENCE_VALID_MS } from '../src/lib/presence.js';

// Deliberately in-memory only: the information is valid for seconds and
// worthless after a restart anyway - the next heartbeat re-establishes it
// within seconds. A file for this would be dead weight.

test('a reported session counts as visible', () => {
  const now = 1_000_000;
  reportVisible('session-a', now);

  assert.equal(isVisible('session-a', now), true);
});

test('a session that was never reported does not count as visible', () => {
  assert.equal(isVisible('never-reported', 1_000_000), false);
});

// The decisive case: if the tab is closed or the device is put away, no
// hidden report ever arrives. Without expiry, the session would stay
// "visible" forever and never notify again. Better one notification too
// many than none permanently.
test('a report expires when no new heartbeat arrives', () => {
  const now = 2_000_000;
  reportVisible('session-b', now);

  assert.equal(isVisible('session-b', now + PRESENCE_VALID_MS - 1), true);
  assert.equal(isVisible('session-b', now + PRESENCE_VALID_MS + 1), false);
});

// When the user switches tabs or locks the device, the frontend reports
// that actively - waiting for the report to expire on its own would delay
// the notification by up to one validity period.
test('a hidden report takes effect immediately, without waiting for expiry', () => {
  const now = 3_000_000;
  reportVisible('session-c', now);
  reportHidden('session-c');

  assert.equal(isVisible('session-c', now), false);
});

// Two devices at once (phone and computer) are the normal case here - the
// sessions must not overwrite each other while doing so.
test('multiple sessions are tracked independently of each other', () => {
  const now = 4_000_000;
  reportVisible('session-d', now);
  reportVisible('session-e', now);
  reportHidden('session-d');

  assert.equal(isVisible('session-d', now), false);
  assert.equal(isVisible('session-e', now), true);
});

// A new heartbeat pushes the validity forward - otherwise an open session
// would wrongly be notified again after one validity period, even though
// someone has been sitting in front of it the whole time.
test('a new heartbeat extends the validity', () => {
  const start = 5_000_000;
  reportVisible('session-f', start);
  const later = start + PRESENCE_VALID_MS - 1;
  reportVisible('session-f', later);

  assert.equal(isVisible('session-f', later + PRESENCE_VALID_MS - 1), true);
});
