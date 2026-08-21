// The two halves of the permission route, and the gate between them. The
// hook-facing POST is called by the `claude` process, which has no session
// cookie - so it is mounted in front of the access gate and authenticates
// itself with a per-session secret instead. The browser-facing GET/DELETE
// stay behind the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { setMeta } from '../src/lib/sessionMeta.js';
import {
  permissionHookRouter,
  permissionViewRouter,
  createPermissionStore,
} from '../src/routes/permission.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

// The store derives its secrets from a key file, so every one of these needs
// a directory of its own - a shared one would let one test's key decide
// another test's secret.
function tmpStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-permstore-'));
  return { dataDir, store: createPermissionStore({ dataDir }) };
}

// Both routers on one app, in the order server.js mounts them - and with no
// app-level parser, exactly as server.js leaves this path (the hook router
// brings its own). The gate itself has its own test at the bottom.
function appWith(store) {
  const app = express();
  const wiring = {
    store,
    // knowsSession is injected so the route stays testable without a real
    // session on disk.
    knowsSession: (id) => id === SESSION,
  };
  app.use('/api', permissionHookRouter({}, wiring));
  app.use('/api', permissionViewRouter({}, wiring));
  return app;
}

async function request(app, method, path, { body, headers } = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const post = (app, path, body, headers) => request(app, 'POST', path, { body, headers });

test('the route answers escalate so the terminal keeps its dialog', async () => {
  const { store } = tmpStore();
  const res = await post(appWith(store), `/api/permission/${SESSION}`, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  }, { 'x-claudux-session-secret': store.secretFor(SESSION) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { decision: 'escalate' });
});

test('the route keeps the dialog for the view to fetch', async () => {
  const { store } = tmpStore();
  await post(appWith(store), `/api/permission/${SESSION}`, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Blue', description: 'b' }], multiSelect: false }] },
  }, { 'x-claudux-session-secret': store.secretFor(SESSION) });
  const held = store.get(SESSION);
  assert.equal(held.toolName, 'AskUserQuestion');
  assert.equal(held.toolInput.questions[0].header, 'Colour');
});

// A body without a usable tool name is answered - a hook must never be left
// hanging - but nothing is stored: an empty card next to a terminal showing
// a real box is worse than no card at all.
test('a body with nothing usable in it is answered but not stored', async () => {
  const { store } = tmpStore();
  const res = await post(appWith(store), `/api/permission/${SESSION}`, {
    hook_event_name: 'PermissionRequest',
  }, { 'x-claudux-session-secret': store.secretFor(SESSION) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { decision: 'escalate' });
  assert.equal(store.get(SESSION), null);
});

// A `Write` of a large file is the case that hits this: the global parser's
// 100 kB default would answer 413 before the handler runs, and the view
// would show no dialog while the terminal sits waiting.
test('a tool input far over the global 100 kB limit still reaches the route', async () => {
  const { store } = tmpStore();
  const content = 'x'.repeat(200 * 1024);
  const res = await post(appWith(store), `/api/permission/${SESSION}`, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Write',
    tool_input: { file_path: '/srv/example/big.txt', content },
  }, { 'x-claudux-session-secret': store.secretFor(SESSION) });
  assert.equal(res.status, 200);
  assert.equal(store.get(SESSION).toolInput.content.length, content.length);
});

// The call comes from the claude process, not from a browser with a session
// cookie, so this route sits in front of the access gate - and is therefore
// reachable from wherever the server is bound, not just from this machine.
// The secret is the only thing between that and reading what a session is
// being asked.
test('a wrong or missing secret is refused', async () => {
  const { store } = tmpStore();
  const wrong = await post(appWith(store), `/api/permission/${SESSION}`, { tool_name: 'Bash' }, { 'x-claudux-session-secret': 'falsch' });
  assert.equal(wrong.status, 403);
  const missing = await post(appWith(store), `/api/permission/${SESSION}`, { tool_name: 'Bash' });
  assert.equal(missing.status, 403);
});

// A secret of a different length must be refused like any other wrong one:
// timingSafeEqual throws on differing lengths, and an uncaught throw would
// turn the refusal into a 500 that leaks the expected length.
test('a secret of the wrong length is refused, not answered with an error', async () => {
  const { store } = tmpStore();
  const res = await post(appWith(store), `/api/permission/${SESSION}`, { tool_name: 'Bash' }, { 'x-claudux-session-secret': 'much-longer-than-the-real-one' });
  assert.equal(res.status, 403);
});

test('an unknown session is refused before the secret is even compared', async () => {
  const { store } = tmpStore();
  const other = '99999999-2222-3333-4444-555555555555';
  const res = await post(appWith(store), `/api/permission/${other}`, { tool_name: 'Bash' }, { 'x-claudux-session-secret': store.secretFor(other) });
  assert.equal(res.status, 404);
});

