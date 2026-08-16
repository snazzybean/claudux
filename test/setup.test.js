import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMissingBinaries,
  detectPackageManager,
  installCommandFor,
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

