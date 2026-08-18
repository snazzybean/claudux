// The route. `versionFn` is injectable, so no test needs a real
// `claude` process - the same consideration as with Claudux' own update,
// whose GET tests likewise only run against /status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { setPassword, createSession } from '../src/lib/accessStore.js';
import { claudeUpdateRouter } from '../src/routes/claudeUpdate.js';

function tmpSettingsPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-ccupdate-route-')), 'claude-update.json');
}

function jobStub({ busy = false, status } = {}) {
  const started = [];
  return {
    started,
    isRunning: () => busy,
    start: async () => { started.push(true); },
    status: () => status ?? { phase: 'idle', updated: null, from: null, to: null, error: null, ranAt: null },
  };
}

function serve({
  job = jobStub(), versionFn = async () => '2.1.234', installMethodFn = () => null, settingsPath = tmpSettingsPath(),
} = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/claude-update', claudeUpdateRouter({ claudeUpdateSettingsPath: settingsPath }, { job, versionFn, installMethodFn }));
  const server = app.listen(0);
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/api/claude-update`, close: () => server.close() };
}

test('GET reports the live version, toggle state, and last result', async () => {
  const s = serve({
    job: jobStub({ status: { phase: 'done', updated: true, from: '2.1.226', to: '2.1.234', error: null, ranAt: 1000 } }),
  });
  const body = await (await fetch(s.base)).json();

  assert.equal(body.current, '2.1.234');
  assert.equal(body.autoUpdateEnabled, true);
  assert.equal(body.lastRunAt, 1000);
  assert.equal(body.lastResult, 'updated');
  s.close();
});

test('GET passes the install method through as-is', async () => {
  const s = serve({ installMethodFn: () => 'global' });
  const body = await (await fetch(s.base)).json();

  assert.equal(body.installMethod, 'global');
  s.close();
});

test('GET reports up-to-date when the last run made no change', async () => {
  const s = serve({
    job: jobStub({ status: { phase: 'done', updated: false, from: '2.1.234', to: '2.1.234', error: null, ranAt: 1000 } }),
  });
  const body = await (await fetch(s.base)).json();

  assert.equal(body.lastResult, 'up-to-date');
  s.close();
});

test('GET reports no result before the first run', async () => {
  const s = serve();
  const body = await (await fetch(s.base)).json();

  assert.equal(body.lastResult, null);
  s.close();
});

test('GET reports failed when the last run errored', async () => {
  const s = serve({
    job: jobStub({ status: { phase: 'failed', updated: null, from: '2.1.226', to: null, error: 'boom', ranAt: 1000 } }),
  });
  const body = await (await fetch(s.base)).json();

  assert.equal(body.lastResult, 'failed');
  s.close();
});

test('GET includes the error message when the last run failed', async () => {
  const s = serve({
    job: jobStub({ status: { phase: 'failed', updated: null, from: '2.1.226', to: null, error: 'boom', ranAt: 1000 } }),
  });
  const body = await (await fetch(s.base)).json();

  assert.equal(body.error, 'boom');
  s.close();
});

test('POST starts the job', async () => {
  const job = jobStub();
  const s = serve({ job });

  const res = await fetch(s.base, { method: 'POST' });

  assert.equal(res.status, 202);
  assert.deepEqual(job.started, [true]);
  s.close();
});

test('a second POST while one is running answers 409 and starts nothing', async () => {
  const job = jobStub({ busy: true });
  const s = serve({ job });

  const res = await fetch(s.base, { method: 'POST' });

  assert.equal(res.status, 409);
  assert.deepEqual(job.started, []);
  s.close();
});

test('GET /status hands the job status through', async () => {
  const s = serve({
    job: jobStub({ status: { phase: 'running', updated: null, from: '2.1.226', to: null, error: null, ranAt: null } }),
  });
  const body = await (await fetch(`${s.base}/status`)).json();

  assert.equal(body.phase, 'running');
  s.close();
});

test('POST /toggle persists the setting and GET reflects it', async () => {
  const s = serve();

  const toggled = await fetch(`${s.base}/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await toggled.json()).autoUpdateEnabled, false);

  const after = await (await fetch(s.base)).json();
  assert.equal(after.autoUpdateEnabled, false);
  s.close();
});

// The stubs above test the logic; this one tests the assembly - the gate
// has to hold for this route too. Deliberately /status: it is the one that
// answers without spawning a real `claude` process, so this needs no
// installed CLI.
test('the route is mounted behind the gate: 401 without a session, an answer with one', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-ccupdateroute-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-ccupdateroute-claude-'));
  const config = {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    accessSecretPath: path.join(dataDir, 'access.json'),
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ttydPort: 1,
    claudeUpdateSettingsPath: path.join(dataDir, 'claude-update.json'),
  };
  const app = createApp(config, { claudeCodeUpdateJob: jobStub() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/claude-update`;

  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { method: 'POST' })).status, 401);

    setPassword(config.accessSecretPath, 'the-password');
    const cookie = `claudux_session=${createSession(config.accessSecretPath)}`;
    const res = await fetch(`${base}/status`, { headers: { cookie } });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).phase, 'idle');
  } finally {
    server.close();
  }
});
