// Creating, ending and changing a single session, plus the two read routes
// that go straight to tmux (the copy buffer and the visible pane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.js';
import { killSession, hasSession } from '../src/lib/tmuxManager.js';
import { tmpConfig, killSessionEventually } from './helpers/routeHarness.js';

function tmuxSetBuffer(value) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', ['set-buffer', value]);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`set-buffer exit ${code}`))));
  });
}

// tmux buffers are ONE global stack for the whole host, not isolated
// test state: without this cleanup, the real copy feature of a running
// session would show the test marker as "last copied". delete-buffer
// without -b removes the top buffer and makes the real one current again.
function tmuxDeleteTopBuffer() {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['delete-buffer']);
    proc.on('close', () => resolve()); // best effort - the test result doesn't depend on this
  });
}

test('POST /api/projects/:id/sessions creates a tmux session and returns a terminal-url', async () => {
  const config = tmpConfig();
  const projectPath = path.join(config.dataDir, 'demo');
  // Set up an account so the route finds a token
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'private', 'sk-test-token');

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo', projectPath }),
  });
  const project = await projectRes.json();

  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: account.id }),
  });
  const session = await sessionRes.json();

  assert.equal(sessionRes.status, 201);
  assert.match(session.id, /^[a-f0-9-]{36}$/);
  assert.equal(session.terminalUrl, `/ttyd/?arg=${session.id}`);
  // Cleanup: otherwise the tmux/claude process really spawned by the route
  // (here claude hangs at the trust prompt for the fresh tmp dataDir) stays
  // around permanently after the test run. See killSessionEventually in
  // helpers/routeHarness.js for why the retry is needed.
  await killSessionEventually(session.id);
  server.close();
});

test('POST /api/projects/:id/sessions returns 400 for an unknown account', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo', projectPath: path.join(config.dataDir, 'demo2') }),
  });
  const project = await projectRes.json();

  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'no-such-id' }),
  });

  assert.equal(sessionRes.status, 400);
  server.close();
});

test('POST /api/projects/:id/sessions returns 404 for an unknown project', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/projects/unknown-id/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  assert.equal(sessionRes.status, 404);
  server.close();
});

// "Copy" feature: passes the server-global tmux buffer through to the
// frontend (background at showBuffer() in tmuxManager.js). Runs, like the
// other tmux tests in this file, against the real, shared tmux server of
// the host.
test('GET /api/tmux-buffer returns the buffer content last set via tmux', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  const marker = `claudux-route-test-${crypto.randomUUID()}`;
  await tmuxSetBuffer(marker);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tmux-buffer`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.text, marker);
  } finally {
    await tmuxDeleteTopBuffer();
    server.close();
  }
});

// ---------- DELETE /api/sessions/:id ----------
//
// What gets ended is the tmux session, NOT the history: the JSONL stays in
// place, and the session can be resumed afterwards via the same row.
test('DELETE /api/sessions/:id ends the tmux session but leaves the history in place', async () => {
  const config = tmpConfig();
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const projectPath = path.join(config.dataDir, 'kill');
  const projectRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Kill', projectPath }),
  });
  const project = await projectRes.json();

  const name = crypto.randomUUID();
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(projectPath));
  fs.mkdirSync(projectDir, { recursive: true });
  const jsonlPath = path.join(projectDir, `${name}.jsonl`);
  fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n');
  spawnTmux(['new-session', '-d', '-s', name, 'sleep', '30']);
  await waitForSession(name);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${name}`, { method: 'DELETE' });

    assert.equal(res.status, 204);
    assert.equal(await hasSession(name), false);
    // The history is why the session stays resumable afterwards - it must
    // not go away when the session ends.
    assert.equal(fs.existsSync(jsonlPath), true);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`)).json();
    assert.equal(list.sessions.find((s) => s.id === name).live, false);
  } finally {
    await killSessionEventually(name);
    server.close();
  }
});

// Between being shown and being clicked, the session may already have
// ended - in that case the goal is already reached. An error here would be
// misleading.
test('DELETE /api/sessions/:id is a no-op on a session that already ended', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${crypto.randomUUID()}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
  } finally {
    server.close();
  }
});

test('DELETE /api/sessions/:id rejects invalid session IDs with 400', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent('evil; rm -rf /')}`,
      { method: 'DELETE' },
    );
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// The settings file is only read by `claude` at its own process start, and
// every start writes it fresh - so once the session it belonged to is
// ended, nothing will ever read it again. Without this, one file per
// session ID ever started piled up under the data directory.
test('DELETE /api/sessions/:id removes the hook settings file of the session it ends', async () => {
  const config = tmpConfig();
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const name = crypto.randomUUID();
  const settingsPath = path.join(config.dataDir, 'hook-settings', `${name}.json`);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
  spawnTmux(['new-session', '-d', '-s', name, 'sleep', '30']);
  await waitForSession(name);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${name}`, { method: 'DELETE' });

    assert.equal(res.status, 204);
    assert.equal(fs.existsSync(settingsPath), false, 'the settings file was left behind');
  } finally {
    await killSessionEventually(name);
    server.close();
  }
});

// The most common leftover: the session is already gone (crash, reaper,
// exited in the terminal) and the end button is what gets rid of the row.
// killSession throws on a session that no longer exists, so the removal
// must not sit behind it.
test('DELETE /api/sessions/:id removes the hook settings file of a session that already ended', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const name = crypto.randomUUID();
  const settingsPath = path.join(config.dataDir, 'hook-settings', `${name}.json`);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${name}`, { method: 'DELETE' });

    assert.equal(res.status, 204);
    assert.equal(fs.existsSync(settingsPath), false, 'the settings file was left behind');
  } finally {
    server.close();
  }
});

