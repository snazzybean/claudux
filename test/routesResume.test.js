// POST /api/sessions/:id/resume in all its shapes: with and without a
// sessionMeta entry, on a running session, and on a corpse left behind by a
// crash or by the reaper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.js';
import {
  killSession,
  hasSession,
  setRemainOnExit,
  listTmuxSessions,
} from '../src/lib/tmuxManager.js';
import { addAccount, updateAccount, removeAccount } from '../src/lib/accountStore.js';
import { setMeta, getMeta } from '../src/lib/sessionMeta.js';
import {
  VALID_TOKEN,
  tmpConfig,
  startApp,
  tmpProject,
  postJson,
  patchJson,
  killSessionEventually,
  crashPaneProcess,
  assertAliveSession,
  startedSession,
} from './helpers/routeHarness.js';

// A missing sessionMeta entry alone does NOT trigger a 404 - the route
// then falls back to projectId/account from the body. Without meta AND
// without projectId, 404 is still correct, because no project can be
// resolved.
test('POST /api/sessions/:id/resume returns 404 without meta and without projectId in the body', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/unknown-session/resume`, {
    method: 'POST',
  });

  assert.equal(res.status, 404);
  server.close();
});

test('POST /api/sessions/:id/resume returns 400 for an invalid session ID', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent('has:colon')}/resume`, {
    method: 'POST',
  });

  assert.equal(res.status, 400);
  server.close();
});

test('POST /api/sessions/:id/resume creates a new tmux session when metadata is present', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'resume-demo');
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'private', 'sk-test-token');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ResumeDemo', projectPath }),
  });
  const project = await projectRes.json();

  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: account.id }),
  });
  const session = await sessionRes.json();

  const resumeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/resume`, {
    method: 'POST',
  });
  const resumed = await resumeRes.json();

  assert.equal(resumeRes.status, 200);
  assert.equal(resumed.id, session.id);
  assert.equal(resumed.terminalUrl, `/ttyd/?arg=${session.id}`);
  // Cleanup: one call ends the session both spawns share.
  await killSessionEventually(session.id);
  server.close();
});

// A resume after /clear whose carrier session is no longer running: the
// route then starts a tmux session under its OWN name. If the old
// `tmuxSession` reference stayed in place, the sidebar kept looking for
// the live dot under the dead carrier.
test('POST /api/sessions/:id/resume clears the carrier reference when the session carries itself again', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'resume-carrier');
  const { addAccount } = await import('../src/lib/accountStore.js');
  const { setMeta, getMeta } = await import('../src/lib/sessionMeta.js');
  const account = addAccount(config.accountsSecretPath, 'private', 'sk-test-token');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ResumeCarrier', projectPath }),
  });
  const project = await projectRes.json();

  const afterClear = 'session-orphaned-carrier';
  setMeta(config.dataDir, afterClear, {
    accountId: account.id,
    projectId: project.id,
    tmuxSession: 'carrier-no-longer-running',
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${afterClear}/resume`, { method: 'POST' });
  const resumed = await res.json();

  assert.equal(res.status, 200);
  // Under its own name, not under that of the dead carrier.
  assert.equal(resumed.terminalUrl, `/ttyd/?arg=${afterClear}`);
  const meta = getMeta(config.dataDir, afterClear);
  assert.equal(meta.tmuxSession, undefined, 'the reference to the dead carrier must be gone');
  assert.equal(meta.accountId, account.id, 'the account assignment must not get lost in the process');

  await killSessionEventually(afterClear);
  server.close();
});