test('the view reads the held dialog and can drop it', async () => {
  const { store } = tmpStore();
  store.put(SESSION, { toolName: 'Bash' });
  const app = appWith(store);
  const seen = await request(app, 'GET', `/api/permission/${SESSION}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.dialog.toolName, 'Bash');
  await request(app, 'DELETE', `/api/permission/${SESSION}`);
  const gone = await request(app, 'GET', `/api/permission/${SESSION}`);
  assert.equal(gone.body.dialog, null);
});

// Both halves of the view answer for the same set of sessions - an asymmetry
// here would read as an oversight rather than as a decision.
test('the view refuses an unknown session on both of its verbs', async () => {
  const { store } = tmpStore();
  const app = appWith(store);
  const other = '/api/permission/99999999-2222-3333-4444-555555555555';
  assert.equal((await request(app, 'GET', other)).status, 404);
  assert.equal((await request(app, 'DELETE', other)).status, 404);
});

test('clear removes a held dialog', () => {
  const { store } = tmpStore();
  store.put(SESSION, { toolName: 'Bash' });
  store.clear(SESSION);
  assert.equal(store.get(SESSION), null);
});

// Deploying this project restarts the service, and KillMode=process leaves
// every `claude` running with the secret it was started with. A secret held
// in memory would be gone while those sessions keep sending theirs, and
// every dialog they report would be refused for the rest of their lives -
// invisibly, since the terminal keeps its own box either way.
test('a new store over the same data directory derives the same secret', () => {
  const { dataDir, store } = tmpStore();
  const before = store.secretFor(SESSION);
  assert.match(before, /^[0-9a-f]{64}$/);
  const afterRestart = createPermissionStore({ dataDir }).secretFor(SESSION);
  assert.equal(afterRestart, before);
});

test('the secret differs per session and per installation', () => {
  const { dataDir, store } = tmpStore();
  assert.notEqual(store.secretFor(SESSION), store.secretFor('22222222-2222-3333-4444-555555555555'));
  const elsewhere = tmpStore().store.secretFor(SESSION);
  assert.notEqual(elsewhere, store.secretFor(SESSION));
  // The key, not the derived value, is what has to stay unreadable.
  const mode = fs.statSync(path.join(dataDir, 'permission-hook.key')).mode & 0o777;
  assert.equal(mode, 0o600);
});

// The gap this closes is invisible in every test above: they mount the
// routers without a gate, while createApp() puts createAccessGate() in front
// of every /api router. A permission route mounted with the others would
// answer 401 to the hook - the store would never fill, and only in
// production, since the probe runs with AUTH_ENABLED=false.
async function startRealApp({ withMeta = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-permission-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-permission-claude-'));
  const config = {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    accessSecretPath: path.join(dataDir, 'access.json'),
    authEnabled: true,
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ttydPort: 1,
  };
  // knowsSession resolves through getMeta, so the session has to exist for
  // the app the same way a started one would.
  if (withMeta) setMeta(dataDir, SESSION, { accountId: 'a', projectId: 'p' });
  const app = createApp(config);
  const secret = app.locals.permissionStore.secretFor(SESSION);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { app, secret, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the hook reaches its route without a session cookie, the view does not', async () => {
  const { app, secret, server, base } = await startRealApp();
  try {
    const posted = await fetch(`${base}/api/permission/${SESSION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claudux-session-secret': secret },
      body: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), { decision: 'escalate' });
    assert.equal(app.locals.permissionStore.get(SESSION).toolName, 'Bash');

    // The browser half stays behind the gate: no cookie, no dialog.
    const read = await fetch(`${base}/api/permission/${SESSION}`);
    assert.equal(read.status, 401);
    const dropped = await fetch(`${base}/api/permission/${SESSION}`, { method: 'DELETE' });
    assert.equal(dropped.status, 401);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// Being in front of the gate is exactly why the secret is the whole
// authentication: without this, an unauthenticated POST would be enough.
test('the hook route in front of the gate still refuses a wrong secret', async () => {
  const { server, base } = await startRealApp();
  try {
    const res = await fetch(`${base}/api/permission/${SESSION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claudux-session-secret': 'falsch' },
      body: JSON.stringify({ tool_name: 'Bash' }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// The meta entry is written after the spawn, and a session resumed straight
// from the JSONL history has none before that - a hook firing in that window
// would be turned away and its dialog dropped without a trace.
test('a session the start route prepared is known before its meta entry exists', async () => {
  const { app, secret, server, base } = await startRealApp({ withMeta: false });
  try {
    const early = await fetch(`${base}/api/permission/${SESSION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claudux-session-secret': secret },
      body: JSON.stringify({ tool_name: 'Bash' }),
    });
    assert.equal(early.status, 404, 'precondition: without meta and without prepare, unknown');

    app.locals.permissionStore.prepare(SESSION);
    const prepared = await fetch(`${base}/api/permission/${SESSION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claudux-session-secret': secret },
      body: JSON.stringify({ tool_name: 'Bash' }),
    });
    assert.equal(prepared.status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// The exemption has to be in server.js: the app-level parser runs first and
// would already have answered 413. Only the real app can tell that apart
// from a router that happens to have its own parser.
test('the real app lets a large tool input through to the hook route', async () => {
  const { app, secret, server, base } = await startRealApp();
  try {
    const content = 'y'.repeat(300 * 1024);
    const res = await fetch(`${base}/api/permission/${SESSION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claudux-session-secret': secret },
      body: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/srv/example/big.txt', content } }),
    });
    assert.equal(res.status, 200);
    assert.equal(app.locals.permissionStore.get(SESSION).toolInput.content.length, content.length);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// The hook router is mounted at /api, so a parser attached to the router
// instead of to the route would parse every other /api request too and hand
// it the hook's limit. It stays invisible for the paths the global parser
// still covers - it gets there first - but /api/files is exempted from that
// one as well, and its own limit is HIGHER than the hook's.
test('the hook router parses its own route only, not everything under /api', async () => {
  const { store } = tmpStore();
  const app = express();
  app.use('/api', permissionHookRouter({}, { store, knowsSession: () => true }));
  app.post('/api/elsewhere', (req, res) => res.json({ parsed: req.body !== undefined }));
  const res = await request(app, 'POST', '/api/elsewhere', { body: { a: 1 } });
  assert.equal(res.body.parsed, false);
});
