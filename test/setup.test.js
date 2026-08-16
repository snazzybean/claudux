import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMissingBinaries,
  detectPackageManager,
  installCommandFor,
  ensurePrerequisites,
} from '../scripts/setup.js';

test('detectMissingBinaries reports only the missing names', () => {
  const checkFn = (bin) => bin === 'tmux';
  const missing = detectMissingBinaries({ checkFn, binaries: ['tmux', 'ttyd'] });
  assert.deepEqual(missing, ['ttyd']);
});

test('detectMissingBinaries reports an empty list when everything is there', () => {
  const missing = detectMissingBinaries({ checkFn: () => true, binaries: ['tmux', 'ttyd'] });
  assert.deepEqual(missing, []);
});

test('detectPackageManager recognizes brew on macOS', () => {
  const manager = detectPackageManager({ platform: 'darwin', checkFn: (bin) => bin === 'brew' });
  assert.equal(manager, 'brew');
});

test('detectPackageManager recognizes apt on Linux when dnf/pacman are missing', () => {
  const manager = detectPackageManager({ platform: 'linux', checkFn: (bin) => bin === 'apt-get' });
  assert.equal(manager, 'apt');
});

test('detectPackageManager returns null when nothing is recognized', () => {
  const manager = detectPackageManager({ platform: 'linux', checkFn: () => false });
  assert.equal(manager, null);
});

test('installCommandFor builds the right command per package manager', () => {
  assert.deepEqual(installCommandFor('brew', ['tmux', 'ttyd']), ['brew', 'install', 'tmux', 'ttyd']);
  assert.deepEqual(installCommandFor('apt', ['tmux']), ['apt-get', 'install', '-y', 'tmux']);
  assert.deepEqual(installCommandFor('dnf', ['tmux']), ['dnf', 'install', '-y', 'tmux']);
  assert.deepEqual(installCommandFor('pacman', ['tmux']), ['pacman', '-S', '--noconfirm', 'tmux']);
});

test('ensurePrerequisites reports nothing missing when every binary is there', async () => {
  const result = await ensurePrerequisites({
    checkFn: () => true,
    platform: 'darwin',
    confirmFn: async () => { throw new Error('must not ask'); },
    installFn: () => { throw new Error('must not install'); },
    log: () => {},
  });
  assert.deepEqual(result.missing, []);
  assert.equal(result.claudePresent, true);
});

test('ensurePrerequisites installs only after the question is answered yes', async () => {
  const installed = [];
  const result = await ensurePrerequisites({
    checkFn: (bin) => bin !== 'ttyd',
    platform: 'darwin',
    confirmFn: async () => true,
    installFn: (cmd) => { installed.push(cmd); return true; },
    log: () => {},
  });
  assert.deepEqual(result.missing, ['ttyd']);
  assert.deepEqual(installed, [['brew', 'install', 'ttyd']]);
});

// A failed install is an error, not a status update: it must go to
// logError (stderr), not log (stdout) - a pipeline separating the two
// streams would otherwise lose it among the success messages.
test('ensurePrerequisites reports a failed install through logError, not log', async () => {
  const logged = [];
  const errors = [];
  await ensurePrerequisites({
    checkFn: (bin) => bin !== 'ttyd',
    platform: 'darwin',
    confirmFn: async () => true,
    installFn: () => false,
    log: (msg) => logged.push(msg),
    logError: (msg) => errors.push(msg),
  });
  assert.deepEqual(errors, ['Installation failed - please install manually.']);
  assert.ok(!logged.some((msg) => msg.includes('Installation failed')));
});

test('ensurePrerequisites installs nothing when the question is answered no', async () => {
  let called = false;
  await ensurePrerequisites({
    checkFn: (bin) => bin !== 'ttyd',
    platform: 'darwin',
    confirmFn: async () => false,
    installFn: () => { called = true; return true; },
    log: () => {},
  });
  assert.equal(called, false);
});

// A missing `claude` is reported, never installed: it is not a package the
// system package manager knows.
test('ensurePrerequisites reports a missing Claude Code CLI without installing it', async () => {
  const result = await ensurePrerequisites({
    checkFn: (bin) => bin !== 'claude',
    platform: 'linux',
    confirmFn: async () => { throw new Error('must not ask'); },
    installFn: () => { throw new Error('must not install'); },
    log: () => {},
  });
  assert.equal(result.claudePresent, false);
  assert.deepEqual(result.missing, []);
});