// After a /clear, the row with the green dot carries the NEW Claude ID,
// under which no tmux session is running. Without the carrier resolution,
// ending it reported success without ending anything.
test('DELETE /api/sessions/:id ends the carrier session when the ID is from after a /clear', async () => {
  const config = tmpConfig();
  const { setMeta } = await import('../src/lib/sessionMeta.js');
  const { spawnTmux, waitForSession, hasSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const carrier = 'session-carrier-kill';
  const afterClear = 'session-after-clear-kill';
  setMeta(config.dataDir, afterClear, { projectId: 'p1', tmuxSession: carrier });
  spawnTmux(['new-session', '-d', '-s', carrier, 'sleep', '30']);
  await waitForSession(carrier);

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${afterClear}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(await hasSession(carrier), false, 'the carrier session is still running');

  await killSessionEventually(carrier);
  server.close();
});

// Pre-existing sessions from the JSONL history were never started via
// Claudux and therefore have no sessionMeta entry - if the route required
// one, practically every session listed in the sidebar would fail with
// 404. The test simulates exactly that: a sessionId without setMeta(),
// with projectId/accountId in the body, the way the sidebar supplies them.
// A second account is registered so the auto-select branch (exactly one
// account registered) can't paper over a wrong or missing accountId.
test('POST /api/sessions/:id/resume also works without a prior sessionMeta entry (body supplies projectId/accountId)', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'legacy-session-project');
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'private', VALID_TOKEN);
  addAccount(config.accountsSecretPath, 'work', `${VALID_TOKEN}b`);

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'LegacyProject', projectPath }),
  });
  const project = await projectRes.json();

  // Session ID that was NEVER created via Claudux (no setMeta call) -
  // stands in for a pre-existing session listed in the sidebar from the
  // JSONL history.
  const sessionId = crypto.randomUUID();
  const resumeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, accountId: account.id }),
  });
  const resumed = await resumeRes.json();

  assert.equal(resumeRes.status, 200);
  assert.equal(resumed.id, sessionId);
  assert.equal(resumed.terminalUrl, `/ttyd/?arg=${sessionId}`);

  // Meta must now have been written back: a second resume WITHOUT a body
  // works again via the known meta path (no more 404/400, even though
  // projectId/accountId is no longer sent along, and a second account is
  // registered - without the write-back this would 400, not just 404).
  const secondRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, {
    method: 'POST',
  });
  assert.equal(secondRes.status, 200);

  await killSessionEventually(sessionId);
  server.close();
});

test('POST /api/sessions/:id/resume without meta and without account in the body auto-selects the only registered account', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'legacy-single-account-project');
  const { addAccount } = await import('../src/lib/accountStore.js');
  addAccount(config.accountsSecretPath, 'private', 'sk-test-token');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'LegacySingleAccountProject', projectPath }),
  });
  const project = await projectRes.json();

  const sessionId = crypto.randomUUID();
  const resumeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id }),
  });
  const resumed = await resumeRes.json();

  assert.equal(resumeRes.status, 200);
  assert.equal(resumed.id, sessionId);

  await killSessionEventually(sessionId);
  server.close();
});

// Multiple accounts registered, the body names none: the route can't
// guess and must say so with 400, instead of falsely returning 404 or
// silently picking some account.
test('POST /api/sessions/:id/resume without meta and without account in the body returns 400 when multiple accounts are registered', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'legacy-multi-account-project');
  const { addAccount } = await import('../src/lib/accountStore.js');
  addAccount(config.accountsSecretPath, 'private', 'sk-test-token-1');
  addAccount(config.accountsSecretPath, 'work', 'sk-test-token-2');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'LegacyMultiAccountProject', projectPath }),
  });
  const project = await projectRes.json();

  const sessionId = crypto.randomUUID();
  const resumeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id }),
  });
  const body = await resumeRes.json();

  assert.equal(resumeRes.status, 400);
  assert.ok(body.error);
  assert.match(body.error, /account/i);
  server.close();
});

// ---------- Session routes on ids, not names ----------
//
// session-meta.json references the account by id, so renaming an account
// keeps the reference intact.

test('creating a session stores the accountId and rejects an unknown one', async () => {
  const config = tmpConfig();
  const account = addAccount(config.accountsSecretPath, 'work', VALID_TOKEN);
  const project = tmpProject(config);
  const { port, close } = startApp(config);

  const bad = await postJson(port, `/api/projects/${project.id}/sessions`, { accountId: 'no-such-id' });
  assert.equal(bad.status, 400);

  const created = await postJson(port, `/api/projects/${project.id}/sessions`, { accountId: account.id });
  const body = await created.json();
  assert.equal(created.status, 201);
  assert.equal(getMeta(config.dataDir, body.id).accountId, account.id);

  await killSession(body.id).catch(() => {});
  close();
});

// The name may change, the id reference does not.
test('resuming still works after the account was renamed', async () => {
  const config = tmpConfig();
  const account = addAccount(config.accountsSecretPath, 'work', VALID_TOKEN);
  const project = tmpProject(config);
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { accountId: account.id, projectId: project.id });
  updateAccount(config.accountsSecretPath, account.id, { name: 'renamed' });
  const { port, close } = startApp(config);

  const res = await postJson(port, `/api/sessions/${sessionId}/resume`, {});

  assert.equal(res.status, 200);
  await killSession(sessionId).catch(() => {});
  close();
});

