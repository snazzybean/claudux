// test/sessionMeta.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getMeta,
  setMeta,
  claudeSessionIdsForTmux,
  tmuxSessionFor,
  currentConversationFor,
  recordClaudeSwitch,
} from '../src/lib/sessionMeta.js';

test('getMeta returns null when nothing was stored', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  assert.equal(getMeta(dataDir, 'unknown'), null);
});

test('setMeta stores it, getMeta reads it back', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'sess-1', { accountId: 'id-1', projectId: 'proj-1' });
  assert.deepEqual(getMeta(dataDir, 'sess-1'), { accountId: 'id-1', projectId: 'proj-1' });
});

test('getMeta returns null on a corrupt session-meta.json instead of crashing', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  fs.writeFileSync(path.join(dataDir, 'session-meta.json'), '{ broken json');
  assert.equal(getMeta(dataDir, 'sess-1'), null);
});

test('getMeta returns null when session-meta.json does not contain an object', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  fs.writeFileSync(path.join(dataDir, 'session-meta.json'), JSON.stringify(['not', 'an', 'object']));
  assert.equal(getMeta(dataDir, 'sess-1'), null);
});

test('setMeta overwrites a corrupt session-meta.json instead of crashing', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  fs.writeFileSync(path.join(dataDir, 'session-meta.json'), '{ broken json');
  setMeta(dataDir, 'sess-1', { accountId: 'id-1', projectId: 'proj-1' });
  assert.deepEqual(getMeta(dataDir, 'sess-1'), { accountId: 'id-1', projectId: 'proj-1' });
});

// After a /clear, claude-switch creates a SECOND entry that points at the
// same session via `tmuxSession` (see routes/sessions.js). Anyone looking
// for the context state of a running session needs to know both IDs - the
// conversation from before the /clear sits under the old one.
test('claudeSessionIdsForTmux finds all IDs that point at the same tmux session', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'tmux-1', { accountId: 'id-1', projectId: 'p1' });
  setMeta(dataDir, 'after-clear', { accountId: 'id-1', projectId: 'p1', tmuxSession: 'tmux-1' });
  setMeta(dataDir, 'other', { accountId: 'id-1', projectId: 'p1', tmuxSession: 'tmux-2' });
  assert.deepEqual(claudeSessionIdsForTmux(dataDir, 'tmux-1').sort(), ['after-clear', 'tmux-1']);
});

test('claudeSessionIdsForTmux returns the session itself when there was no switch', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  assert.deepEqual(claudeSessionIdsForTmux(dataDir, 'tmux-1'), ['tmux-1']);
});

// The reverse of claudeSessionIdsForTmux: which tmux session carries this
// conversation? After a /clear the new Claude ID differs from the tmux
// session name, so the liveness check needs this mapping.
test('tmuxSessionFor returns the session itself when there was no switch', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  assert.equal(tmuxSessionFor(dataDir, 'tmux-1'), 'tmux-1');
});

test('tmuxSessionFor follows a single /clear', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'after-clear', { accountId: 'id-1', projectId: 'p1', tmuxSession: 'tmux-1' });
  assert.equal(tmuxSessionFor(dataDir, 'after-clear'), 'tmux-1');
});

// Multiple /clear calls chain the entries: each points at the previous one,
// only the last one carries the real tmux name.
test('tmuxSessionFor follows a chain to its carrier', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'second-clear', { projectId: 'p1', tmuxSession: 'first-clear' });
  setMeta(dataDir, 'first-clear', { projectId: 'p1', tmuxSession: 'tmux-1' });
  assert.equal(tmuxSessionFor(dataDir, 'second-clear'), 'tmux-1');
});

test('tmuxSessionFor stops on a cycle instead of running forever', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'a', { projectId: 'p1', tmuxSession: 'b' });
  setMeta(dataDir, 'b', { projectId: 'p1', tmuxSession: 'a' });
  assert.equal(tmuxSessionFor(dataDir, 'a'), 'b');
});

