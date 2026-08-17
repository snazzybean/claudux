// The update route. The preconditions are checked server-side a second
// time - the client never decides this, otherwise a plain curl is enough.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { setPassword, createSession } from '../src/lib/accessStore.js';
import { updateRouter } from '../src/routes/update.js';

function serve({ readiness, checker, job }) {
  const app = express();
  app.use(express.json());
  app.use('/api/update', updateRouter({}, { checker, job, readinessFn: async () => readiness }));
  const server = app.listen(0);
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/api/update`, close: () => server.close() };
}

const READY = { mode: 'checkout', canUpdate: true, reason: null };
const BLOCKED = { mode: 'checkout', canUpdate: false, reason: 'The checkout has uncommitted changes.' };

function checkerStub(state = { current: '1.0.2', latest: 'v1.1.0', notesUrl: 'https://example.invalid/r', checkedAt: 1 }) {
  let manualCalls = 0;
  return {
    state: () => state,
    refresh: async ({ manual } = {}) => { if (manual) manualCalls++; return state; },
    manualCalls: () => manualCalls,
  };
}

function jobStub({ busy = false } = {}) {
  const started = [];
  return {
    started,
    isRunning: () => busy,
    start: async (tag) => { started.push(tag); },
    status: () => ({ phase: busy ? 'installing' : 'idle', error: null, tag: null }),
  };
}

test('GET reports version, mode and whether an update is available', async () => {
  const s = serve({ readiness: READY, checker: checkerStub(), job: jobStub() });
  const body = await (await fetch(s.base)).json();

  assert.equal(body.current, '1.0.2');
  assert.equal(body.latest, 'v1.1.0');
  assert.equal(body.mode, 'checkout');
  assert.equal(body.canUpdate, true);
  assert.equal(body.updateAvailable, true);
  s.close();
});

test('GET reports no update available when the versions match', async () => {
  const checker = checkerStub({ current: '1.0.2', latest: 'v1.0.2', notesUrl: null, checkedAt: 1 });
  const s = serve({ readiness: READY, checker, job: jobStub() });
  const body = await (await fetch(s.base)).json();

  assert.equal(body.updateAvailable, false);
  s.close();
});

test('POST /check forces a fresh look', async () => {
  const checker = checkerStub();
  const s = serve({ readiness: READY, checker, job: jobStub() });

  const res = await fetch(`${s.base}/check`, { method: 'POST' });

  assert.equal(res.status, 200);
  assert.equal(checker.manualCalls(), 1);
  s.close();
});

test('POST starts the job with the release tag', async () => {
  const job = jobStub();
  const s = serve({ readiness: READY, checker: checkerStub(), job });

  const res = await fetch(s.base, { method: 'POST' });

  assert.equal(res.status, 202);
  assert.deepEqual(job.started, ['v1.1.0']);
  s.close();
});

// Whoever reaches the route reaches a process that runs git and npm - the
// blocked reason has to hold here too, not just in the interface.
test('POST refuses when the checkout is not ready and repeats the reason', async () => {
  const job = jobStub();
  const s = serve({ readiness: BLOCKED, checker: checkerStub(), job });

  const res = await fetch(s.base, { method: 'POST' });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error, /uncommitted/);
  assert.deepEqual(job.started, []);
  s.close();
});

test('POST refuses when there is nothing newer', async () => {
  const checker = checkerStub({ current: '1.0.2', latest: 'v1.0.2', notesUrl: null, checkedAt: 1 });
  const s = serve({ readiness: READY, checker, job: jobStub() });

  const res = await fetch(s.base, { method: 'POST' });

  assert.equal(res.status, 400);
  s.close();
});

test('a second POST during a running job answers 409 and starts nothing', async () => {
  const job = jobStub({ busy: true });
  const s = serve({ readiness: READY, checker: checkerStub(), job });

  const res = await fetch(s.base, { method: 'POST' });

  assert.equal(res.status, 409);
  assert.deepEqual(job.started, []);
  s.close();
});

test('GET /status hands the job phase through', async () => {
  const s = serve({ readiness: READY, checker: checkerStub(), job: jobStub() });
  const body = await (await fetch(`${s.base}/status`)).json();

  assert.equal(body.phase, 'idle');
  s.close();
});

// The stubs above test the logic; this one tests the assembly. Behind this
// route sits a process that runs git and npm as whoever the service runs as,
// so the gate has to hold for it - which the router alone cannot show.
test('the route is mounted behind the gate: 401 without a session, an answer with one', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-updateroute-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-updateroute-claude-'));
  const config = {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    accessSecretPath: path.join(dataDir, 'access.json'),
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ttydPort: 1,
  };
  const app = createApp(config);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/update`;

  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { method: 'POST' })).status, 401);

    // The 401s above would also arrive for a path nobody mounted - the gate
    // answers every /api url. Only this one shows the route is really there.
    // Deliberately /status: it is the one that answers without asking GitHub,
    // so this test needs no network.
    setPassword(config.accessSecretPath, 'the-password');
    const cookie = `claudux_session=${createSession(config.accessSecretPath)}`;
    const res = await fetch(`${base}/status`, { headers: { cookie } });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).phase, 'idle');
  } finally {
    server.close();
  }
});
