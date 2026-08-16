import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isConfigured, setPassword, verifyPassword, createSession, findSession,
  revokeSession, revokeAllSessions, getSessionTtlDays, setSessionTtlDays, readAccess,
} from '../src/lib/accessStore.js';

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-access-'));
  return path.join(dir, 'nested', 'access.json');
}

test('a fresh installation is not configured', () => {
  assert.equal(isConfigured(tmpPath()), false);
});

test('a stored password verifies and a wrong one does not', () => {
  const p = tmpPath();
  setPassword(p, 'correct horse');
  assert.equal(isConfigured(p), true);
  assert.equal(verifyPassword(p, 'correct horse'), true);
  assert.equal(verifyPassword(p, 'correct horsf'), false);
});

test('verifyPassword is false, not a throw, before a password exists', () => {
  assert.equal(verifyPassword(tmpPath(), 'anything'), false);
});

// The file holds site-wide access; other local users must not read it, and
// mkdirSync's mode is a no-op on a directory that already exists.
test('file and directory carry restrictive modes, also on a pre-existing directory', () => {
  const p = tmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(p), 0o755);
  setPassword(p, 'x');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
});

test('the raw password never appears in the file', () => {
  const p = tmpPath();
  setPassword(p, 'plaintext-secret');
  assert.equal(fs.readFileSync(p, 'utf8').includes('plaintext-secret'), false);
});

test('a session is found by its token and by nothing else', () => {
  const p = tmpPath();
  setPassword(p, 'x');
  const token = createSession(p);
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 40);
  assert.ok(findSession(p, token));
  assert.equal(findSession(p, 'wrong'), null);
  assert.equal(findSession(p, ''), null);
  assert.equal(findSession(p, undefined), null);
});

test('the token itself is not stored, only a hash of it', () => {
  const p = tmpPath();
  setPassword(p, 'x');
  const token = createSession(p);
  assert.equal(fs.readFileSync(p, 'utf8').includes(token), false);
});

test('revoking one session leaves the others alone', () => {
  const p = tmpPath();
  setPassword(p, 'x');
  const a = createSession(p);
  const b = createSession(p);
  revokeSession(p, a);
  assert.equal(findSession(p, a), null);
  assert.ok(findSession(p, b));
});

test('revokeAllSessions clears every device', () => {
  const p = tmpPath();
  setPassword(p, 'x');
  const a = createSession(p);
  const b = createSession(p);
  revokeAllSessions(p);
  assert.equal(findSession(p, a), null);
  assert.equal(findSession(p, b), null);
});

// A changed password must not leave a device logged in that was set up under
// the old one.
test('setting a new password revokes all sessions', () => {
  const p = tmpPath();
  setPassword(p, 'old');
  const token = createSession(p);
  setPassword(p, 'new');
  assert.equal(findSession(p, token), null);
});

test('the session lifetime defaults to 30 days and accepts only known values', () => {
  const p = tmpPath();
  setPassword(p, 'x');
  assert.equal(getSessionTtlDays(p), 30);
  setSessionTtlDays(p, null);
  assert.equal(getSessionTtlDays(p), null);
  setSessionTtlDays(p, 365);
  assert.equal(getSessionTtlDays(p), 365);
  assert.throws(() => setSessionTtlDays(p, 3));
  assert.throws(() => setSessionTtlDays(p, '30'));
  assert.equal(getSessionTtlDays(p), 365);
});

// Only "the file is not there" means "not set up yet". Any other read failure
// has to surface, or a damaged file would become a way to hand out a fresh
// password.
test('a damaged file throws instead of reading as unconfigured', () => {
  const p = tmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ not json');
  assert.throws(() => readAccess(p));
  assert.throws(() => isConfigured(p));
});

// The parse error of a broken file quotes its content, which is hash and salt
// material - it must not travel in the message.
test('the error message carries no file content', () => {
  const p = tmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ "password": "leaky-content" ');
  assert.throws(() => readAccess(p), (err) => !err.message.includes('leaky-content'));
});