// The other half of the same per-session state: the settings file lives on
// disk, the dialog the hook reported lives in memory, and both are pointless
// once the session they describe is over. Only the file was ever removed.
test('DELETE /api/sessions/:id clears the dialog the hook left for that session', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const name = crypto.randomUUID();
  app.locals.permissionStore.put(name, { toolName: 'Bash', at: Date.now() });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${name}`, { method: 'DELETE' });

    assert.equal(res.status, 204);
    assert.equal(app.locals.permissionStore.get(name), null, 'the dialog was left in the store');
  } finally {
    server.close();
  }
});

// ---------- PATCH /api/sessions/:id ----------
//
// Two properties of a session that the user must be able to change:
//
// `protected` - protection from the idle reaper.
// `accountId` - which account the session gets resumed under. The resume
// route takes the stored value as long as it still resolves and only falls
// back to one sent along otherwise, so that resuming doesn't switch the
// subscription.
test('PATCH /api/sessions/:id sets reaper protection and keeps the account', async () => {
  const config = tmpConfig();
  const { setMeta, getMeta } = await import('../src/lib/sessionMeta.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { accountId: 'acc-work', projectId: 'p1' });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protected: true }),
    });

    assert.equal(res.status, 200);
    const meta = getMeta(config.dataDir, sessionId);
    assert.equal(meta.protected, true);
    // The other fields must not get lost in the process - setMeta replaces
    // the entry completely, an incomplete object would silently delete the
    // account assignment.
    assert.equal(meta.accountId, 'acc-work');
    assert.equal(meta.projectId, 'p1');
  } finally {
    server.close();
  }
});

test('PATCH /api/sessions/:id changes the account and keeps the protection', async () => {
  const config = tmpConfig();
  const { setMeta, getMeta } = await import('../src/lib/sessionMeta.js');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const sessionId = crypto.randomUUID();
  // Via the real store function instead of writing the file by hand - the
  // format (an object keyed by id, not an array) is an internal detail of
  // the store.
  const { addAccount } = await import('../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'Private', 'sk-ant-oat01-x');
  setMeta(config.dataDir, sessionId, { accountId: 'acc-work', projectId: 'p1', protected: true });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: account.id }),
    });

    assert.equal(res.status, 200);
    const meta = getMeta(config.dataDir, sessionId);
    assert.equal(meta.accountId, account.id);
    assert.equal(meta.protected, true);
  } finally {
    server.close();
  }
});

// An unknown account would make the session fail with a 400 on the next
// resume - better to reject it right here, while the context is still
// recognizable to the user.
test('PATCH /api/sessions/:id rejects an unknown account', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${crypto.randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'no-such-id' }),
    });

    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /api/sessions/:id rejects invalid session IDs', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent('evil; rm -rf /')}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protected: true }),
      },
    );

    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// ---------- /clear: assign the new Claude ID to the running tmux session ----------
//
// After a `/clear`, Claude Code assigns a NEW session id while the tmux
// name stays unchanged. Without this mapping, the new ID shows up as an
// ended session in the sidebar, and clicking it starts a SECOND tmux
// session on the same conversation. The route here is the hand-callable
// entry to the same store function the registry reconcile writes through.
test('POST /api/sessions/:id/claude-switch remembers the new Claude ID', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { setMeta, getMeta } = await import('../src/lib/sessionMeta.js');

  const tmuxName = '11111111-2222-3333-4444-555555555555';
  const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  setMeta(config.dataDir, tmuxName, { accountId: 'id-1', projectId: 'proj-1' });

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${tmuxName}/claude-switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claudeSessionId: newId }),
  });

  assert.equal(res.status, 200);
  // The new entry inherits account and project from the tmux session: it's
  // the same terminal under the same token, just with an emptied
  // conversation.
  assert.deepEqual(getMeta(config.dataDir, newId), {
    accountId: 'id-1',
    projectId: 'proj-1',
    tmuxSession: tmuxName,
  });
  // The reverse direction: from now on the tmux session runs THIS
  // conversation. Without this note, the sidebar kept marking the row from
  // before the /clear as the open one.
  assert.equal(getMeta(config.dataDir, tmuxName).currentSession, newId);
  server.close();
});

test('POST /api/sessions/:id/claude-switch writes nothing when the ID is unchanged', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { setMeta, getMeta } = await import('../src/lib/sessionMeta.js');

  const name = '11111111-2222-3333-4444-666666666666';
  setMeta(config.dataDir, name, { accountId: 'acc-private', projectId: 'proj-1' });

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${name}/claude-switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claudeSessionId: name }),
  });

  assert.equal(res.status, 200);
  // No tmuxSession field: for `source: "startup"` both IDs are identical,
  // because Claudux prescribes them via --session-id. There's nothing to
  // map here.
  assert.deepEqual(getMeta(config.dataDir, name), { accountId: 'acc-private', projectId: 'proj-1' });
  server.close();
});

// The registry covers EVERY claude session on the host, including
// manually created tmux sessions. Without a meta entry it's not a Claudux
// session - in that case nothing must be created here, otherwise
// session-meta.json fills up with foreign entries.
test('POST /api/sessions/:id/claude-switch ignores sessions without a meta entry', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { getMeta } = await import('../src/lib/sessionMeta.js');

  const res = await fetch(
    `http://127.0.0.1:${port}/api/sessions/99999999-8888-7777-6666-555555555555/claude-switch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }),
    },
  );

  assert.equal(res.status, 200);
  assert.equal(getMeta(config.dataDir, 'cccccccc-cccc-cccc-cccc-cccccccccccc'), null);
  server.close();
});

