import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setMeta } from '../src/lib/sessionMeta.js';
import { findReapable, hasLiveChildrenForSession, buildIsUnused, startReaperInterval } from '../src/lib/reaper.js';
import { setRemainOnExit, listTmuxSessions } from '../src/lib/tmuxManager.js';

test('findReapable skips attached sessions', async () => {
  const sessions = [{ name: '11111111-1111-1111-1111-111111111111', activityEpoch: 0, attached: true }];
  const result = await findReapable(sessions, { nowEpoch: 100000, idleThresholdSec: 10, hasLiveChildren: async () => false });
  assert.deepEqual(result, []);
});

test('findReapable skips sessions that haven\'t been idle long enough yet', async () => {
  const sessions = [{ name: '11111111-1111-1111-1111-111111111111', activityEpoch: 99995, attached: false }];
  const result = await findReapable(sessions, { nowEpoch: 100000, idleThresholdSec: 10, hasLiveChildren: async () => false });
  assert.deepEqual(result, []);
});

test('findReapable skips sessions with live child processes', async () => {
  const sessions = [{ name: '11111111-1111-1111-1111-111111111111', activityEpoch: 0, attached: false }];
  const result = await findReapable(sessions, { nowEpoch: 100000, idleThresholdSec: 10, hasLiveChildren: async () => true });
  assert.deepEqual(result, []);
});

test('findReapable reports sessions that meet all three criteria', async () => {
  const sessions = [{ name: '11111111-1111-1111-1111-111111111111', activityEpoch: 0, attached: false }];
  const result = await findReapable(sessions, { nowEpoch: 100000, idleThresholdSec: 10, hasLiveChildren: async () => false });
  assert.deepEqual(result, ['11111111-1111-1111-1111-111111111111']);
});

// The name filter applies BEFORE the other criteria are checked:
// `listTmuxSessions()` sees the entire shared tmux socket, which also
// carries sessions created by hand. A foreign session must NEVER show up in
// findReapable's result, no matter how well it meets the other criteria -
// fail-safe: better to spare it than to wrongly kill it.
test('findReapable spares sessions outside the Claudux naming scheme (foreign terminal session), even when all three other criteria are met', async () => {
  const sessions = [{ name: 'my-own-terminal', activityEpoch: 0, attached: false }];
  const result = await findReapable(sessions, { nowEpoch: 100000, idleThresholdSec: 10, hasLiveChildren: async () => false });
  assert.deepEqual(result, []);
});

test('findReapable still accepts real Claudux naming schemes (UUID, login-<hex>)', async () => {
  const sessions = [
    { name: '11111111-1111-1111-1111-111111111111', activityEpoch: 0, attached: false },
    { name: 'login-a1b2c3d4', activityEpoch: 0, attached: false },
  ];
  const result = await findReapable(sessions, { nowEpoch: 100000, idleThresholdSec: 10, hasLiveChildren: async () => false });
  assert.deepEqual(result.sort(), ['11111111-1111-1111-1111-111111111111', 'login-a1b2c3d4']);
});

// `hasLiveChildrenForSession` must not check only the first pane: here the
// running child process lives in the SECOND pane. A real test against tmux,
// because the interplay of pane order and /proc can only be verified this
// way. Cleans up after itself via `finally`.
test('hasLiveChildrenForSession checks ALL panes of a session, not just the first (multi-pane, child process in second pane)', async () => {
  // Random rather than fixed: an aborted run leaves this session behind
  // with its `sleep 3600` still running, and the next run's new-session
  // would fail on the name instead of on the behavior under test.
  const sessionName = crypto.randomUUID();
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', sessionName]);
    execFileSync('tmux', ['split-window', '-t', `=${sessionName}:0`, 'sleep 3600 & wait']);
    // Short wait so tmux/bash have actually brought up the second pane
    // including the background job before we query /proc.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await hasLiveChildrenForSession(sessionName);
    assert.equal(result, true);
  } finally {
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`]);
    } catch {
      // Session may already be gone - not a blocker for the test itself.
    }
  }
});

// Without /proc the child criterion cannot be evaluated at all: a failing
// readdir must not fall through to "no children". When in doubt, don't kill.
test('hasLiveChildrenForSession reports children when /proc is unavailable', async () => {
  // Random for the same reason as above - a leftover session under a fixed
  // name makes new-session throw, and the `finally` then kills that foreign
  // session, so the run after it passes again and hides the cause.
  const sessionName = crypto.randomUUID();
  try {
    // `sleep` rather than an interactive shell: a shell that is still
    // starting up has children of its own often enough to fail the false
    // leg below at random. sleep forks nothing, so the answer is false as
    // soon as the session exists - no waiting, no timing assumption.
    execFileSync('tmux', ['new-session', '-d', '-s', sessionName, 'sleep', '3600']);
    // A pane process without children: on Linux the answer is false, so a
    // true here can only come from the missing-/proc branch.
    assert.equal(await hasLiveChildrenForSession(sessionName), false);
    assert.equal(
      await hasLiveChildrenForSession(sessionName, { procRoot: '/nonexistent-proc' }),
      true,
    );
  } finally {
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`]);
    } catch {
      // Session may already be gone - not a blocker for the test itself.
    }
  }
});

