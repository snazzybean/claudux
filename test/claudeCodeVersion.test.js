// Reads the installed CLI version - independent of installation method,
// never assumes where the binary lives. Never throws: an unreadable
// version is as informative as one that doesn't exist yet, and every
// caller has to handle "no answer" anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVersion, readClaudeCodeVersion, readInstallMethod } from '../src/lib/claudeCodeVersion.js';

test('parseVersion extracts the leading semver', () => {
  assert.equal(parseVersion('2.1.226 (Claude Code)\n'), '2.1.226');
});

test('parseVersion returns null for unparseable output', () => {
  assert.equal(parseVersion('command not found'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('readClaudeCodeVersion returns the parsed version on success', async () => {
  const version = await readClaudeCodeVersion({
    runFn: async (cmd, args) => {
      assert.deepEqual([cmd, args], ['claude', ['--version']]);
      return { stdout: '2.1.226 (Claude Code)\n', stderr: '' };
    },
  });
  assert.equal(version, '2.1.226');
});

test('readClaudeCodeVersion returns null instead of throwing when the command fails', async () => {
  const version = await readClaudeCodeVersion({
    runFn: async () => { throw new Error('command not found'); },
  });
  assert.equal(version, null);
});

test('readClaudeCodeVersion returns null for output it cannot parse', async () => {
  const version = await readClaudeCodeVersion({
    runFn: async () => ({ stdout: 'not a version', stderr: '' }),
  });
  assert.equal(version, null);
});

function tmpClaudeJsonPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-installmethod-')), '.claude.json');
}

test('readInstallMethod returns the raw installMethod string from a valid file', () => {
  const claudeJsonPath = tmpClaudeJsonPath();
  fs.writeFileSync(claudeJsonPath, JSON.stringify({ installMethod: 'global' }));
  assert.equal(readInstallMethod({ claudeJsonPath }), 'global');
});

test('readInstallMethod returns null when the file does not exist', () => {
  const claudeJsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-installmethod-')), 'missing.json');
  assert.equal(readInstallMethod({ claudeJsonPath }), null);
});

test('readInstallMethod returns null for unparseable content', () => {
  const claudeJsonPath = tmpClaudeJsonPath();
  fs.writeFileSync(claudeJsonPath, 'not json');
  assert.equal(readInstallMethod({ claudeJsonPath }), null);
});
