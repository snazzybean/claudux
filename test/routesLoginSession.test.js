// The ephemeral `claude setup-token` session behind the login wizard:
// starting it, polling its phase, typing the code into it, and ending it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { tmpConfig, killSessionEventually } from './helpers/routeHarness.js';

test('POST /api/accounts/login-session starts an ephemeral tmux session with claude setup-token', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session`, { method: 'POST' });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.match(body.terminalUrl, /^\/ttyd\/\?arg=login-[a-f0-9]{8}$/);
  // Cleanup: spawnTmux really creates a tmux session (fire-and-forget,
  // see the killSessionEventually comment in helpers/routeHarness.js) -
  // without cleanup the
  // `claude setup-token` process would stay hanging in the background
  // permanently.
  const loginSessionName = body.terminalUrl.replace('/ttyd/?arg=', '');
  await killSessionEventually(loginSessionName);
  server.close();
});

// This route starts a REAL `claude setup-token` session. The name used for
// cleanup therefore comes from the terminalUrl and not from the field that
// is being checked right here: if the check failed, the session would
// otherwise stay around together with its claude process. For the same
// reason, server.close() lives in the finally block - an open server
// holds the event loop, and the test run hangs instead of failing.
test('POST /api/accounts/login-session includes the session name', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  let cleanupName = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session`, { method: 'POST' });
    const body = await res.json();
    cleanupName = new URL(body.terminalUrl, 'http://127.0.0.1').searchParams.get('arg');
    assert.equal(res.status, 201);
    assert.ok(body.sessionName, 'sessionName is missing from the response');
    assert.equal(body.sessionName, cleanupName);
  } finally {
    if (cleanupName) await killSessionEventually(cleanupName);
    server.close();
  }
});

// The normal case when polling at intervals: the user has closed the
// terminal. Not a 404 - the assistant should be able to display the
// state, not an error.
test('GET login-session status reports gone for a non-existing session', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/login-deadbeef/status`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).phase, 'gone');
  } finally {
    server.close();
  }
});

test('GET login-session status reports a phase for a running session', async () => {
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  const name = `login-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', 'read _']);
  await waitForSession(name);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/${name}/status`);
    assert.equal(res.status, 200);
    const { phase } = await res.json();
    assert.ok(['starting', 'url', 'token'].includes(phase), `phase was: ${phase}`);
  } finally {
    await killSessionEventually(name);
    server.close();
  }
});

// hasSession returns `false` for an invalid slug instead of rejecting it -
// without its own check in the route, this would produce 200/gone here
// instead of 400.
test('GET login-session status rejects an invalid session name', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/not%20valid/status`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// A session UUID passes isValidSlug, so the route would capture that
// session's pane and hand back whatever readLoginScreen() extracts from
// it. A token on the screen is not something only a login pane can have.
test('GET login-session status reads no pane outside the login scheme', async () => {
  const { spawnTmux, waitForSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  const name = crypto.randomUUID();
  const marker = 'pane-contents-marker';

  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', `printf '%s\\n' '${marker}'; read _`]);
  await waitForSession(name);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/${name}/status`);
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.ok(!body.includes(marker), `pane contents came back: ${body}`);
  } finally {
    await killSessionEventually(name);
    server.close();
  }
});

test('POST login-session code sends the value into the session', async () => {
  const { spawnTmux, waitForSession, capturePane } = await import('../src/lib/tmuxManager.js');
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  const name = `login-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', 'read input; printf "read:%s\\n" "$input"; read _']);
  await waitForSession(name);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/${name}/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'abc123#def' }),
    });
    assert.equal(res.status, 204);
    await new Promise((r) => setTimeout(r, 500));
    const text = await capturePane(name);
    assert.ok(text.includes('read:abc123#def'), `pane text was: ${text}`);
  } finally {
    await killSessionEventually(name);
    server.close();
  }
});

// The code ends up in a send-keys argv. Whitespace and control characters
// have no business being there - checked at the system boundary, because
// this is the only place it comes in from outside.
test('POST login-session code rejects whitespace, an empty value, and overlength', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    for (const value of ['abc def', 'abc\ndef', '', 'x'.repeat(513)]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/login-deadbeef/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: value }),
      });
      assert.equal(res.status, 400, `unexpectedly accepted: ${JSON.stringify(value)}`);
    }
  } finally {
    server.close();
  }
});

// The same narrowing as on the status route, for the other direction:
// with isValidSlug this would be a way to type into any session.
test('POST login-session code types into no session outside the login scheme', async () => {
  const { spawnTmux, waitForSession, capturePane } = await import('../src/lib/tmuxManager.js');
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  const name = crypto.randomUUID();

  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', 'read input; printf "read:%s\\n" "$input"; read _']);
  await waitForSession(name);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/${name}/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'abc123' }),
    });
    assert.equal(res.status, 400);
    await new Promise((r) => setTimeout(r, 500));
    const text = await capturePane(name);
    assert.ok(!text.includes('read:abc123'), `keystrokes arrived: ${text}`);
  } finally {
    await killSessionEventually(name);
    server.close();
  }
});

test('POST login-session code reports 404 for a non-existing session', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/login-deadbeef/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'abc123' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// After a completed login, the session has served its purpose - and its
// screen still shows the token in plain text.
test('DELETE login-session ends the session', async () => {
  const { spawnTmux, waitForSession, hasSession } = await import('../src/lib/tmuxManager.js');
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  const name = `login-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', 'read _']);
  await waitForSession(name);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/${name}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.equal(await hasSession(name), false);
  } finally {
    await killSessionEventually(name);
    server.close();
  }
});

// When cleaning up, "was already gone" is not an error: the reaper could
// have gotten there first, and the UI shouldn't report anything because
// of that.
test('DELETE login-session reports success even for a long-ended session', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/login-deadbeef`, { method: 'DELETE' });
    assert.equal(res.status, 204);
  } finally {
    server.close();
  }
});

// The name goes into a tmux argv as -t: with an empty target, tmux would
// hit the CURRENT session. This route must never kill anything other than
// a login session.
test('DELETE login-session rejects names outside the login scheme', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    for (const name of ['11111111-1111-1111-1111-111111111111', 'not%20valid']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/accounts/login-session/${name}`, { method: 'DELETE' });
      assert.equal(res.status, 400, `unexpectedly accepted: ${name}`);
    }
  } finally {
    server.close();
  }
});