test('a stored accountId wins over one sent along', async () => {
  const config = tmpConfig();
  const stored = addAccount(config.accountsSecretPath, 'work', VALID_TOKEN);
  const other = addAccount(config.accountsSecretPath, 'private', `${VALID_TOKEN}b`);
  const project = tmpProject(config);
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { accountId: stored.id, projectId: project.id });
  const { port, close } = startApp(config);

  await postJson(port, `/api/sessions/${sessionId}/resume`, { accountId: other.id });

  assert.equal(getMeta(config.dataDir, sessionId).accountId, stored.id);
  await killSession(sessionId).catch(() => {});
  close();
});

// The self-healing path: an entry with no accountId at all is treated the
// same as one whose account was deleted - both take the id sent along.
// A second account is registered deliberately: with only one, `!accountId`
// auto-selects it regardless of what's in the body, and the test would
// pass even if the route ignored body.accountId outright.
test('an entry without an accountId takes the one sent along', async () => {
  const config = tmpConfig();
  const account = addAccount(config.accountsSecretPath, 'work', VALID_TOKEN);
  addAccount(config.accountsSecretPath, 'private', `${VALID_TOKEN}b`);
  const project = tmpProject(config);
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { projectId: project.id });
  const { port, close } = startApp(config);

  const res = await postJson(port, `/api/sessions/${sessionId}/resume`, { accountId: account.id });

  assert.equal(res.status, 200);
  assert.equal(getMeta(config.dataDir, sessionId).accountId, account.id);
  await killSession(sessionId).catch(() => {});
  close();
});

test('an accountId that no longer resolves is replaced by the one sent along', async () => {
  const config = tmpConfig();
  const gone = addAccount(config.accountsSecretPath, 'old', VALID_TOKEN);
  const current = addAccount(config.accountsSecretPath, 'work', `${VALID_TOKEN}b`);
  const project = tmpProject(config);
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { accountId: gone.id, projectId: project.id });
  removeAccount(config.accountsSecretPath, gone.id);
  const { port, close } = startApp(config);

  const res = await postJson(port, `/api/sessions/${sessionId}/resume`, { accountId: current.id });

  assert.equal(res.status, 200);
  assert.equal(getMeta(config.dataDir, sessionId).accountId, current.id);
  await killSession(sessionId).catch(() => {});
  close();
});

test('patching the account checks the id and keeps the other fields', async () => {
  const config = tmpConfig();
  const first = addAccount(config.accountsSecretPath, 'work', VALID_TOKEN);
  const second = addAccount(config.accountsSecretPath, 'private', `${VALID_TOKEN}b`);
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { accountId: first.id, projectId: 'proj-1', protected: true });
  const { port, close } = startApp(config);

  const bad = await patchJson(port, `/api/sessions/${sessionId}`, { accountId: 'no-such-id' });
  assert.equal(bad.status, 400);
  assert.equal(getMeta(config.dataDir, sessionId).accountId, first.id);

  const ok = await patchJson(port, `/api/sessions/${sessionId}`, { accountId: second.id });
  assert.equal(ok.status, 200);
  assert.deepEqual(getMeta(config.dataDir, sessionId), {
    accountId: second.id, projectId: 'proj-1', protected: true,
  });
  close();
});

// spawnTmux is fire-and-forget: if the route answered immediately, the
// frontend would set the ttyd iframe src before the session exists. These
// tests check, without sleeping and without timing, that the session
// already exists AS SOON AS the response arrives at the client.
test('POST /api/projects/:id/sessions only responds once the tmux session actually exists', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'race-check-create');
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'private', 'sk-test-token');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RaceCheckCreate', projectPath }),
  });
  const project = await projectRes.json();

  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: account.id }),
  });
  const session = await sessionRes.json();

  assert.equal(sessionRes.status, 201);
  assert.equal(await hasSession(session.id), true);

  await killSessionEventually(session.id);
  server.close();
});

