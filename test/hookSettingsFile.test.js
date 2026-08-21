// test/hookSettingsFile.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeHookSettingsFile,
  removeHookSettingsFile,
  cleanupHookSettingsFiles,
} from '../src/lib/hookSettingsFile.js';

const SETTINGS = { hooks: { PermissionRequest: [{ hooks: [{ type: 'http' }] }] } };

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-hookfile-'));
}

test('writeHookSettingsFile creates the file with mode 0600', () => {
  const dataDir = tmpDataDir();

  const filePath = writeHookSettingsFile(dataDir, 'sess-1', SETTINGS);

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

// The file names the route that accepts this session's permission dialogs.
// Without 0700 another local account couldn't read it, but could still list
// which sessions exist.
test('writeHookSettingsFile creates the directory with mode 0700', () => {
  const dataDir = tmpDataDir();

  const filePath = writeHookSettingsFile(dataDir, 'sess-1', SETTINGS);

  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
});

// mkdirSync's mode does nothing to a directory that already exists - a
// directory left behind by an older version, or one created under a
// different umask, would keep its wider mode forever.
test('writeHookSettingsFile tightens a directory that already exists', () => {
  const dataDir = tmpDataDir();
  fs.mkdirSync(path.join(dataDir, 'hook-settings'), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.join(dataDir, 'hook-settings'), 0o755);

  const filePath = writeHookSettingsFile(dataDir, 'sess-1', SETTINGS);

  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
});

// writeFileSync's mode only applies to a file it creates - a 0644 file left
// behind by an older version would keep that mode for as long as it exists.
test('writeHookSettingsFile tightens a file that already exists', () => {
  const dataDir = tmpDataDir();
  const filePath = writeHookSettingsFile(dataDir, 'sess-1', SETTINGS);
  fs.chmodSync(filePath, 0o644);

  writeHookSettingsFile(dataDir, 'sess-1', SETTINGS);

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('writeHookSettingsFile writes the settings as readable JSON', () => {
  const dataDir = tmpDataDir();

  const filePath = writeHookSettingsFile(dataDir, 'sess-1', SETTINGS);

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), SETTINGS);
});

// The path travels to tmux as an argv element and gets resolved by `claude`
// relative to ITS OWN working directory - that's the project path
// (`tmux new-session -c <projectPath>`), not the server's directory. With a
// relative path, `claude` would start without the hook, and the session's
// permission dialogs would never reach Claudux.
test('writeHookSettingsFile returns an absolute path, even with a relative dataDir', () => {
  const filePath = writeHookSettingsFile('./data-test-hook-relative', 'sess-rel', SETTINGS);

  try {
    assert.equal(path.isAbsolute(filePath), true, `Path is relative: ${filePath}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), SETTINGS);
  } finally {
    fs.rmSync('./data-test-hook-relative', { recursive: true, force: true });
  }
});

// The session ID becomes a filename. A "../../etc/passwd" must never end up
// outside the directory.
test('writeHookSettingsFile rejects a session ID with path components', () => {
  const dataDir = tmpDataDir();

  assert.throws(() => writeHookSettingsFile(dataDir, '../../etc/passwd', SETTINGS));
});

test('removeHookSettingsFile removes the file of an ended session', () => {
  const dataDir = tmpDataDir();
  const filePath = writeHookSettingsFile(dataDir, 'sess-1', SETTINGS);

  removeHookSettingsFile(dataDir, 'sess-1');

  assert.equal(fs.existsSync(filePath), false);
});

// Best effort, like removeSessionTokenFile: the caller is a route that has
// just ended a session successfully, and an unlink error must not turn that
// into a failure.
test('removeHookSettingsFile does not throw when there is nothing to remove', () => {
  const dataDir = tmpDataDir();

  assert.doesNotThrow(() => removeHookSettingsFile(dataDir, 'does-not-exist'));
  assert.doesNotThrow(() => removeHookSettingsFile(dataDir, '../../etc/passwd'));
});

test('removeHookSettingsFile hits the file even with a relative dataDir', () => {
  const filePath = writeHookSettingsFile('./data-test-hook-relative2', 'sess-rel', SETTINGS);

  try {
    removeHookSettingsFile('./data-test-hook-relative2', 'sess-rel');
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync('./data-test-hook-relative2', { recursive: true, force: true });
  }
});

// Backdated, because a file this old is what a leftover looks like: it
// belongs to a session that has long since read it or is gone.
function backdate(filePath, ageMs) {
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(filePath, when, when);
}

test('cleanupHookSettingsFiles clears out every leftover file', () => {
  const dataDir = tmpDataDir();
  backdate(writeHookSettingsFile(dataDir, 'sess-1', SETTINGS), 60 * 60 * 1000);
  backdate(writeHookSettingsFile(dataDir, 'sess-2', SETTINGS), 60 * 60 * 1000);

  cleanupHookSettingsFiles(dataDir);

  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'hook-settings')), []);
});

// A restart of the service between the write and `claude` reading the file
// is the one moment where the sweep can do damage: the session survives the
// restart (KillMode=process), starts without its hook, and nothing says so -
// its permission dialogs would only ever appear in the terminal.
test('cleanupHookSettingsFiles keeps a file that a starting session may not have read yet', () => {
  const dataDir = tmpDataDir();
  const starting = writeHookSettingsFile(dataDir, 'sess-starting', SETTINGS);
  const old = writeHookSettingsFile(dataDir, 'sess-old', SETTINGS);
  backdate(old, 60 * 60 * 1000);

  cleanupHookSettingsFiles(dataDir);

  assert.equal(fs.existsSync(starting), true, 'the file of a starting session was swept');
  assert.equal(fs.existsSync(old), false, 'the leftover was kept');
});

test('cleanupHookSettingsFiles does not throw when the directory never existed', () => {
  assert.doesNotThrow(() => cleanupHookSettingsFiles(tmpDataDir()));
});
