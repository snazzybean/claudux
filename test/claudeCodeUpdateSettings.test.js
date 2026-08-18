// The auto-update toggle: a single persistent setting, default on - a
// missing or corrupt file must not silently turn off a feature explicitly
// asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAutoUpdateEnabled, writeAutoUpdateEnabled } from '../src/lib/claudeCodeUpdateSettings.js';

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-ccupdate-')), 'claude-update.json');
}

test('reads true when the file does not exist yet', () => {
  assert.equal(readAutoUpdateEnabled(tmpPath()), true);
});

test('round-trips a written value', () => {
  const p = tmpPath();
  writeAutoUpdateEnabled(p, false);
  assert.equal(readAutoUpdateEnabled(p), false);
  writeAutoUpdateEnabled(p, true);
  assert.equal(readAutoUpdateEnabled(p), true);
});

test('treats unreadable content as enabled rather than failing', () => {
  const p = tmpPath();
  fs.writeFileSync(p, 'not json');
  assert.equal(readAutoUpdateEnabled(p), true);
});