// After several /clear calls, one tmux session carries several
// conversations, but only ONE of them is running right now.
test('currentConversationFor returns the session itself as long as there was no switch', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  assert.equal(currentConversationFor(dataDir, 'tmux-1'), 'tmux-1');
});

test('currentConversationFor returns the most recently reported Claude ID', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'tmux-1', { projectId: 'p1', currentSession: 'after-clear' });
  assert.equal(currentConversationFor(dataDir, 'tmux-1'), 'after-clear');
});

test('recordClaudeSwitch links the new conversation to its carrier', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  assert.equal(recordClaudeSwitch(dataDir, 'carrier-1', 'fresh-1'), true);
  assert.deepEqual(getMeta(dataDir, 'fresh-1'), {
    accountId: 'id-1',
    projectId: 'proj-1',
    tmuxSession: 'carrier-1',
  });
  assert.equal(getMeta(dataDir, 'carrier-1').currentSession, 'fresh-1');
});

test('recordClaudeSwitch carries the accountId into the new entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });

  assert.equal(recordClaudeSwitch(dir, 'carrier-1', 'cleared-1'), true);

  assert.deepEqual(getMeta(dir, 'cleared-1'), {
    accountId: 'id-1',
    projectId: 'proj-1',
    tmuxSession: 'carrier-1',
  });
});

test('recordClaudeSwitch writes nothing twice and nothing for unknown carriers', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  recordClaudeSwitch(dataDir, 'carrier-1', 'fresh-1');
  // Second run with the same pairing must not report a write - otherwise
  // every list request would rewrite session-meta.json.
  assert.equal(recordClaudeSwitch(dataDir, 'carrier-1', 'fresh-1'), false);
  // A carrier Claudux never started (hand-made tmux session) stays out.
  assert.equal(recordClaudeSwitch(dataDir, 'foreign-1', 'fresh-2'), false);
  assert.equal(getMeta(dataDir, 'fresh-2'), null);
  // A session carrying its own conversation has nothing to map.
  assert.equal(recordClaudeSwitch(dataDir, 'carrier-1', 'carrier-1'), false);
});

// ---------- Not parsing the same file over and over ----------
//
// Every getMeta/tmuxSessionFor/claudeSessionIdsForTmux reads and parses the
// whole file. One list request calls those a few times per session, and the
// sidebar tick does that for every project.

test('getMeta does not read the file again when nothing has changed', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'sess', { accountId: 'id-1' });
  getMeta(dataDir, 'sess');

  const readMock = t.mock.method(fs, 'readFileSync');
  assert.equal(getMeta(dataDir, 'sess').accountId, 'id-1');

  assert.equal(readMock.mock.calls.length, 0, 'the unchanged file was read again');
});

// Claudux's own write path. Without invalidation here, a session would keep
// its old carrier after a /clear and show up as ended while it runs.
test('getMeta sees a value written through setMeta right away', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'sess', { accountId: 'id-1' });
  assert.equal(getMeta(dataDir, 'sess').accountId, 'id-1');

  setMeta(dataDir, 'sess', { accountId: 'id-2' });

  assert.equal(getMeta(dataDir, 'sess').accountId, 'id-2');
});

// A write past setMeta - what the tests themselves do when they lay down a
// fixture, and the only way the file changes without this module noticing.
test('getMeta sees a change made to the file directly', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-meta-'));
  setMeta(dataDir, 'sess', { accountId: 'id-1' });
  assert.equal(getMeta(dataDir, 'sess').accountId, 'id-1');

  fs.writeFileSync(
    path.join(dataDir, 'session-meta.json'),
    JSON.stringify({ sess: { accountId: 'id-written-past-setMeta' } }, null, 2),
  );

  assert.equal(getMeta(dataDir, 'sess').accountId, 'id-written-past-setMeta');
});
