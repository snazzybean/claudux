import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyAll } from '../src/lib/notifier.js';
import { createApp } from '../src/server.js';
import { setMeta } from '../src/lib/sessionMeta.js';
import { addTarget, listTargets } from '../src/lib/notificationTargets.js';
import { addAccount } from '../src/lib/accountStore.js';

function tmpConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-notify-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-notify-claude-'));
  return {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    authEnabled: false,
    // Into the tmpdir, so a test never reads or writes the installation's
    // real target store.
    notificationTargetsPath: path.join(dataDir, 'notifications.json'),
    // Same reason, and here it matters more: writing the installation's real
    // keypair would unsubscribe every device registered against it.
    vapidKeysPath: path.join(dataDir, 'vapid.json'),
    vapidSubject: 'https://claudux.example.com',
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ...overrides,
  };
}

const OK = { ok: true, status: 200, statusText: 'OK' };

test('notifyAll sends to every enabled target and skips the rest', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return OK; };
  await notifyAll(
    [
      { id: '1', type: 'ntfy', enabled: true, config: { url: 'https://ntfy.sh', topic: 'a' } },
      { id: '2', type: 'ntfy', enabled: false, config: { url: 'https://ntfy.sh', topic: 'b' } },
      { id: '3', type: 'webhook', enabled: true, config: { url: 'https://x.example/h', method: 'POST', headers: {}, bodyTemplate: '{{body}}' } },
    ],
    { title: 't', body: 'b' },
    { fetchFn },
  );
  assert.deepEqual(urls, ['https://ntfy.sh/a', 'https://x.example/h']);
});

test('one dead target does not stop the others and does not reject', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    if (url.includes('dead')) throw new Error('ECONNREFUSED');
    urls.push(url);
    return OK;
  };
  await notifyAll(
    [
      { id: '1', type: 'ntfy', enabled: true, config: { url: 'https://dead.example', topic: 'a' } },
      { id: '2', type: 'ntfy', enabled: true, config: { url: 'https://ntfy.sh', topic: 'b' } },
    ],
    { title: 't', body: 'b' },
    { fetchFn },
  );
  // Express 4 does not forward rejections from async handlers, and an
  // unhandled rejection ends the process - so this must never reject.
  assert.deepEqual(urls, ['https://ntfy.sh/b']);
});

test('an unknown target type is ignored', async () => {
  let called = false;
  await notifyAll(
    [{ id: '1', type: 'carrier-pigeon', enabled: true, config: {} }],
    { title: 't', body: 'b' },
    { fetchFn: async () => { called = true; return OK; } },
  );
  assert.equal(called, false);
});

test('POST /api/notify returns 204 and uses the known account from sessionMeta', async () => {
  const received = [];
  const ntfyServer = http.createServer((req, res) => {
    received.push({ path: req.url, title: req.headers.title, click: req.headers.click });
    res.end('ok');
  });
  await new Promise((resolve) => ntfyServer.listen(0, resolve));
  const { port: ntfyPort } = ntfyServer.address();

  const config = tmpConfig();
  addTarget(config.notificationTargetsPath, {
    type: 'ntfy', name: 'stub', config: { url: `http://127.0.0.1:${ntfyPort}`, topic: 'test' },
  });
  const account = addAccount(config.accountsSecretPath, 'work', 'sk-test-token');
  setMeta(config.dataDir, 'abc123', { accountId: account.id, projectId: 'p1' });

  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'abc123', message: 'Session waiting for input' }),
  });

  server.close();
  server.closeAllConnections();
  ntfyServer.close();
  ntfyServer.closeAllConnections();

  assert.equal(res.status, 204);
  assert.equal(received.length, 1);
  assert.equal(received[0].title, 'Claudux (work)');
  assert.match(received[0].click, /\/#\/session\/abc123$/);
});

