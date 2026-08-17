// The version check against the GitHub releases API: comparison, the 12h
// cache and the rule that a network failure stays silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  isNewer,
  readPackageMeta,
  fetchLatestRelease,
  createUpdateChecker,
} from '../src/lib/updateCheck.js';

test('compareVersions orders by segment, not lexically', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.2', '1.0.2'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
});

test('compareVersions ignores a leading v, because tags carry one', () => {
  assert.equal(compareVersions('v1.1.0', '1.0.2'), 1);
});

// A tag nobody can parse must not read as "newer" - that would offer an
// update to a version that does not exist.
test('isNewer says no for an unparsable version', () => {
  assert.equal(isNewer('nightly', '1.0.2'), false);
  assert.equal(isNewer('1.1.0', '1.0.2'), true);
  assert.equal(isNewer('1.0.2', '1.0.2'), false);
});

test('readPackageMeta reads version and repository slug', () => {
  const readFileFn = () => JSON.stringify({
    version: '1.0.2',
    repository: { url: 'git+https://github.com/owner/repo.git' },
  });
  assert.deepEqual(readPackageMeta({ readFileFn }), { version: '1.0.2', slug: 'owner/repo' });
});

test('fetchLatestRelease returns tag and notes url', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/releases/latest');
    return {
      ok: true,
      json: async () => ({ tag_name: 'v1.1.0', html_url: 'https://example.invalid/r/v1.1.0' }),
    };
  };
  const release = await fetchLatestRelease({ slug: 'owner/repo', fetchImpl });
  assert.deepEqual(release, { version: 'v1.1.0', notesUrl: 'https://example.invalid/r/v1.1.0' });
});

// Silent on failure: no result means no message. A banner for "GitHub was
// briefly unreachable" would be a disruption with no action behind it.
test('fetchLatestRelease returns null on a failed request instead of throwing', async () => {
  const boom = async () => { throw new Error('network down'); };
  assert.equal(await fetchLatestRelease({ slug: 'owner/repo', fetchImpl: boom }), null);

  const notOk = async () => ({ ok: false, status: 403, json: async () => ({}) });
  assert.equal(await fetchLatestRelease({ slug: 'owner/repo', fetchImpl: notOk }), null);
});

function checkerFixture({ ttlMs = 1000, minManualMs = 100 } = {}) {
  let now = 0;
  let calls = 0;
  const checker = createUpdateChecker({
    meta: { version: '1.0.2', slug: 'owner/repo' },
    nowFn: () => now,
    ttlMs,
    minManualMs,
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ tag_name: 'v1.1.0', html_url: 'https://example.invalid/r' }) };
    },
  });
  return { checker, advance: (ms) => { now += ms; }, calls: () => calls };
}

test('createUpdateChecker keeps the result until the ttl expires', async () => {
  const { checker, advance, calls } = checkerFixture();

  await checker.refresh({});
  await checker.refresh({});
  assert.equal(calls(), 1);

  advance(1001);
  await checker.refresh({});
  assert.equal(calls(), 2);
});

test('createUpdateChecker exposes current, latest and the notes url', async () => {
  const { checker } = checkerFixture();
  await checker.refresh({});
  const state = checker.state();
  assert.equal(state.current, '1.0.2');
  assert.equal(state.latest, 'v1.1.0');
  assert.equal(state.notesUrl, 'https://example.invalid/r');
  assert.equal(typeof state.checkedAt, 'number');
});

// The button in the settings goes past the cache, but not past the minimum
// spacing - click spam would run into GitHub's 60 requests per hour.
test('a manual refresh bypasses the ttl but not the minimum spacing', async () => {
  const { checker, advance, calls } = checkerFixture();

  await checker.refresh({});
  await checker.refresh({ manual: true });
  assert.equal(calls(), 1);

  advance(101);
  await checker.refresh({ manual: true });
  assert.equal(calls(), 2);
});

// After a restart the cache is empty and the interface polls this route
// every few seconds - without a floor for the automatic path too, an
// unreachable GitHub would see dozens of requests in two minutes.
test('the minimum spacing also holds without the manual flag', async () => {
  const { checker, calls } = checkerFixture({ ttlMs: 0 });

  await checker.refresh({});
  await checker.refresh({});
  assert.equal(calls(), 1);
});

// A failed check must not wipe the last good answer: the card would jump to
// "no update" and back on the next tick.
test('a failed check keeps the previous result', async () => {
  let fail = false;
  const checker = createUpdateChecker({
    meta: { version: '1.0.2', slug: 'owner/repo' },
    nowFn: (() => { let n = 0; return () => (n += 10_000); })(),
    ttlMs: 1,
    minManualMs: 0,
    fetchImpl: async () => {
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ tag_name: 'v1.1.0', html_url: 'https://example.invalid/r' }) };
    },
  });

  await checker.refresh({});
  fail = true;
  await checker.refresh({});

  assert.equal(checker.state().latest, 'v1.1.0');
});