test('POST /api/sessions/:id/resume only responds once the tmux session actually exists', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'race-check-resume');
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'private', 'sk-test-token');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RaceCheckResume', projectPath }),
  });
  const project = await projectRes.json();

  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: account.id }),
  });
  const session = await sessionRes.json();

  const resumeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/resume`, {
    method: 'POST',
  });

  assert.equal(resumeRes.status, 200);
  assert.equal(await hasSession(session.id), true);

  await killSessionEventually(session.id);
  server.close();
});

// Token leak when opening a session that's already running: `tmux
// new-session` fails on the name already being taken, the wrapper script
// never gets to run and doesn't delete the token file. The cleanup branch
// doesn't kick in either, because waitForSession finds the running
// session and reports success.
test('POST /api/sessions/:id/resume on a session that is already running leaves no token file behind', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'work', VALID_TOKEN);

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'P', projectPath: config.dataDir }),
  });
  const project = await projectRes.json();

  // A session that is already running.
  const sessionId = crypto.randomUUID();
  spawn('tmux', ['new-session', '-d', '-s', sessionId, 'sleep', '30']);
  for (let i = 0; i < 20 && !(await hasSession(sessionId)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, accountId: account.id }),
    });
    assert.equal(res.status, 200);

    const tokenDir = path.join(config.dataDir, 'session-tokens');
    const leftover = fs.existsSync(tokenDir) ? fs.readdirSync(tokenDir) : [];
    assert.deepEqual(leftover, [], 'a token file was left behind');
  } finally {
    await killSessionEventually(sessionId);
    server.close();
  }
});

// A crash and a reaper kill both restart the session under its own name, so
// `terminalUrl` alone can't tell the frontend that anything happened - only
// the route knows. `restarted` carries that: present exactly when this
// resume had to spawn a new tmux session, absent when it just reopened one
// already running.
test('POST /api/sessions/:id/resume reports restarted:true only when it actually starts a session', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'work', VALID_TOKEN);

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'P', projectPath: config.dataDir }),
  });
  const project = await projectRes.json();

  // Guaranteed-alive session, independent of `claude` itself - the same
  // setup as the token-leak test above, for the same reason.
  const sessionId = crypto.randomUUID();
  spawn('tmux', ['new-session', '-d', '-s', sessionId, 'sleep', '30']);
  for (let i = 0; i < 20 && !(await hasSession(sessionId)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    const runningRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, accountId: account.id }),
    });
    const running = await runningRes.json();
    assert.equal(runningRes.status, 200);
    assert.equal(running.restarted, undefined, 'reopening a live session is not a restart');

    await killSession(sessionId);
    for (let i = 0; i < 20 && (await hasSession(sessionId)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const restartedRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, accountId: account.id }),
    });
    const restarted = await restartedRes.json();
    assert.equal(restartedRes.status, 200);
    assert.equal(restarted.terminalUrl, `/ttyd/?arg=${sessionId}`);
    assert.equal(restarted.restarted, true, 'a session that had to be started reports it');
  } finally {
    await killSessionEventually(sessionId);
    server.close();
  }
});

// ---------- Resume reaps a corpse instead of reopening it ----------
//
// With remain-on-exit a crashed `claude` leaves its tmux session
// listed with a dead pane. Attaching to that is a dead end: nothing logs,
// restarts, or says a word. These tests cover the two shapes a corpse can
// take - the session's own name, and (after a /clear) the carrier it still
// runs under - plus the case that must stay silent: a clean exit.

async function remainOnExitValue(sessionId) {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['show-window-options', '-t', sessionId, 'remain-on-exit']);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim()));
  });
}

test('the create route turns remain-on-exit on', async () => {
  const config = tmpConfig();
  const { server, session } = await startedSession(config, 'RemainCreate');
  try {
    assert.match(await remainOnExitValue(session.id), /remain-on-exit on/);
  } finally {
    await killSessionEventually(session.id);
    server.close();
  }
});

test('a session created through the route survives its process dying', async () => {
  const config = tmpConfig();
  const { server, session } = await startedSession(config, 'SurviveCrash');
  try {
    const corpse = await crashPaneProcess(session.id);
    // Without remain-on-exit tmux would have torn the session down, and
    // every attached ttyd client would run into an unthrottled reconnect.
    assert.equal(await hasSession(session.id), true);
    assert.equal(corpse.dead, true);
  } finally {
    await killSessionEventually(session.id);
    server.close();
  }
});