// An unset publicBaseUrl interpolates to the relative "/#/session/<id>", which
// is truthy - ntfy would get a Click header it cannot use and may drop the
// message.
test('POST /api/notify sends no click link when publicBaseUrl is unset', async () => {
  const received = [];
  const ntfyServer = http.createServer((req, res) => {
    received.push({ click: req.headers.click });
    res.end('ok');
  });
  await new Promise((resolve) => ntfyServer.listen(0, resolve));
  const { port: ntfyPort } = ntfyServer.address();

  const config = tmpConfig({ publicBaseUrl: '' });
  addTarget(config.notificationTargetsPath, {
    type: 'ntfy', name: 'stub', config: { url: `http://127.0.0.1:${ntfyPort}`, topic: 'test' },
  });

  const server = createApp(config).listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'abc123', message: 'waiting' }),
  });

  server.close();
  server.closeAllConnections();
  ntfyServer.close();
  ntfyServer.closeAllConnections();

  assert.equal(res.status, 204);
  assert.equal(received.length, 1);
  assert.equal(received[0].click, undefined);
});

test('POST /api/notify with a valid but unknown sessionId responds 204 with account "unknown"', async () => {
  const received = [];
  const ntfyServer = http.createServer((req, res) => {
    received.push({ title: req.headers.title, click: req.headers.click });
    res.end('ok');
  });
  await new Promise((resolve) => ntfyServer.listen(0, resolve));
  const { port: ntfyPort } = ntfyServer.address();

  // isValidSlug lets this sessionId through (only [a-zA-Z0-9-]), but there
  // is no setMeta() entry for it → the account must fall back to "unknown",
  // instead of e.g. silently slipping through as undefined.
  const config = tmpConfig();
  addTarget(config.notificationTargetsPath, {
    type: 'ntfy', name: 'stub', config: { url: `http://127.0.0.1:${ntfyPort}`, topic: 'test' },
  });
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'not-known', message: 'test message' }),
  });

  server.close();
  server.closeAllConnections();
  ntfyServer.close();
  ntfyServer.closeAllConnections();

  assert.equal(res.status, 204);
  assert.equal(received.length, 1);
  assert.equal(received[0].title, 'Claudux (unknown)');
  assert.match(received[0].click, /\/#\/session\/not-known$/);
});

test('POST /api/notify with an empty sessionId degrades instead of blocking', async () => {
  const received = [];
  const ntfyServer = http.createServer((req, res) => {
    received.push({ title: req.headers.title, click: req.headers.click });
    res.end('ok');
  });
  await new Promise((resolve) => ntfyServer.listen(0, resolve));
  const { port: ntfyPort } = ntfyServer.address();

  const config = tmpConfig();
  addTarget(config.notificationTargetsPath, {
    type: 'ntfy', name: 'stub', config: { url: `http://127.0.0.1:${ntfyPort}`, topic: 'test' },
  });
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: '', message: 'test message' }),
  });

  server.close();
  server.closeAllConnections();
  ntfyServer.close();
  ntfyServer.closeAllConnections();

  assert.equal(res.status, 204);
  assert.equal(received.length, 1);
  assert.equal(received[0].title, 'Claudux (unknown)');
  assert.equal(received[0].click, undefined);
});

test('POST /api/notify does not crash the server when ntfy is unreachable', async () => {
  // The only target points at a dead port, so the provider's fetch rejects:
  // notifyAll must swallow it per target, or the unhandled rejection ends
  // the process.
  const config = tmpConfig();
  addTarget(config.notificationTargetsPath, {
    type: 'ntfy', name: 'dead', config: { url: 'http://127.0.0.1:1', topic: 'test' },
  });
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'abc123', message: 'test message' }),
  });

  server.close();
  server.closeAllConnections();
  assert.equal(res.status, 204);
});

// --- pruning dead subscriptions ---
//
// A stub http server as the push endpoint, the pattern the route tests above
// already use: createApp takes no injected fetch, and inventing a second way
// in would be one way too many.
const PUSH_KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

function pushTarget(id = 'push-1', overrides = {}) {
  return {
    id,
    type: 'webpush',
    name: 'iPhone',
    enabled: true,
    config: { endpoint: 'https://web.push.apple.com/device/abc', keys: PUSH_KEYS },
    ...overrides,
  };
}

function vapidOptions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-notifier-vapid-'));
  return { vapidKeysPath: path.join(dir, 'vapid.json'), vapidSubject: 'https://claudux.example.com' };
}

