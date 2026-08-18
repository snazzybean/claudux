// Reads the installed CLI version - independent of installation method,
// never assumes where the binary lives. Never throws: an unreadable
// version is as informative as one that doesn't exist yet, and every
// caller has to handle "no answer" anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, readClaudeCodeVersion } from '../src/lib/claudeCodeVersion.js';

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