test('POST /api/sessions/:id/resume replaces a crashed session and reports the crash', async () => {
  const config = tmpConfig();
  const { base, server, session } = await startedSession(config, 'CrashResume');
  // Moving capturePane() after killSession(), or dropping the console.error
  // call outright, would still pass every assertion below without this
  // spy - the last lines are the only diagnosis a crash leaves, and the
  // kill destroys them, so the capture-before-kill order is the point of
  // this test, not an implementation detail.
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  try {
    await setRemainOnExit(session.id);
    const corpse = await crashPaneProcess(session.id);
    assert.equal(corpse.deadSignal, 9, 'a SIGKILL reports through the signal field');

    const res = await fetch(`${base}/api/sessions/${session.id}/resume`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.restoredAfterCrash.signal, 9);

    assert.equal(loggedCalls.length, 1, 'the crash was logged exactly once');
    const [message] = loggedCalls[0];
    assert.ok(message.includes(`Session ${session.id} crashed`), 'the log names the crashed session');
    const tail = message.split('Last lines:\n')[1] ?? '';
    assert.ok(tail.trim().length > 0, 'the log carries pane content captured before the kill, not an empty tail');

    // The corpse is gone and a live session runs under the same name again.
    const entry = (await listTmuxSessions()).find((s) => s.name === session.id);
    assert.ok(entry, 'a session runs under the name again');
    assert.equal(entry.dead, false);
    // The fresh window is a NEW tmux window, not the one setRemainOnExit was
    // called on above - only the resume route's own call carries the option
    // forward, so this is what actually covers that call.
    assert.match(await remainOnExitValue(session.id), /remain-on-exit on/);
  } finally {
    console.error = originalConsoleError;
    await killSessionEventually(session.id);
    server.close();
  }
});

test('POST /api/sessions/:id/resume stays silent about a clean exit', async () => {
  const config = tmpConfig();
  const { base, server, session } = await startedSession(config, 'CleanExit');
  try {
    await setRemainOnExit(session.id);
    // A signal would produce a death that isUnwantedDeath() can't tell apart
    // from a crash, defeating the point of this test. Replacing the pane's
    // command instead gives an exit status directly, with `exit 0` for the
    // clean case this test needs.
    await new Promise((resolve) => {
      const proc = spawn('tmux', ['respawn-pane', '-k', '-t', session.id, '--', 'sh', '-c', 'exit 0']);
      proc.on('close', () => resolve());
    });
    let corpse;
    for (let i = 0; i < 30; i++) {
      corpse = (await listTmuxSessions()).find((s) => s.name === session.id);
      if (corpse?.dead) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(corpse.deadStatus, 0, 'precondition: a clean exit');

    const res = await fetch(`${base}/api/sessions/${session.id}/resume`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.restoredAfterCrash, undefined, 'the user meant this - no toast');
  } finally {
    await killSessionEventually(session.id);
    server.close();
  }
});

// After a /clear, the running tmux session keeps its OLD name (the carrier)
// while the sidebar row carries the NEW session id - so a crash lands here,
// not in the corpse branch above. Reaping the carrier silently would lose
// the last lines before the crash in precisely this, the most common, case.
test('POST /api/sessions/:id/resume replaces a crashed carrier and reports the crash', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'resume-crashed-carrier');
  // Created explicitly rather than relying on addProject()'s own
  // mkdirSync: the fall-through resume below runs a REAL `tmux new-session
  // -c <projectPath>`, and this test should cover that it actually starts,
  // not depend on an implementation detail of the project store for its
  // precondition to hold.
  fs.mkdirSync(projectPath, { recursive: true });
  const { addAccount } = await import('../src/lib/accountStore.js');
  const { setMeta } = await import('../src/lib/sessionMeta.js');
  const { spawnTmux } = await import('../src/lib/tmuxManager.js');
  const account = addAccount(config.accountsSecretPath, 'private', 'sk-test-token');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const project = await (
    await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ResumeCrashedCarrier', projectPath }),
    })
  ).json();

  const carrier = 'session-carrier-crash';
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { accountId: account.id, projectId: project.id, tmuxSession: carrier });

  try {
    spawnTmux(['new-session', '-d', '-s', carrier, 'sleep', '30']);
    await assertAliveSession(carrier);
    await setRemainOnExit(carrier);
    const corpse = await crashPaneProcess(carrier);
    assert.equal(corpse.deadSignal, 9, 'a SIGKILL reports through the signal field');

    const res = await fetch(`${base}/api/sessions/${sessionId}/resume`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.restoredAfterCrash.signal, 9);
    assert.equal(body.terminalUrl, `/ttyd/?arg=${sessionId}`, 'under its own name, not the carrier');
    assert.equal(await hasSession(carrier), false, 'the carrier corpse was reaped');
  } finally {
    // Not killSessionEventually: the assertion above already established
    // the carrier is gone for good (reaped by the route), so the retry
    // loop would only wait out its full 20x100ms for a session that is
    // never coming back.
    await killSession(carrier).catch(() => {});
    await killSessionEventually(sessionId);
    server.close();
  }
});
