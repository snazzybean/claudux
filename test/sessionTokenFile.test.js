// test/sessionTokenFile.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeSessionTokenFile,
  removeSessionTokenFile,
  cleanupSessionTokenFiles,
} from '../src/lib/sessionTokenFile.js';

const TOKEN = `sk-ant-oat01-${'A'.repeat(95)}`;

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tokfile-'));
}

// The whole point of this module: the token should NO LONGER sit in argv
// (world-readable there via /proc/<pid>/cmdline), but get handed over via a
// file only root can read. A mode that's too lax would just move the leak
// from the process list to the filesystem.
test('writeSessionTokenFile creates the file with mode 0600', () => {
  const dataDir = tmpDataDir();

  const filePath = writeSessionTokenFile(dataDir, 'sess-1', TOKEN);

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('writeSessionTokenFile creates the directory with mode 0700', () => {
  const dataDir = tmpDataDir();

  const filePath = writeSessionTokenFile(dataDir, 'sess-1', TOKEN);

  // Without 0700, other local accounts couldn't read the content, but they
  // could still list the directory - and see which sessions exist. Same as
  // the existing accountStore.js behavior.
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
});

// The wrapper script reads via `$(cat …)`. A trailing newline would get cut
// off by that, but the token shouldn't be altered on disk in the first
// place - otherwise the next reader would wonder whether the newline means
// something.
test('writeSessionTokenFile writes the token unchanged, without a trailing newline', () => {
  const dataDir = tmpDataDir();

  const filePath = writeSessionTokenFile(dataDir, 'sess-1', TOKEN);

  assert.equal(fs.readFileSync(filePath, 'utf8'), TOKEN);
});

// The file name travels to tmux as an argv element. A session ID with path
// components (../) must never be able to cause a write outside the
// directory.
test('writeSessionTokenFile rejects a session ID with path components', () => {
  const dataDir = tmpDataDir();

  assert.throws(() => writeSessionTokenFile(dataDir, '../../etc/passwd', TOKEN));
});

// If the session fails to start (tmux error, timeout), the wrapper script
// never deletes the file - it would be left behind with a valid token. The
// caller then has to be able to remove it itself.
test('removeSessionTokenFile removes a file left behind', () => {
  const dataDir = tmpDataDir();
  const filePath = writeSessionTokenFile(dataDir, 'sess-1', TOKEN);

  removeSessionTokenFile(dataDir, 'sess-1');

  assert.equal(fs.existsSync(filePath), false);
});

// Best effort: a duplicate call (the wrapper was faster) must not throw, or
// it would fail an otherwise successful session creation.
test('removeSessionTokenFile does not throw when the file is already gone', () => {
  const dataDir = tmpDataDir();

  assert.doesNotThrow(() => removeSessionTokenFile(dataDir, 'does-not-exist'));
});

// After a restart of the service, no waiting session can still reach an old
// file - whatever's still lying around at that point is just a token
// remnant on disk.
test('cleanupSessionTokenFiles clears out all leftover files on startup', () => {
  const dataDir = tmpDataDir();
  writeSessionTokenFile(dataDir, 'sess-1', TOKEN);
  writeSessionTokenFile(dataDir, 'sess-2', TOKEN);

  cleanupSessionTokenFiles(dataDir);

  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'session-tokens')), []);
});

test('cleanupSessionTokenFiles does not throw when the directory never existed', () => {
  assert.doesNotThrow(() => cleanupSessionTokenFiles(tmpDataDir()));
});

// The path must be absolute, regardless of how dataDir is configured: it
// travels as an argument to tmux and gets resolved by the wrapper script
// relative to ITS OWN working directory - and that's the project path
// (`tmux new-session -c <projectPath>`), not the server's directory. With a
// relative path, the script wouldn't find the file, would abort, the session
// would die immediately, and the token file would be left behind.
test('writeSessionTokenFile returns an absolute path, even with a relative dataDir', () => {
  const filePath = writeSessionTokenFile('./data-test-relative', 'sess-rel', TOKEN);

  try {
    assert.equal(path.isAbsolute(filePath), true, `Path is relative: ${filePath}`);
    // And it must actually point to where the file was written.
    assert.equal(fs.readFileSync(filePath, 'utf8'), TOKEN);
  } finally {
    fs.rmSync('./data-test-relative', { recursive: true, force: true });
  }
});

// Cross-check: removeSessionTokenFile must hit the same file, or it would be
// left behind during cleanup.
test('removeSessionTokenFile hits the file even with a relative dataDir', () => {
  const filePath = writeSessionTokenFile('./data-test-relative2', 'sess-rel', TOKEN);

  try {
    removeSessionTokenFile('./data-test-relative2', 'sess-rel');
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync('./data-test-relative2', { recursive: true, force: true });
  }
});
