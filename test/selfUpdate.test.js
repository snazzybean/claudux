// May this instance update itself? Installation mode plus the two
// preconditions in the checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMode,
  readCheckoutState,
  updateReadiness,
  systemdUnit,
  restartUnit,
} from '../src/lib/selfUpdate.js';

const ROOT = '/srv/example/claudux';

test('detectMode recognises the container by /.dockerenv', () => {
  const existsFn = (p) => p === '/.dockerenv';
  assert.equal(detectMode({ rootDir: ROOT, existsFn }), 'docker');
});

test('detectMode recognises npx by the cache path', () => {
  const existsFn = () => false;
  assert.equal(
    detectMode({ rootDir: '/home/someone/.npm/_npx/abc123/node_modules/claudux', existsFn }),
    'npx',
  );
});

test('detectMode recognises the checkout by .git', () => {
  const existsFn = (p) => p === `${ROOT}/.git`;
  assert.equal(detectMode({ rootDir: ROOT, existsFn }), 'checkout');
});

test('detectMode says unknown when nothing matches', () => {
  assert.equal(detectMode({ rootDir: ROOT, existsFn: () => false }), 'unknown');
});

// git output as it actually arrives: --porcelain is empty for a clean tree,
// --exact-match exits non-zero when HEAD is not a tag.
function gitFixture({ porcelain = '', tag = 'v1.0.2', tagFails = false }) {
  return async (cmd, args) => {
    assert.equal(cmd, 'git');
    if (args.includes('--porcelain')) return { stdout: porcelain, stderr: '' };
    if (args.includes('--exact-match')) {
      if (tagFails) throw new Error('fatal: no tag exactly matches');
      return { stdout: `${tag}\n`, stderr: '' };
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

test('readCheckoutState reports a clean tree on a tag', async () => {
  const state = await readCheckoutState({ rootDir: ROOT, runFn: gitFixture({}) });
  assert.deepEqual(state, { clean: true, tag: 'v1.0.2' });
});

test('readCheckoutState reports a dirty tree', async () => {
  const state = await readCheckoutState({
    rootDir: ROOT,
    runFn: gitFixture({ porcelain: ' M src/server.js\n' }),
  });
  assert.equal(state.clean, false);
});

test('readCheckoutState reports a missing tag as null instead of throwing', async () => {
  const state = await readCheckoutState({ rootDir: ROOT, runFn: gitFixture({ tagFails: true }) });
  assert.equal(state.tag, null);
});

test('updateReadiness allows the update on a clean checkout at a tag', async () => {
  const readiness = await updateReadiness({
    rootDir: ROOT,
    existsFn: (p) => p === `${ROOT}/.git`,
    runFn: gitFixture({}),
  });
  assert.deepEqual(readiness, { mode: 'checkout', canUpdate: true, reason: null });
});

// The development checkout locks itself out through the second condition -
// no special case needed for it.
test('updateReadiness blocks a checkout that is not at a tag', async () => {
  const readiness = await updateReadiness({
    rootDir: ROOT,
    existsFn: (p) => p === `${ROOT}/.git`,
    runFn: gitFixture({ tagFails: true }),
  });
  assert.equal(readiness.canUpdate, false);
  assert.match(readiness.reason, /release tag/i);
});

test('updateReadiness blocks a dirty checkout and names it', async () => {
  const readiness = await updateReadiness({
    rootDir: ROOT,
    existsFn: (p) => p === `${ROOT}/.git`,
    runFn: gitFixture({ porcelain: ' M src/server.js\n' }),
  });
  assert.equal(readiness.canUpdate, false);
  assert.match(readiness.reason, /uncommitted/i);
});

test('updateReadiness points docker and npx at their own way', async () => {
  const docker = await updateReadiness({ rootDir: ROOT, existsFn: (p) => p === '/.dockerenv' });
  assert.equal(docker.canUpdate, false);
  assert.match(docker.reason, /docker pull/i);

  const npx = await updateReadiness({
    rootDir: '/home/someone/.npm/_npx/abc/node_modules/claudux',
    existsFn: () => false,
  });
  assert.equal(npx.canUpdate, false);
  assert.match(npx.reason, /npx/);
});

test('systemdUnit reads the unit out of the cgroup file', () => {
  const readFileFn = () => '0::/system.slice/claudux.service\n';
  assert.equal(systemdUnit({ readFileFn }), 'claudux.service');
});

// Not under systemd: a container or a plain `npm start` has no unit, and the
// job must say "restart required" rather than call systemctl into the void.
test('systemdUnit returns null outside a service cgroup', () => {
  assert.equal(systemdUnit({ readFileFn: () => '0::/user.slice/session-3.scope\n' }), null);
  assert.equal(systemdUnit({ readFileFn: () => { throw new Error('ENOENT'); } }), null);
});

const cgroup = () => '0::/system.slice/claudux.service\n';

test('restartUnit names the unit when this process is its main process', async () => {
  const unit = await restartUnit({
    readFileFn: cgroup,
    pid: 4711,
    runFn: async () => ({ stdout: '4711\n', stderr: '' }),
  });
  assert.equal(unit, 'claudux.service');
});

// The cgroup answers for every process inside the unit, including a claudux
// started from a second checkout inside one of its own sessions. Restarting
// on that answer alone would take down the production instance instead of
// the one being updated - which is exactly what happened once.
test('restartUnit refuses when another process is the main process', async () => {
  const unit = await restartUnit({
    readFileFn: cgroup,
    pid: 4711,
    runFn: async () => ({ stdout: '377031\n', stderr: '' }),
  });
  assert.equal(unit, null);
});

test('restartUnit refuses when systemctl cannot be asked', async () => {
  const unit = await restartUnit({
    readFileFn: cgroup,
    pid: 4711,
    runFn: async () => { throw new Error('systemctl: not found'); },
  });
  assert.equal(unit, null);
});
