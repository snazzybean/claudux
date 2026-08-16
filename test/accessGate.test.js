import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasValidSession } from '../src/lib/accessGate.js';
import { setPassword, createSession, setSessionTtlDays } from '../src/lib/accessStore.js';

function tmpConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-gate-'));
  return { authEnabled: true, accessSecretPath: path.join(dir, 'access.json'), ...overrides };
}

test('a valid cookie is accepted and an unknown one is not', () => {
  const config = tmpConfig();
  setPassword(config.accessSecretPath, 'x');
  const token = createSession(config.accessSecretPath);
  assert.equal(hasValidSession(config, `claudux_session=${token}`), true);
  assert.equal(hasValidSession(config, 'claudux_session=nope'), false);
  assert.equal(hasValidSession(config, ''), false);
  assert.equal(hasValidSession(config, undefined), false);
});

test('an expired session is refused', () => {
  const config = tmpConfig();
  setPassword(config.accessSecretPath, 'x');
  setSessionTtlDays(config.accessSecretPath, 7);
  const token = createSession(config.accessSecretPath);
  const cookie = `claudux_session=${token}`;
  assert.equal(hasValidSession(config, cookie), true);
  const eightDays = Date.now() + 8 * 24 * 60 * 60 * 1000;
  assert.equal(hasValidSession(config, cookie, eightDays), false);
});

// The lifetime is applied at check time, so shortening it has to reach a
// device that is already logged in.
test('shortening the lifetime applies to an existing session', () => {
  const config = tmpConfig();
  setPassword(config.accessSecretPath, 'x');
  setSessionTtlDays(config.accessSecretPath, 365);
  const cookie = `claudux_session=${createSession(config.accessSecretPath)}`;
  const inTwoMonths = Date.now() + 60 * 24 * 60 * 60 * 1000;
  assert.equal(hasValidSession(config, cookie, inTwoMonths), true);
  setSessionTtlDays(config.accessSecretPath, 7);
  assert.equal(hasValidSession(config, cookie, inTwoMonths), false);
});

// A file that cannot be read must not read as "everything is fine". The
// caller turns this into a refusal, not into an open instance.
test('a damaged file makes the check throw rather than pass', () => {
  const config = tmpConfig();
  fs.mkdirSync(path.dirname(config.accessSecretPath), { recursive: true });
  fs.writeFileSync(config.accessSecretPath, 'not json');
  assert.throws(() => hasValidSession(config, 'claudux_session=x'));
});