async function stubPushService(status) {
  const server = http.createServer((req, res) => {
    res.writeHead(status);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/device/abc`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

test('notifyAll reports a 410 target as gone', async () => {
  const result = await notifyAll([pushTarget()], { title: 't', body: 'b' }, {
    fetchFn: async () => ({ ok: false, status: 410, statusText: 'Gone' }),
    ...vapidOptions(),
  });
  assert.deepEqual(result.goneIds, ['push-1']);
});

test('notifyAll reports a 404 target as gone too', async () => {
  const result = await notifyAll([pushTarget()], { title: 't', body: 'b' }, {
    fetchFn: async () => ({ ok: false, status: 404, statusText: 'Not Found' }),
    ...vapidOptions(),
  });
  assert.deepEqual(result.goneIds, ['push-1']);
});

test('notifyAll does not report a 502 target as gone', async () => {
  const result = await notifyAll([pushTarget()], { title: 't', body: 'b' }, {
    fetchFn: async () => ({ ok: false, status: 502, statusText: 'Bad Gateway' }),
    ...vapidOptions(),
  });
  assert.deepEqual(result.goneIds, []);
});

test('notifyAll does not report a 403 target as gone', async () => {
  // A mismatched keypair is not a dead device - deleting here would destroy
  // an intact registration.
  const result = await notifyAll([pushTarget()], { title: 't', body: 'b' }, {
    fetchFn: async () => ({ ok: false, status: 403, statusText: 'Forbidden' }),
    ...vapidOptions(),
  });
  assert.deepEqual(result.goneIds, []);
});

test('a gone target does not stop the others from being sent to', async () => {
  const urls = [];
  const result = await notifyAll(
    [
      pushTarget(),
      { id: 'ntfy-1', type: 'ntfy', name: 'phone', enabled: true, config: { url: 'https://ntfy.example', topic: 't' } },
    ],
    { title: 't', body: 'b' },
    {
      fetchFn: async (url) => {
        urls.push(url);
        return url.includes('web.push') ? { ok: false, status: 410, statusText: 'Gone' } : OK;
      },
      ...vapidOptions(),
    },
  );
  assert.deepEqual(result.goneIds, ['push-1']);
  assert.ok(urls.some((u) => u.includes('ntfy.example')));
});

test('notifyAll still resolves when every target fails', async () => {
  const result = await notifyAll([pushTarget()], { title: 't', body: 'b' }, {
    fetchFn: async () => { throw new Error('network down'); },
    ...vapidOptions(),
  });
  assert.deepEqual(result.goneIds, []);
});

test('a disabled webpush target is skipped and never reported gone', async () => {
  let called = false;
  const result = await notifyAll([pushTarget('push-1', { enabled: false })], { title: 't', body: 'b' }, {
    fetchFn: async () => { called = true; return { ok: false, status: 410, statusText: 'Gone' }; },
    ...vapidOptions(),
  });
  assert.equal(called, false);
  assert.deepEqual(result.goneIds, []);
});

test('POST /api/notify removes a target the push service reported gone', async () => {
  const push = await stubPushService(410);
  const config = tmpConfig();
  const id = addTarget(config.notificationTargetsPath, {
    type: 'webpush', name: 'iPhone', config: { endpoint: push.endpoint, keys: PUSH_KEYS },
  });
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'some-session', message: 'done' }),
    });
    assert.equal(res.status, 204);
    assert.equal(listTargets(config.notificationTargetsPath).find((t) => t.id === id), undefined);
  } finally {
    server.close();
    server.closeAllConnections();
    push.close();
  }
});

test('POST /api/notify keeps a target after a temporary failure', async () => {
  const push = await stubPushService(502);
  const config = tmpConfig();
  const id = addTarget(config.notificationTargetsPath, {
    type: 'webpush', name: 'iPhone', config: { endpoint: push.endpoint, keys: PUSH_KEYS },
  });
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'some-session', message: 'done' }),
    });
    assert.ok(listTargets(config.notificationTargetsPath).find((t) => t.id === id));
  } finally {
    server.close();
    server.closeAllConnections();
    push.close();
  }
});
