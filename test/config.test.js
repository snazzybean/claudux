// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig returns defaults when no env vars are set', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 4001);
  assert.equal(cfg.claudeHome, path.join(os.homedir(), '.claude'));
  assert.equal(cfg.idleThresholdMs, 4 * 60 * 60 * 1000);
  // Never-used sessions (no JSONL) go sooner: they hold a full claude
  // process worth of memory with no content at all - nobody needs a
  // four-hour grace period for that.
  assert.equal(cfg.shortIdleThresholdMs, 30 * 60 * 1000);
  // The click link is opt-in - empty until someone sets PUBLIC_BASE_URL,
  // not a real-looking value nobody actually configured.
  assert.equal(cfg.publicBaseUrl, '');
});

test('loadConfig picks up set env vars', () => {
  const cfg = loadConfig({ PORT: '5000', PUBLIC_BASE_URL: 'https://example.test' });
  assert.equal(cfg.port, 5000);
  assert.equal(cfg.publicBaseUrl, 'https://example.test');
});

test('loadConfig sets ttydPort and ttydBin to defaults', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.ttydPort, 7681);
  assert.equal(cfg.ttydBin, 'ttyd');
});

test('loadConfig picks up TTYD_PORT and TTYD_BIN from the environment', () => {
  const cfg = loadConfig({ TTYD_PORT: '9000', TTYD_BIN: '/opt/ttyd/bin/ttyd' });
  assert.equal(cfg.ttydPort, 9000);
  assert.equal(cfg.ttydBin, '/opt/ttyd/bin/ttyd');
});

// A system unit runs without HOME in its environment (systemd sets none).
// With `process.env.HOME` the default became the string "undefined" plus the
// rest - a RELATIVE path, which lands the target store inside the checkout
// next to WorkingDirectory.
test('every home-derived default stays absolute even without HOME', () => {
  const originalHome = process.env.HOME;
  delete process.env.HOME;
  try {
    const cfg = loadConfig({});
    for (const key of ['claudeHome', 'accountsSecretPath', 'notificationTargetsPath', 'browseRoot']) {
      assert.ok(path.isAbsolute(cfg[key]), `${key}: expected an absolute path, got ${cfg[key]}`);
      assert.ok(!cfg[key].includes('undefined'), `${key}: interpolated a missing HOME`);
    }
    assert.ok(cfg.notificationTargetsPath.endsWith('/.claudux/notifications.json'));
    assert.ok(cfg.accountsSecretPath.endsWith('/.claudux/accounts.json'));
  } finally {
    process.env.HOME = originalHome;
  }
});

// Every interface by default. What used to speak against it was that the
// port handed out a shell without asking; the login is what carries that
// now, and an interface only its own machine can reach is useless for the
// one thing this is built for.
test('the listen host defaults to every interface and takes HOST from the environment', () => {
  assert.equal(loadConfig({}).host, '0.0.0.0');
  assert.equal(loadConfig({ HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(loadConfig({ HOST: '192.168.1.10' }).host, '192.168.1.10');
});

// A forgotten or empty value must not hand out a shell. EnvironmentFile= in
// systemd keeps trailing comments, so an empty value is a real case here,
// not a theoretical one.
test('authentication is on unless it is switched off in so many words', () => {
  assert.equal(loadConfig({}).authEnabled, true);
  assert.equal(loadConfig({ AUTH_ENABLED: 'false' }).authEnabled, false);
  assert.equal(loadConfig({ AUTH_ENABLED: '' }).authEnabled, true);
  assert.equal(loadConfig({ AUTH_ENABLED: '0' }).authEnabled, true);
  assert.equal(loadConfig({ AUTH_ENABLED: 'no' }).authEnabled, true);
});

test('the access file sits next to the account tokens by default', () => {
  assert.equal(
    loadConfig({}).accessSecretPath,
    path.join(os.homedir(), '.claudux', 'access.json'),
  );
  assert.equal(
    loadConfig({ ACCESS_SECRET_PATH: '/tmp/x/access.json' }).accessSecretPath,
    '/tmp/x/access.json',
  );
});