test('POST /api/sessions/:id/claude-switch rejects invalid IDs', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(
    `http://127.0.0.1:${port}/api/sessions/11111111-2222-3333-4444-777777777777/claude-switch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'has:colon' }),
    },
  );

  assert.equal(res.status, 400);
  server.close();
});

// The actual goal of the whole exercise: clicking the row that resulted
// from /clear must NOT start a second tmux session, but must point at the
// running one. Deliberately with a plain `sleep` session instead of a real
// `claude` process - what's being checked is the route's branching, not
// Claude Code.
test('POST /api/sessions/:id/resume attaches to the running tmux session instead of starting a second one', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { setMeta } = await import('../src/lib/sessionMeta.js');
  const { addAccount } = await import('../src/lib/accountStore.js');

  // Session name from /proc instead of made up - and checked before it
  // goes into a `tmux -t`: with an empty target, tmux would hit the
  // CURRENT session.
  const tmuxName = fs.readFileSync('/proc/sys/kernel/random/uuid', 'utf8').trim();
  assert.match(tmuxName, /^[0-9a-f-]{36}$/, 'tmux target name must be a real UUID');
  const newId = fs.readFileSync('/proc/sys/kernel/random/uuid', 'utf8').trim();
  assert.match(newId, /^[0-9a-f-]{36}$/);

  const projectPath = path.join(config.dataDir, 'clear-demo');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(config.dataDir, 'projects.json'),
    JSON.stringify([{ id: 'proj-clear', name: 'Clear', path: projectPath }]),
  );
  const account = addAccount(config.accountsSecretPath, 'Private', 'sk-test-token');

  spawn('tmux', ['new-session', '-d', '-s', tmuxName, 'sleep', '120']);
  for (let i = 0; i < 30 && !(await hasSession(tmuxName)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(await hasSession(tmuxName), 'precondition: the tmux session is running');

  try {
    setMeta(config.dataDir, newId, {
      accountId: account.id,
      projectId: 'proj-clear',
      tmuxSession: tmuxName,
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${newId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.terminalUrl, `/ttyd/?arg=${tmuxName}`, 'points at the running session');
    assert.equal(
      await hasSession(newId),
      false,
      'NO second tmux session must have been created under the new ID',
    );
  } finally {
    await killSessionEventually(tmuxName);
    await killSessionEventually(newId); // best effort, in case the protection failed
    server.close();
  }
});

// Text view for selecting text on the phone: returns the visible pane
// content raw and cleaned up (see paneText.js), plus what paneDialog.js
// reads off the cleaned text. Runs, like the other tmux tests in this file,
// against the real, shared tmux server of the host.
test('GET /api/sessions/:id/pane returns the visible pane content raw and cleaned up', async () => {
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const name = crypto.randomUUID();
  // An empty target would hit the CURRENT session instead of the intended
  // one in `tmux -t` - that has already ended a running session here.
  assert.ok(name.length > 0, 'session name must not be empty');
  const server = createApp(tmpConfig()).listen(0);
  const { port } = server.address();
  // `sleep` instead of a real application: what's checked is that the
  // route fetches the pane content, not what's running inside it.
  spawnTmux(['new-session', '-d', '-s', name, 'sleep', '30']);
  await waitForSession(name);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${name}/pane`);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.raw, 'string');
    assert.equal(typeof body.clean, 'string');
    // The cleanup never leaves whitespace at the end of a line.
    assert.equal(
      body.clean,
      body.clean.split('\n').map((line) => line.replace(/\s+$/, '')).join('\n'),
    );
    // Both readings of the same pane travel with it, so the browser never
    // has to interpret terminal text itself: what the session is asking,
    // and whether its input line is empty. This pane is a bare `sleep`, so
    // there is no dialog and no prompt line at all - and no prompt line is
    // deliberately neither an empty one nor an occupied one (see
    // promptIsEmpty): every guard built on it errs towards refusing, and the
    // one that names the input line must not be the one that fires. What the
    // two readings do with real box shapes is pinned in
    // test/paneDialog.test.js against nine captures.
    assert.deepEqual(body.dialog, { open: false, options: [], mirrored: '' });
    assert.equal(body.promptEmpty, null);
  } finally {
    server.close();
    await killSession(name).catch(() => {});
  }
});

test('GET /api/sessions/:id/pane responds with 404 when the session does not exist', async () => {
  const name = crypto.randomUUID();
  const server = createApp(tmpConfig()).listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${name}/pane`);

    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/sessions/:id/pane rejects an invalid session ID', async () => {
  const server = createApp(tmpConfig()).listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent('../etc')}/pane`);

    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
