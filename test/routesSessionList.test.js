// What GET /api/projects/:id/sessions reports about each row: live, carrier,
// crashed, cleanExit, and a detected auth expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.js';
import { setRemainOnExit, listTmuxSessions } from '../src/lib/tmuxManager.js';
import {
  tmpConfig,
  killSessionEventually,
  crashPaneProcess,
  assertAliveSession,
  startedSession,
} from './helpers/routeHarness.js';

test('GET /api/projects/:id/sessions with an unknown id returns 404', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/projects/unknown-id/sessions`);
  assert.equal(res.status, 404);
  server.close();
});

test('GET /api/projects/:id/sessions returns an empty list for an existing project without sessions', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SessionsTest', projectPath: path.join(config.dataDir, 'sessionstest') }),
  });
  const created = await createRes.json();

  const res = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}/sessions`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.sessions, []);
  server.close();
});

test('GET /api/projects/:id/sessions returns the associated accountId from session-meta.json, otherwise null', async () => {
  const config = tmpConfig();
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const { setMeta } = await import('../src/lib/sessionMeta.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'accountflag');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AccountFlag', projectPath }),
  });
  const project = await projectRes.json();

  // Simulate .jsonl files the way `claude` itself creates them in claudeHome
  // (listSessions reads exclusively from there, see sessionStore.js) - one
  // session WITH a meta entry, one WITHOUT.
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'session-with-account.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
  );
  fs.writeFileSync(
    path.join(projectDir, 'session-without-account.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
  );
  setMeta(config.dataDir, 'session-with-account', { accountId: 'id-work', projectId: project.id });

  const res = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`);
  const body = await res.json();

  assert.equal(res.status, 200);
  const withAccount = body.sessions.find((s) => s.id === 'session-with-account');
  const withoutAccount = body.sessions.find((s) => s.id === 'session-without-account');
  assert.equal(withAccount.accountId, 'id-work');
  assert.equal(withoutAccount.accountId, null);
  server.close();
});

test('GET /api/projects/:id/sessions marks sessions with an existing tmux session as live, otherwise not', async () => {
  const config = tmpConfig();
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'liveflag');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'LiveFlag', projectPath }),
  });
  const project = await projectRes.json();

  // Two .jsonl files as created by `claude` itself (listSessions reads
  // exclusively from there) - one with, one without an associated real
  // tmux session. Deliberately a plain `sleep` command instead of a real
  // `claude` process (which would hang at the trust prompt for the
  // untrusted test folder) - all that matters for this test is
  // whether `tmux list-sessions` returns the name, not what runs inside it.
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'session-live.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
  );
  fs.writeFileSync(
    path.join(projectDir, 'session-idle.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
  );
  spawnTmux(['new-session', '-d', '-s', 'session-live', 'sleep', '30']);
  await waitForSession('session-live');

  const res = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`);
  const body = await res.json();

  assert.equal(res.status, 200);
  const live = body.sessions.find((s) => s.id === 'session-live');
  const idle = body.sessions.find((s) => s.id === 'session-idle');
  assert.equal(live.live, true);
  assert.equal(idle.live, false);
  // A carrier that never ran at all is neither a crash nor a clean exit -
  // "gone" can't be told apart from "starting", and cleanExit is what the
  // frontend auto-closes the terminal on (see public/app.js).
  assert.equal(idle.cleanExit, false);

  await killSessionEventually('session-live');
  server.close();
});

