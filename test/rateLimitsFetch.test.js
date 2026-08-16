// Network path and cache. No test here calls the real API - every call
// would burn quota, and the test suite runs before every commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLimits, createLimitCache } from '../src/lib/rateLimits.js';

function response(status, headerObject) {
  const map = new Map(Object.entries(headerObject).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
  };
}

const REAL_HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.08',
  'anthropic-ratelimit-unified-5h-reset': '1786198200',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.71',
  'anthropic-ratelimit-unified-7d-reset': '1786262400',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
};

test('fetchLimits sends the token and beta header along', async () => {
  let seen = null;
  await fetchLimits('secret-123', {
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return response(200, REAL_HEADERS);
    },
  });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.options.headers.Authorization, 'Bearer secret-123');
  assert.equal(seen.options.headers['anthropic-beta'], 'oauth-2025-04-20');
  // max_tokens 1: the request should cost as little quota as possible.
  assert.equal(JSON.parse(seen.options.body).max_tokens, 1);
});

test('fetchLimits returns the parsed windows', async () => {
  const limits = await fetchLimits('t', { fetchImpl: async () => response(200, REAL_HEADERS) });
  assert.equal(limits.fiveHour.percent, 8);
  assert.equal(limits.sevenDay.percent, 71);
});

// The most important case of all: quota exhausted. The API answers with 429
// and still attaches the values - a parser that hinges on the status would
// show nothing at exactly that moment.
test('fetchLimits reads the headers even from a 429 response', async () => {
  const limits = await fetchLimits('t', {
    fetchImpl: async () => response(429, {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
    }),
  });
  assert.equal(limits.fiveHour.percent, 100);
  assert.equal(limits.fiveHour.status, 'rejected');
});

test('fetchLimits throws with the HTTP status when no headers come back', async () => {
  await assert.rejects(
    () => fetchLimits('t', { fetchImpl: async () => response(403, {}) }),
    (err) => err.status === 403 && /403/.test(err.message),
  );
});

// A token in an error message ends up in logs and in the browser. Pinned
// down here for that reason (same stance as in accountStore.js).
test('fetchLimits does not write the token into the error message', async () => {
  await assert.rejects(
    () => fetchLimits('sk-ant-oat01-very-secret', { fetchImpl: async () => response(401, {}) }),
    (err) => !err.message.includes('secret'),
  );
});

test('createLimitCache really fetches the first time', async () => {
  let calls = 0;
  const cache = createLimitCache({ ttlMs: 60000, now: () => 1000 });
  const value = await cache.get('Work', async () => {
    calls += 1;
    return { fiveHour: { percent: 8 } };
  });
  assert.equal(calls, 1);
  assert.equal(value.limits.fiveHour.percent, 8);
  assert.equal(value.asOf, 1000);
});

test('createLimitCache answers from memory within the TTL', async () => {
  let calls = 0;
  let clock = 1000;
  const cache = createLimitCache({ ttlMs: 60000, now: () => clock });
  const loader = async () => {
    calls += 1;
    return { fiveHour: { percent: calls } };
  };
  await cache.get('Work', loader);
  clock = 1000 + 59000;
  const second = await cache.get('Work', loader);
  assert.equal(calls, 1);
  // The timestamp stays that of the real fetch - otherwise a stale value
  // would read like a fresh one in the popover.
  assert.equal(second.asOf, 1000);
});

test('createLimitCache fetches again after the TTL expires', async () => {
  let calls = 0;
  let clock = 1000;
  const cache = createLimitCache({ ttlMs: 60000, now: () => clock });
  const loader = async () => {
    calls += 1;
    return { fiveHour: { percent: calls } };
  };
  await cache.get('Work', loader);
  clock = 1000 + 60001;
  await cache.get('Work', loader);
  assert.equal(calls, 2);
});

// The cache is keyed by ACCOUNT, not by session: the quota belongs to the
// subscription. Two sessions of the same account should share one fetch,
// two accounts should never get in each other's way.
test('createLimitCache keeps the accounts separate', async () => {
  let calls = 0;
  const cache = createLimitCache({ ttlMs: 60000, now: () => 1000 });
  const loader = async () => {
    calls += 1;
    return { fiveHour: { percent: calls * 10 } };
  };
  const a = await cache.get('Work', loader);
  const b = await cache.get('Personal', loader);
  assert.equal(calls, 2);
  assert.notEqual(a.limits.fiveHour.percent, b.limits.fiveHour.percent);
});

// A failure must not discard the last known value: without a network
// connection, a number from five minutes ago with an honest timestamp is
// more useful than a blank display.
test('createLimitCache keeps the last value when the fetch fails', async () => {
  let clock = 1000;
  const cache = createLimitCache({ ttlMs: 60000, now: () => clock });
  await cache.get('Work', async () => ({ fiveHour: { percent: 8 } }));
  clock = 1000 + 120000;
  const value = await cache.get('Work', async () => {
    throw new Error('Network down');
  });
  assert.equal(value.limits.fiveHour.percent, 8);
  assert.equal(value.asOf, 1000);
  assert.match(value.error, /Network down/);
});

test('createLimitCache passes the error through when there is nothing old', async () => {
  const cache = createLimitCache({ ttlMs: 60000, now: () => 1000 });
  await assert.rejects(() => cache.get('Work', async () => {
    throw new Error('Network down');
  }), /Network down/);
});