// The four-hour idle deadline is assumed to run from the moment of death
// without any change to findReapable/hasLiveChildrenForSession: a corpse's
// pane has no children, and session_activity is expected to freeze at
// death rather than keep advancing under a live poller's Date.now(). Both
// are checked here against a real corpse, now that remain-on-exit actually
// produces one - the freeze via two real reads a couple of seconds apart,
// the childless leg via hasLiveChildrenForSession, and the combination via
// findReapable, the gate that actually uses both.
test('a corpse left behind by remain-on-exit reads as idle and childless, so it becomes reapable like any other idle session', async () => {
  // A fixed name here would leave a corpse behind on an aborted run (that's
  // the point of remain-on-exit) that then blocks the next run's
  // new-session under the same name until the reaper's four-hour deadline.
  const sessionName = crypto.randomUUID();
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', sessionName, 'sleep', '3600']);
    await setRemainOnExit(sessionName);
    const pid = execFileSync('tmux', ['list-panes', '-t', `=${sessionName}`, '-F', '#{pane_pid}']).toString().trim();
    assert.ok(pid, 'precondition: the pane PID was read');
    process.kill(Number(pid), 'SIGKILL');

    let corpse;
    for (let i = 0; i < 30; i++) {
      corpse = (await listTmuxSessions()).find((s) => s.name === sessionName);
      if (corpse?.dead) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(corpse?.dead, true, 'precondition: the pane became a corpse');

    assert.equal(await hasLiveChildrenForSession(sessionName), false);

    // If session_activity kept advancing after death, a real poller's
    // Date.now() - session_activity gap would never cross the threshold,
    // and corpses would never become reapable. Checked with a real sleep,
    // not a synthetic offset, because that failure mode would otherwise
    // stay invisible to this suite.
    const activityBefore = corpse.activityEpoch;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const activityAfter = (await listTmuxSessions()).find((s) => s.name === sessionName)?.activityEpoch;
    assert.equal(activityAfter, activityBefore, 'session_activity must not advance after death');

    // nowEpoch simulates waiting out the real four-hour deadline instead of
    // the test doing so - the freeze just proven above is what makes this
    // simulation valid.
    const result = await findReapable([corpse], {
      nowEpoch: corpse.activityEpoch + 100000,
      idleThresholdSec: 10,
      hasLiveChildren: hasLiveChildrenForSession,
    });
    assert.deepEqual(result, [sessionName]);
  } finally {
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`]);
    } catch {
      // Session may already be gone - not a blocker for the test itself.
    }
  }
});

// ---------- Protection from the reaper ----------
//
// A session with unsaved work must be able to exempt itself from the
// reaper. The protection is a field in session-meta.json and acts as
// another exclusion criterion in the same row: any single condition is
// enough to spare a session (fail-safe).
test('findReapable spares a session marked as protected', async () => {
  const name = '11111111-1111-1111-1111-111111111111';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const reapable = await findReapable(sessions, {
    nowEpoch: 100_000,
    idleThresholdSec: 60,
    hasLiveChildren: async () => false,
    isProtected: (n) => n === name,
  });

  assert.deepEqual(reapable, []);
});

test('findReapable still ends an unprotected session', async () => {
  const name = '22222222-2222-2222-2222-222222222222';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const reapable = await findReapable(sessions, {
    nowEpoch: 100_000,
    idleThresholdSec: 60,
    hasLiveChildren: async () => false,
    isProtected: () => false,
  });

  assert.deepEqual(reapable, [name]);
});

// Without the check function (callers that don't pass it), the reaper must
// behave as before - otherwise a forgotten parameter would silently spare
// every session and the reaper would be pointless.
test('findReapable behaves as before without a protection check', async () => {
  const name = '33333333-3333-3333-3333-333333333333';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const reapable = await findReapable(sessions, {
    nowEpoch: 100_000,
    idleThresholdSec: 60,
    hasLiveChildren: async () => false,
  });

  assert.deepEqual(reapable, [name]);
});

// ---------- Shorter threshold for never-used sessions ----------
//
// A session nobody ever typed a word into still occupies a full `claude`
// process and doesn't need the full grace period. The detection signal is
// the missing JSONL - Claude Code only creates its history on the first
// prompt.
//
// The check is injected instead of read here, so findReapable stays pure -
// the same design as `isProtected` next to it.
test('findReapable reaps a never-used session after the short threshold', async () => {
  const name = '44444444-4444-4444-4444-444444444444';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const reapable = await findReapable(sessions, {
    nowEpoch: 2_000, // 2000s idle: above the short, below the long threshold
    idleThresholdSec: 14_400,
    shortIdleThresholdSec: 1_800,
    hasLiveChildren: async () => false,
    isUnused: () => true,
  });

  assert.deepEqual(reapable, [name]);
});

test('findReapable spares a never-used session before the short threshold', async () => {
  const name = '44444444-4444-4444-4444-444444444444';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const reapable = await findReapable(sessions, {
    nowEpoch: 1_000, // only 1000s idle so far
    idleThresholdSec: 14_400,
    shortIdleThresholdSec: 1_800,
    hasLiveChildren: async () => false,
    isUnused: () => true,
  });

  assert.deepEqual(reapable, []);
});

// The core of the distinction: a session WITH history keeps the long
// threshold. Otherwise the rule would clean up conversations someone wants
// to come back to.
test('findReapable leaves a used session at the long threshold', async () => {
  const name = '55555555-5555-5555-5555-555555555555';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const reapable = await findReapable(sessions, {
    nowEpoch: 2_000,
    idleThresholdSec: 14_400,
    shortIdleThresholdSec: 1_800,
    hasLiveChildren: async () => false,
    isUnused: () => false,
  });

  assert.deepEqual(reapable, []);
});

// Fail-safe like isProtected: a caller that doesn't know the parameters
// gets exactly the previous behavior. The other way round, the short
// threshold would silently be active with a forgotten parameter and would
// clean up sessions earlier than anyone expects.
test('findReapable behaves unchanged without the new parameters', async () => {
  const name = '66666666-6666-6666-6666-666666666666';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const tooEarly = await findReapable(sessions, {
    nowEpoch: 2_000,
    idleThresholdSec: 14_400,
    hasLiveChildren: async () => false,
  });
  assert.deepEqual(tooEarly, [], 'without isUnused, only the long threshold counts');

  const later = await findReapable(sessions, {
    nowEpoch: 20_000,
    idleThresholdSec: 14_400,
    hasLiveChildren: async () => false,
  });
  assert.deepEqual(later, [name]);
});

// An oversized short threshold must not keep a session alive LONGER than
// the regular one - the rule is meant to shorten, never extend.
test('findReapable takes the shorter one when the thresholds are configured backwards', async () => {
  const name = '77777777-7777-7777-7777-777777777777';
  const sessions = [{ name, activityEpoch: 0, attached: false }];

  const reapable = await findReapable(sessions, {
    nowEpoch: 100,
    idleThresholdSec: 60,
    shortIdleThresholdSec: 999_999, // accidentally larger than the regular one
    hasLiveChildren: async () => false,
    isUnused: () => true,
  });

  assert.deepEqual(reapable, [name]);
});

// The remaining criteria still apply: a never-used session someone is
// attached to, or one with a running process, stays untouched. Otherwise
// the short threshold would hit exactly the session that was just started
// and where Claude Code is still starting up.
test('findReapable spares never-used sessions with a client or a running child process', async () => {
  const name = '88888888-8888-8888-8888-888888888888';
  const common = {
    nowEpoch: 100_000,
    idleThresholdSec: 14_400,
    shortIdleThresholdSec: 60,
    isUnused: () => true,
  };

  const attachedResult = await findReapable([{ name, activityEpoch: 0, attached: true }], {
    ...common,
    hasLiveChildren: async () => false,
  });
  assert.deepEqual(attachedResult, [], 'someone is watching');

  const busyResult = await findReapable([{ name, activityEpoch: 0, attached: false }], {
    ...common,
    hasLiveChildren: async () => true,
  });
  assert.deepEqual(busyResult, [], 'something is still running in the pane');

  const protectedResult = await findReapable([{ name, activityEpoch: 0, attached: false }], {
    ...common,
    hasLiveChildren: async () => false,
    isProtected: () => true,
  });
  assert.deepEqual(protectedResult, [], 'explicitly protected');
});

// ---------- Resolving "has this session ever created a history?" ----------
//
// The path there runs through three stops: session-meta.json names the
// projectId, projects.json the path, and from that comes the folder name
// under ~/.claude/projects (slashes to dashes, see encodeProjectPath). If
// the chain breaks anywhere, the session counts as used - fail-safe in the
// same direction as the rest of the file: when in doubt, the long
// threshold, never the short one.
function buildEnvironment({ withHistory }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-reaper-data-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-reaper-home-'));
  const projectPath = '/srv/testproject';
  const sessionName = '99999999-9999-9999-9999-999999999999';

  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify([{ id: 'proj-1', name: 'Test', path: projectPath }]),
  );
  setMeta(dataDir, sessionName, { projectId: 'proj-1' });

  if (withHistory) {
    const folder = path.join(claudeHome, 'projects', projectPath.replace(/\//g, '-'));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${sessionName}.jsonl`), '{"type":"user"}\n');
  }
  return { dataDir, claudeHome, sessionName };
}