// Claude Code only creates its .jsonl on the first prompt, so until then a
// freshly started session is not in the history the route reads.
test('GET /api/projects/:id/sessions shows a running session that has no .jsonl yet', async () => {
  const config = tmpConfig();
  const { setMeta } = await import('../src/lib/sessionMeta.js');
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'nojsonl');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'NoJsonl', projectPath }),
  });
  const project = await projectRes.json();

  // No project folder in claudeHome, so no history - exactly the state
  // during the first minutes of a new session. `sleep` instead of `claude`,
  // as in the other route tests.
  const name = 'session-without-jsonl';
  setMeta(config.dataDir, name, { accountId: 'id-work', projectId: project.id });
  spawnTmux(['new-session', '-d', '-s', name, 'sleep', '30']);
  await waitForSession(name);

  const body = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`)).json();

  const found = body.sessions.find((s) => s.id === name);
  assert.ok(found, 'the running session is missing from the list');
  assert.equal(found.live, true);
  assert.equal(found.accountId, 'id-work');
  assert.ok(found.startMs > 0, 'without a start time, sorting would be arbitrary');

  await killSessionEventually(name);
  server.close();
});

// After a /clear the conversation continues under a new Claude ID, the
// tmux session keeps its name. Without the carrier resolution, the live
// dot stayed off even though the session was running.
test('GET /api/projects/:id/sessions marks a session continued after /clear as live', async () => {
  const config = tmpConfig();
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const { setMeta } = await import('../src/lib/sessionMeta.js');
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'afterclear');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AfterClear', projectPath }),
  });
  const project = await projectRes.json();

  const carrier = 'session-carrier';
  const afterClear = 'session-after-clear';
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${afterClear}.jsonl`),
    JSON.stringify({ type: 'user', message: { content: 'after the clear' } }) + '\n',
  );
  setMeta(config.dataDir, carrier, { projectId: project.id });
  setMeta(config.dataDir, afterClear, { projectId: project.id, tmuxSession: carrier });
  spawnTmux(['new-session', '-d', '-s', carrier, 'sleep', '30']);
  await waitForSession(carrier);

  const body = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`)).json();

  const row = body.sessions.find((s) => s.id === afterClear);
  assert.ok(row, 'the continued session is missing from the list');
  assert.equal(row.live, true);
  // The carrier session must not produce a second row.
  assert.equal(body.sessions.length, 1);

  await killSessionEventually(carrier);
  server.close();
});

// Both conversations of a carrier are in the list: the one from BEFORE the
// /clear (under the tmux name) and the running one below it. Only one of
// them is on screen in the terminal - without this distinction, the
// sidebar highlighted the old row and not the new one at all.
test('GET /api/projects/:id/sessions assigns each row its carrier and marks the running conversation', async () => {
  const config = tmpConfig();
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const { setMeta } = await import('../src/lib/sessionMeta.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'two-conversations');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Two', projectPath }),
  });
  const project = await projectRes.json();

  const carrier = 'session-carrier-two';
  const afterClear = 'session-after-clear-two';
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  for (const [id, text] of [
    [carrier, 'before the clear'],
    [afterClear, 'after the clear'],
  ]) {
    fs.writeFileSync(
      path.join(projectDir, `${id}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: text } }) + '\n',
    );
  }
  setMeta(config.dataDir, carrier, {
    projectId: project.id,
    currentSession: afterClear,
  });
  setMeta(config.dataDir, afterClear, { projectId: project.id, tmuxSession: carrier });

  const body = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`)).json();

  const newRow = body.sessions.find((s) => s.id === afterClear);
  const oldRow = body.sessions.find((s) => s.id === carrier);
  assert.equal(newRow.carrier, carrier);
  assert.equal(oldRow.carrier, carrier);
  assert.equal(newRow.current, true);
  assert.equal(oldRow.current, false);

  server.close();
});

// The normal case without /clear: the session carries itself and runs its
// own conversation. Without these fields, the frontend would find no row
// it could highlight.
test('GET /api/projects/:id/sessions marks a session without /clear as its own, running conversation', async () => {
  const config = tmpConfig();
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'plain');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Plain', projectPath }),
  });
  const project = await projectRes.json();

  const id = 'session-without-clear';
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${id}.jsonl`),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
  );

  const body = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`)).json();

  assert.equal(body.sessions[0].carrier, id);
  assert.equal(body.sessions[0].current, true);

  server.close();
});

// ---------- The list marks which rows are unwanted corpses ----------
//
// A dead carrier without a JSONL drops out of the list entirely, so the
// fixture writes one to keep the test about the `crashed` flag.
async function writeHistoryFile(config, project, sessionId) {
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(project.path));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
  );
}

// `cleanExit` is the other side of `crashed`: it's what the frontend closes
// the terminal on after a deliberate `/exit`, so every test below also
// checks it - exactly one of the two must be true for a dead carrier, and
// the live case checked in the second test must set neither.

test('GET /api/projects/:id/sessions marks a SIGKILLed session as crashed, not cleanExit', async () => {
  const config = tmpConfig();
  const { base, server, project, session } = await startedSession(config, 'CrashFlagKilled');
  try {
    await writeHistoryFile(config, project, session.id);
    await setRemainOnExit(session.id);
    const corpse = await crashPaneProcess(session.id);
    assert.equal(corpse.deadSignal, 9, 'precondition: a SIGKILL reports through the signal field');

    const res = await fetch(`${base}/api/projects/${project.id}/sessions`);
    const body = await res.json();
    const row = body.sessions.find((s) => s.id === session.id);
    assert.equal(row.crashed, true);
    assert.equal(row.cleanExit, false, 'a crash is not a wanted death');

    // The frontend's crash-heal only releases its "already attempted" mark
    // once the row reports `live: true` again (see `healAttempted` in
    // public/app.js) - if a successful resume didn't also clear `crashed`,
    // that mark would never come off and a session would get only one heal
    // per page load, ever.
    await fetch(`${base}/api/sessions/${session.id}/resume`, { method: 'POST' });
    const afterResume = await (await fetch(`${base}/api/projects/${project.id}/sessions`)).json();
    const healedRow = afterResume.sessions.find((s) => s.id === session.id);
    assert.equal(healedRow.live, true, 'precondition: the resume actually restarted the session');
    assert.equal(healedRow.crashed, false);
  } finally {
    await killSessionEventually(session.id);
    server.close();
  }
});

test('GET /api/projects/:id/sessions does not mark a live session as crashed or cleanExit', async () => {
  const config = tmpConfig();
  const { base, server, project, session } = await startedSession(config, 'CrashFlagLive');
  try {
    const res = await fetch(`${base}/api/projects/${project.id}/sessions`);
    const body = await res.json();
    const row = body.sessions.find((s) => s.id === session.id);
    assert.equal(row.crashed, false);
    assert.equal(row.cleanExit, false);
  } finally {
    await killSessionEventually(session.id);
    server.close();
  }
});

test('GET /api/projects/:id/sessions marks a clean exit as cleanExit, not crashed', async () => {
  const config = tmpConfig();
  const { base, server, project, session } = await startedSession(config, 'CrashFlagCleanExit');
  try {
    await writeHistoryFile(config, project, session.id);
    await setRemainOnExit(session.id);
    // A signal would produce a death that isUnwantedDeath() can't tell apart
    // from a crash, defeating the point of this test - see the identical
    // reasoning in "resume stays silent about a clean exit" in
    // routesResume.test.js.
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

    const res = await fetch(`${base}/api/projects/${project.id}/sessions`);
    const body = await res.json();
    const row = body.sessions.find((s) => s.id === session.id);
    assert.equal(row.crashed, false, 'the user meant this - no auto-restart');
    assert.equal(row.cleanExit, true);
  } finally {
    await killSessionEventually(session.id);
    server.close();
  }
});

// After a /clear the pre-clear row can never become `current` again, so
// only the post-clear row can report `live`.
test('GET /api/projects/:id/sessions: after a /clear, only the CURRENT row can report live again', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'resume-clear-carrier');
  fs.mkdirSync(projectPath, { recursive: true });
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
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
      body: JSON.stringify({ name: 'ResumeClearCarrier', projectPath }),
    })
  ).json();

  const carrier = 'session-clear-carrier';
  const newId = crypto.randomUUID();
  // Both directions, same as recordClaudeSwitch writes on a real /clear:
  // the new id points at its carrier, the carrier points at what it's
  // CURRENTLY running.
  setMeta(config.dataDir, carrier, { accountId: account.id, projectId: project.id, currentSession: newId });
  setMeta(config.dataDir, newId, { accountId: account.id, projectId: project.id, tmuxSession: carrier });

  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${carrier}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'before' } }) + '\n');
  // A later mtime than the carrier's own file - `startMs` falls back to it
  // when the registry field above resolves to the carrier's own id (the
  // state a fresh resume leaves behind, see below).
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(path.join(projectDir, `${newId}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'after' } }) + '\n');

  try {
    spawnTmux(['new-session', '-d', '-s', carrier, 'sleep', '30']);
    await assertAliveSession(carrier);
    await setRemainOnExit(carrier);
    const corpse = await crashPaneProcess(carrier);
    assert.equal(corpse.deadSignal, 9, 'precondition: a SIGKILL reports through the signal field');

    let body = await (await fetch(`${base}/api/projects/${project.id}/sessions`)).json();
    const oldRowDead = body.sessions.find((s) => s.id === carrier);
    const newRowDead = body.sessions.find((s) => s.id === newId);
    assert.equal(oldRowDead.current, false, 'precondition: the pre-clear row is not the current one');
    assert.equal(newRowDead.current, true, 'precondition: the post-clear row is');
    // Carrier-scoped: both rows agree on it regardless of which is current.
    assert.equal(oldRowDead.crashed, true);
    assert.equal(newRowDead.crashed, true);

    // The wake path resumes via currentSessionId, which after a /clear is
    // still the carrier's own name - a known identity
    // choice, reproduced here rather than fixed.
    const resumeRes = await fetch(`${base}/api/sessions/${carrier}/resume`, { method: 'POST' });
    assert.equal(resumeRes.status, 200);

    body = await (await fetch(`${base}/api/projects/${project.id}/sessions`)).json();
    const oldRowAfter = body.sessions.find((s) => s.id === carrier);
    const newRowAfter = body.sessions.find((s) => s.id === newId);
    // The resume restarted the carrier under its own name and cleared its
    // `currentSession` pointer - but `currentConversation`'s fallback still
    // resolves to whichever row started most recently, which is newId. The
    // pre-clear row's `current`, and with it `live`, therefore stays false
    // even though the carrier is alive again.
    assert.equal(oldRowAfter.live, false, 'the pre-clear row cannot report live again on its own');
    assert.equal(newRowAfter.live, true, 'the post-clear row can - this is the row the frontend must watch');
  } finally {
    await killSessionEventually(carrier);
    server.close();
  }
});

