// The update itself: order of the steps, and the rollback that has to work
// without the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUpdateJob, cleanupOldModules } from '../src/lib/updateRun.js';

const ROOT = '/srv/example/claudux';

function jobFixture({ failAt = null } = {}) {
  const calls = [];
  const renames = [];
  const removed = [];
  // Everything that touches the filesystem, in the order it happened - the
  // rename only works if the leftover directory is gone first.
  const order = [];
  let restarted = null;

  const job = createUpdateJob({
    rootDir: ROOT,
    runFn: async (cmd, args) => {
      const label = `${cmd} ${args.join(' ')}`;
      calls.push(label);
      if (failAt && label.startsWith(failAt)) throw new Error('boom');
      if (label.startsWith('git rev-parse')) return { stdout: 'abc1234\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    renameFn: async (from, to) => {
      renames.push(`${from} -> ${to}`);
      order.push(`rename ${from} -> ${to}`);
    },
    rmFn: async (target) => {
      removed.push(target);
      order.push(`rm ${target}`);
    },
    unitFn: () => 'claudux.service',
    restartFn: async (unit) => { restarted = unit; },
  });

  return { job, calls, renames, removed, order, restarted: () => restarted };
}

test('the happy path fetches, moves node_modules aside, checks out and installs', async () => {
  const fx = jobFixture();
  await fx.job.start('v1.1.0');

  assert.deepEqual(fx.calls, [
    'git fetch --tags --prune origin',
    'git rev-parse HEAD',
    'git checkout --detach tags/v1.1.0',
    'npm ci --omit=dev',
  ]);
  assert.deepEqual(fx.renames, [`${ROOT}/node_modules -> ${ROOT}/node_modules.old`]);
  assert.equal(fx.job.status().phase, 'restarting');
  assert.equal(fx.restarted(), 'claudux.service');
});

// Two things at once. A leftover node_modules.old from an earlier update
// would make the rename fail with ENOTEMPTY and lock every further update
// out, so it goes first. What the rename then produces stays until the
// restart: the running process still uses its esbuild binary, and it is the
// rollback for a failure during the install.
test('the happy path clears a leftover node_modules.old before the rename and keeps the new one', async () => {
  const fx = jobFixture();
  await fx.job.start('v1.1.0');

  assert.deepEqual(fx.order, [
    `rm ${ROOT}/node_modules.old`,
    `rename ${ROOT}/node_modules -> ${ROOT}/node_modules.old`,
  ]);
});

test('a failing checkout rolls back to the previous commit and restores node_modules', async () => {
  const fx = jobFixture({ failAt: 'git checkout' });
  await fx.job.start('v1.1.0');

  assert.ok(fx.calls.includes('git checkout --detach abc1234'));
  assert.deepEqual(fx.renames, [
    `${ROOT}/node_modules -> ${ROOT}/node_modules.old`,
    `${ROOT}/node_modules.old -> ${ROOT}/node_modules`,
  ]);
  assert.equal(fx.job.status().phase, 'failed');
  assert.match(fx.job.status().error, /boom/);
  assert.equal(fx.restarted(), null);
});

// The case the rename exists for: npm ci deletes node_modules first, so a
// second npm ci as the rollback would fail for the same reason and leave a
// half directory behind. The rollback removes what the failed install left
// and renames the intact one back.
test('a failing install restores the old node_modules without running npm again', async () => {
  const fx = jobFixture({ failAt: 'npm ci' });
  await fx.job.start('v1.1.0');

  assert.deepEqual(fx.removed, [`${ROOT}/node_modules.old`, `${ROOT}/node_modules`]);
  assert.deepEqual(fx.renames, [
    `${ROOT}/node_modules -> ${ROOT}/node_modules.old`,
    `${ROOT}/node_modules.old -> ${ROOT}/node_modules`,
  ]);
  assert.equal(fx.calls.filter((c) => c.startsWith('npm ci')).length, 1);
  assert.equal(fx.job.status().phase, 'failed');
});

test('without a systemd unit the job ends in restart-required', async () => {
  const job = createUpdateJob({
    rootDir: ROOT,
    runFn: async () => ({ stdout: 'abc\n', stderr: '' }),
    renameFn: async () => {},
    rmFn: async () => {},
    unitFn: () => null,
    restartFn: async () => { throw new Error('must not be called'); },
  });

  await job.start('v1.1.0');
  assert.equal(job.status().phase, 'restart-required');
});

// isRunning is what the route reads before it starts anything - a second
// POST has to answer 409 without waiting for the first run to finish.
test('isRunning is true while a run is in flight and false afterwards', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = createUpdateJob({
    rootDir: ROOT,
    runFn: async () => { await gate; return { stdout: 'abc\n', stderr: '' }; },
    renameFn: async () => {},
    rmFn: async () => {},
    unitFn: () => null,
    restartFn: async () => {},
  });

  assert.equal(job.isRunning(), false);
  const first = job.start('v1.1.0');
  assert.equal(job.isRunning(), true);
  release();
  await first;
  assert.equal(job.isRunning(), false);
});

test('a second start while one is running is rejected as busy', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = createUpdateJob({
    rootDir: ROOT,
    runFn: async () => { await gate; return { stdout: 'abc\n', stderr: '' }; },
    renameFn: async () => {},
    rmFn: async () => {},
    unitFn: () => null,
    restartFn: async () => {},
  });

  const first = job.start('v1.1.0');
  await assert.rejects(() => job.start('v1.1.0'), (err) => err.code === 'BUSY');
  release();
  await first;
});

// A successful update leaves node_modules.old behind until the restart. If
// git saw it, the tree would be dirty and updateReadiness would refuse the
// NEXT update - one update would have blocked every one after it.
test('the directory left behind by an update is ignored by git', async () => {
  const root = path.join(import.meta.dirname, '..');
  // Without the trailing slash, the way `git status` reports it in a clone
  // that has just been updated.
  const check = spawnSync('git', ['check-ignore', '-q', 'node_modules.old'], { cwd: root });
  assert.equal(check.status, 0, 'node_modules.old must be listed in .gitignore');
});

test('cleanupOldModules removes the leftover directory', async () => {
  const removed = [];
  await cleanupOldModules({ rootDir: ROOT, rmFn: async (target) => { removed.push(target); } });
  assert.deepEqual(removed, [`${ROOT}/node_modules.old`]);
});
