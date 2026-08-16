// test/sessionRegistry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntry, readRegistry, reconcile } from '../src/lib/sessionRegistry.js';
import { setMeta, getMeta } from '../src/lib/sessionMeta.js';

// A line in the shape the CLI writes, with invented ids.
const REAL = JSON.stringify({
  pid: 2159,
  sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  cwd: '/srv/project',
  startedAt: 1786538258556,
  procStart: '70592881',
  version: '2.1.226',
  kind: 'interactive',
  entrypoint: 'cli',
  tmux: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa:@1.%1',
  status: 'idle',
  updatedAt: 1786538258689,
  statusUpdatedAt: 1786538258689,
});

test('parseEntry reads pid, session, carrier and status', () => {
  assert.deepEqual(parseEntry(REAL), {
    pid: 2159,
    sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    tmuxSession: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    cwd: '/srv/project',
    status: 'idle',
    statusUpdatedAt: 1786538258689,
  });
});

test('parseEntry keeps the new session id after a /clear', () => {
  // Same pid and carrier, replaced sessionId.
  const afterClear = REAL.replace(
    '"sessionId":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"',
    '"sessionId":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"',
  );
  const entry = parseEntry(afterClear);
  assert.equal(entry.sessionId, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
  assert.equal(entry.tmuxSession, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
});

test('parseEntry cuts the carrier at the last ":@", not the first colon', () => {
  const weird = REAL.replace('"tmux":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa:@1.%1"',
    '"tmux":"login-ab12:@3.%7"');
  assert.equal(parseEntry(weird).tmuxSession, 'login-ab12');
});

test('parseEntry rejects entries that are not usable', () => {
  assert.equal(parseEntry('{ broken json'), null);
  assert.equal(parseEntry('[]'), null);
  assert.equal(parseEntry('null'), null);
  // No tmux field: somebody typed `claude` in an SSH session.
  assert.equal(parseEntry(REAL.replace('"tmux":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa:@1.%1",', '')), null);
  // A session name outside [a-zA-Z0-9-] must not reach getMeta or tmux.
  assert.equal(parseEntry(REAL.replace('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa:@1.%1', '__proto__:@1.%1')), null);
  assert.equal(parseEntry(REAL.replace('"sessionId":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"', '"sessionId":"a/b"')), null);
});

// The registry covers every claude process on the host, including the ones
// the CLI marks as kind "bg" - a background agent. Such a process inherits
// its parent's tmux environment and reports the SAME carrier, so keyed by
// carrier it would overwrite the interactive session, and the reconcile
// would store the agent's conversation as the one on screen.
test('parseEntry takes interactive sessions only', () => {
  assert.equal(parseEntry(REAL.replace('"kind":"interactive"', '"kind":"bg"')), null);
  assert.equal(parseEntry(REAL.replace('"kind":"interactive"', '"kind":"daemon-worker"')), null);
  // A missing field is not a rejection: same fallback stance as everywhere
  // in this module - an unknown CLI leaves the behaviour intact.
  assert.ok(parseEntry(REAL.replace('"kind":"interactive",', '')));
});

test('readRegistry maps carriers to entries', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-reg-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', '2159.json'), REAL);
  fs.writeFileSync(path.join(home, 'sessions', 'broken.json'), '{ nope');
  const map = readRegistry(home);
  assert.equal(map.size, 1);
  assert.equal(map.get('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa').pid, 2159);
});

test('readRegistry returns an empty map when the directory is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-reg-'));
  assert.equal(readRegistry(home).size, 0);
});

function entry(tmuxSession, sessionId) {
  return { pid: 1, sessionId, tmuxSession, cwd: '/srv/project', status: 'idle', statusUpdatedAt: 1 };
}

test('reconcile stores the running conversation of a known carrier', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-rec-'));
  setMeta(dataDir, 'carrier-1', { projectId: 'proj-1' });
  const registry = new Map([['carrier-1', entry('carrier-1', 'fresh-1')]]);
  assert.deepEqual(reconcile(dataDir, registry, ['carrier-1']), ['carrier-1']);
  assert.equal(getMeta(dataDir, 'carrier-1').currentSession, 'fresh-1');
  // Idempotent: the second pass has nothing left to write.
  assert.deepEqual(reconcile(dataDir, registry, ['carrier-1']), []);
});

test('reconcile skips carriers that are not running and unknown ones', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-rec-'));
  setMeta(dataDir, 'carrier-1', { projectId: 'proj-1' });
  const registry = new Map([
    ['carrier-1', entry('carrier-1', 'fresh-1')],   // known but dead
    ['foreign-1', entry('foreign-1', 'fresh-2')],   // running but not ours
  ]);
  assert.deepEqual(reconcile(dataDir, registry, ['foreign-1']), []);
  assert.equal(getMeta(dataDir, 'fresh-1'), null);
  assert.equal(getMeta(dataDir, 'fresh-2'), null);
});