// ---------- Expiry detection in the session list ----------
//
// An expired login leaves neither an exit code nor a status file: the
// `claude` process keeps running, tmux reports the session as active, the
// only trace is the text in the pane (see src/lib/authStatus.js). The
// detection hooks in at the same spot as activeAccount/hasToken, because
// the whole point is to notice an expiry WITHOUT opening the session.
test('GET /api/projects/:id/sessions reports a detected auth expiry per running session', async () => {
  const config = tmpConfig();
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'authflag');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AuthFlag', projectPath }),
  });
  const project = await projectRes.json();

  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  for (const name of ['session-expired', 'session-healthy', 'session-ended']) {
    fs.writeFileSync(
      path.join(projectDir, `${name}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
    );
  }

  // Width deliberately set to 55 columns: that's the real terminal width
  // on the phone (see MOBILE_FONT_SIZE in public/app.js). A pane hard-wraps
  // text, even mid-word - the detection has to survive that, and the risk
  // is greatest exactly at narrow widths.
  spawnTmux([
    'new-session', '-d', '-x', '55', '-y', '20', '-s', 'session-expired',
    'sh', '-c', 'printf "%s\\n" "Please run /login" "API Error: 401 OAuth access token has expired"; sleep 30',
  ]);
  spawnTmux(['new-session', '-d', '-x', '55', '-y', '20', '-s', 'session-healthy', 'sleep', '30']);
  await waitForSession('session-expired');
  await waitForSession('session-healthy');

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`);
    const body = await res.json();
    const expired = body.sessions.find((s) => s.id === 'session-expired');
    const healthy = body.sessions.find((s) => s.id === 'session-healthy');
    const ended = body.sessions.find((s) => s.id === 'session-ended');

    // `matched` is included deliberately: if Claude Code changes the
    // wording, this makes it possible to see what the detection triggered
    // on (or that it no longer does) - that's why the field exists.
    assert.deepEqual(expired.authProblem, { kind: 'expired', matched: 'token has expired' });
    assert.equal(healthy.authProblem, null);
    // An ended session has no pane and therefore no verdict - that's
    // different from "checked and fine".
    assert.equal(ended.authProblem, null);
  } finally {
    await killSessionEventually('session-expired');
    await killSessionEventually('session-healthy');
    server.close();
  }
});