test('buildIsUnused recognizes a session without JSONL as unused', () => {
  const { dataDir, claudeHome, sessionName } = buildEnvironment({ withHistory: false });
  assert.equal(buildIsUnused({ claudeHome, dataDir })(sessionName), true);
});

test('buildIsUnused recognizes a session with JSONL as used', () => {
  const { dataDir, claudeHome, sessionName } = buildEnvironment({ withHistory: true });
  assert.equal(buildIsUnused({ claudeHome, dataDir })(sessionName), false);
});

// Without a meta entry, the project path is unknown - then there's no place
// where a JSONL would be expected, and "no file found" wouldn't mean "never
// used". This is exactly where fail-safe must kick in, otherwise the
// reaper would clean up sessions early that it knows nothing about (the
// login-<hex> sessions also have no meta entry).
test('buildIsUnused treats a session without a meta entry as used', () => {
  const { dataDir, claudeHome } = buildEnvironment({ withHistory: false });
  assert.equal(buildIsUnused({ claudeHome, dataDir })('login-abc123'), false);
});

test('buildIsUnused treats a session with an unknown projectId as used', () => {
  const { dataDir, claudeHome } = buildEnvironment({ withHistory: false });
  setMeta(dataDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { projectId: 'does-not-exist' });
  assert.equal(
    buildIsUnused({ claudeHome, dataDir })('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    false,
  );
});

test('buildIsUnused spares everything when claudeHome is missing', () => {
  const { dataDir, sessionName } = buildEnvironment({ withHistory: false });
  assert.equal(buildIsUnused({ claudeHome: undefined, dataDir })(sessionName), false);
});

// Login sessions are transient: they show a freshly generated token in
// plain text on screen and have served their purpose once it's saved.
// Hence a dedicated, shorter threshold - via isUnused they would otherwise
// run under the same half hour as a session nobody ever typed anything
// into.
test('findReapable cleans up login sessions after the short login threshold', async () => {
  const sessions = [{ name: 'login-a1b2c3d4', activityEpoch: 99000, attached: false }];

  const result = await findReapable(sessions, {
    nowEpoch: 100000,
    idleThresholdSec: 14400,
    loginIdleThresholdSec: 900,
    hasLiveChildren: async () => false,
  });

  assert.deepEqual(result, ['login-a1b2c3d4']);
});

test('findReapable spares a login session within the login threshold', async () => {
  const sessions = [{ name: 'login-a1b2c3d4', activityEpoch: 99500, attached: false }];

  const result = await findReapable(sessions, {
    nowEpoch: 100000,
    idleThresholdSec: 14400,
    loginIdleThresholdSec: 900,
    hasLiveChildren: async () => false,
  });

  assert.deepEqual(result, []);
});

// The login threshold applies ONLY to login sessions - a normal session
// with the same idle time stays put.
test('the login threshold doesn\'t carry over to ordinary sessions', async () => {
  const sessions = [{ name: '11111111-1111-1111-1111-111111111111', activityEpoch: 99000, attached: false }];

  const result = await findReapable(sessions, {
    nowEpoch: 100000,
    idleThresholdSec: 14400,
    loginIdleThresholdSec: 900,
    hasLiveChildren: async () => false,
  });

  assert.deepEqual(result, []);
});

// A forgotten parameter must not silently make the reaper stricter:
// without loginIdleThresholdSec, what applied before continues to apply
// for login sessions.
test('without loginIdleThresholdSec, prior behavior stays unchanged', async () => {
  const sessions = [{ name: 'login-a1b2c3d4', activityEpoch: 99000, attached: false }];

  const result = await findReapable(sessions, {
    nowEpoch: 100000,
    idleThresholdSec: 14400,
    hasLiveChildren: async () => false,
  });

  assert.deepEqual(result, []);
});

// The protection against killing sessions with background jobs does NOT
// apply to login sessions: there, `claude setup-token` itself is the
// process meant to go away. With the rule, the short deadline would never
// apply in exactly the abort case - namely when setup-token is still
// waiting for input that never comes.
test('a login session gets cleaned up even with live child processes', async () => {
  const sessions = [{ name: 'login-a1b2c3d4', activityEpoch: 99000, attached: false }];

  const result = await findReapable(sessions, {
    nowEpoch: 100000,
    idleThresholdSec: 14400,
    loginIdleThresholdSec: 900,
    hasLiveChildren: async () => true,
  });

  assert.deepEqual(result, ['login-a1b2c3d4']);
});

// For ordinary sessions, the protection stays untouched.
test('an ordinary session with live child processes stays protected', async () => {
  const sessions = [{ name: '11111111-1111-1111-1111-111111111111', activityEpoch: 0, attached: false }];

  const result = await findReapable(sessions, {
    nowEpoch: 100000,
    idleThresholdSec: 10,
    loginIdleThresholdSec: 900,
    hasLiveChildren: async () => true,
  });

  assert.deepEqual(result, []);
});

// Without a login threshold set, everything here also stays as before - a
// forgotten parameter must not make the reaper stricter.
test('without a login threshold, hasLiveChildren also protects a login session', async () => {
  const sessions = [{ name: 'login-a1b2c3d4', activityEpoch: 0, attached: false }];

  const result = await findReapable(sessions, {
    nowEpoch: 100000,
    idleThresholdSec: 10,
    hasLiveChildren: async () => true,
  });

  assert.deepEqual(result, []);
});

// ---------- In-process interval ----------
//
// The reaper runs on a regular interval within the server process, not from
// an external scheduler.
test('startReaperInterval calls runFn on every tick', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const stop = startReaperInterval({}, {
    intervalMs: 1000,
    runFn: async () => { calls++; return []; },
  });
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  t.mock.timers.tick(2000);
  assert.equal(calls, 3);
  stop();
});

test('startReaperInterval: stop() prevents further ticks', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const stop = startReaperInterval({}, {
    intervalMs: 1000,
    runFn: async () => { calls++; return []; },
  });
  stop();
  t.mock.timers.tick(5000);
  assert.equal(calls, 0);
});
