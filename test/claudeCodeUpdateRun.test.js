// The job itself: the order of the steps, and how a version comparison
// decides whether anything is reported at all. No network, no filesystem -
// only `claude update` and two version reads, both through injected fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeCodeUpdateJob, releaseUrl } from '../src/lib/claudeCodeUpdateRun.js';

function versionQueue(values) {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

test('releaseUrl builds the correct GitHub release URL', () => {
  assert.equal(releaseUrl('2.1.234'), 'https://github.com/anthropics/claude-code/releases/tag/v2.1.234');
});

test('an actual version change is reported as updated and triggers a notification', async () => {
  const notified = [];
  const job = createClaudeCodeUpdateJob({
    versionFn: versionQueue(['2.1.226', '2.1.234']),
    runFn: async (cmd, args) => {
      assert.deepEqual([cmd, args], ['claude', ['update']]);
      return { stdout: '', stderr: '' };
    },
    notifyFn: async (msg) => { notified.push(msg); },
  });

  await job.start();
  const status = job.status();

  assert.equal(status.phase, 'done');
  assert.equal(status.updated, true);
  assert.equal(status.from, '2.1.226');
  assert.equal(status.to, '2.1.234');
  assert.equal(status.error, null);
  assert.ok(status.ranAt);
  assert.deepEqual(notified, [{ from: '2.1.226', to: '2.1.234' }]);
});

test('no version change is reported as up to date, without a notification', async () => {
  const notified = [];
  const job = createClaudeCodeUpdateJob({
    versionFn: versionQueue(['2.1.234', '2.1.234']),
    runFn: async () => ({ stdout: '', stderr: '' }),
    notifyFn: async (msg) => { notified.push(msg); },
  });

  await job.start();

  assert.equal(job.status().phase, 'done');
  assert.equal(job.status().updated, false);
  assert.deepEqual(notified, []);
});

test('claude update failing leaves the job failed with stderr as the reason', async () => {
  const job = createClaudeCodeUpdateJob({
    versionFn: versionQueue(['2.1.226']),
    runFn: async () => { throw new Error('claude update failed (1): network unreachable'); },
    notifyFn: async () => { throw new Error('must not be called'); },
  });

  await job.start();

  assert.equal(job.status().phase, 'failed');
  assert.match(job.status().error, /network unreachable/);
});

// A timeout rejection from runFn goes through the exact same failure path
// as any other runFn rejection - no special-casing to regress.
test('a timed-out claude update leaves the job failed with the timeout message', async () => {
  const job = createClaudeCodeUpdateJob({
    versionFn: versionQueue(['2.1.226']),
    runFn: async () => { throw new Error('claude update timed out after 600000 ms'); },
    notifyFn: async () => { throw new Error('must not be called'); },
  });

  await job.start();

  assert.equal(job.status().phase, 'failed');
  assert.match(job.status().error, /timed out after 600000 ms/);
});

// A reported success (exit 0) that left nothing behind to verify.
test('exit code 0 but the version cannot be read afterward still fails', async () => {
  let call = 0;
  const job = createClaudeCodeUpdateJob({
    versionFn: async () => (call++ === 0 ? '2.1.226' : null),
    runFn: async () => ({ stdout: '', stderr: '' }),
    notifyFn: async () => { throw new Error('must not be called'); },
  });

  await job.start();

  assert.equal(job.status().phase, 'failed');
  assert.match(job.status().error, /did not answer/);
});

test('versionFn throwing on the before-read fails the job instead of leaving it running', async () => {
  const job = createClaudeCodeUpdateJob({
    versionFn: async () => { throw new Error('claude --version is not on PATH'); },
    runFn: async () => { throw new Error('must not be called'); },
    notifyFn: async () => { throw new Error('must not be called'); },
  });

  await job.start();

  assert.equal(job.status().phase, 'failed');
  assert.match(job.status().error, /not on PATH/);
});

test('versionFn throwing on the after-read fails the job instead of leaving it running', async () => {
  let call = 0;
  const job = createClaudeCodeUpdateJob({
    versionFn: async () => {
      if (call++ === 0) return '2.1.226';
      throw new Error('claude --version is not on PATH');
    },
    runFn: async () => ({ stdout: '', stderr: '' }),
    notifyFn: async () => { throw new Error('must not be called'); },
  });

  await job.start();

  assert.equal(job.status().phase, 'failed');
  assert.match(job.status().error, /not on PATH/);
});

test('isRunning is true while a run is in flight and false afterwards', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = createClaudeCodeUpdateJob({
    versionFn: versionQueue(['2.1.226', '2.1.226']),
    runFn: async () => { await gate; return { stdout: '', stderr: '' }; },
  });

  assert.equal(job.isRunning(), false);
  const first = job.start();
  assert.equal(job.isRunning(), true);
  release();
  await first;
  assert.equal(job.isRunning(), false);
});

test('a second start while one is running is rejected as busy', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = createClaudeCodeUpdateJob({
    versionFn: versionQueue(['2.1.226', '2.1.226']),
    runFn: async () => { await gate; return { stdout: '', stderr: '' }; },
  });

  const first = job.start();
  await assert.rejects(() => job.start(), (err) => err.code === 'BUSY');
  release();
  await first;
});

test('startClaudeCodeUpdateInterval runs the job on the configured interval when enabled', async () => {
  const calls = [];
  let tick;
  const job = { start: async () => { calls.push('start'); }, isRunning: () => false, status: () => ({}) };
  const { stop } = (await import('../src/lib/claudeCodeUpdateRun.js')).startClaudeCodeUpdateInterval(
    {},
    {
      job,
      enabledFn: () => true,
      setIntervalFn: (fn) => { tick = fn; return 1; },
      clearIntervalFn: () => {},
    },
  );

  tick();
  await Promise.resolve();
  assert.deepEqual(calls, ['start']);
  stop();
});

test('startClaudeCodeUpdateInterval skips the tick when disabled', async () => {
  const calls = [];
  let tick;
  const job = { start: async () => { calls.push('start'); }, isRunning: () => false, status: () => ({}) };
  const { stop } = (await import('../src/lib/claudeCodeUpdateRun.js')).startClaudeCodeUpdateInterval(
    {},
    {
      job,
      enabledFn: () => false,
      setIntervalFn: (fn) => { tick = fn; return 1; },
      clearIntervalFn: () => {},
    },
  );

  tick();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  stop();
});
