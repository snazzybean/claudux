// The gate as createApp() actually wires it. test/accessGate.test.js proves
// the check itself; this file proves that nothing gets served around it -
// including the terminal upgrade, which hangs off the raw HTTP server and
// never sees an Express middleware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { setPassword, createSession } from '../src/lib/accessStore.js';

// Same stand-in as in test/serverTtydProxy.test.js: the counter is what
// proves an upgrade never reached ttyd, rather than just what the client saw.
function fakeTtydBackend() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('path-seen:' + req.url);
  });
  server.upgrades = 0;
  server.sockets = new Set();
  server.on('upgrade', (req, socket) => {
    server.upgrades += 1;
    server.sockets.add(socket);
    socket.on('close', () => server.sockets.delete(socket));
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  return server;
}

function upgradeRequest(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ttyd/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.end();
  });
}

async function start(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-accessserver-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-accessserver-claude-'));
  const config = {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    accessSecretPath: path.join(dataDir, 'access.json'),
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ttydPort: 1,
    ...overrides,
  };
  const app = createApp(config);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('upgrade', app.locals.ttydUpgrade);
  const port = server.address().port;
  return { config, server, port, base: `http://127.0.0.1:${port}` };
}

function sessionCookie(config) {
  setPassword(config.accessSecretPath, 'the-password');
  return `claudux_session=${createSession(config.accessSecretPath)}`;
}

const HTML = { accept: 'text/html,application/xhtml+xml' };

test('a navigation without a session gets the login page under its own url', async () => {
  const { base, server } = await start();
  try {
    const res = await fetch(`${base}/`, { headers: HTML, redirect: 'manual' });
    assert.equal(res.status, 401);
    // No redirect: the address bar stays put and the PWA keeps its start_url.
    assert.equal(res.headers.get('location'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.match(body, /name="password"/);
    assert.equal(body.includes('id="sidebar"'), false, 'this must not be the app');
  } finally {
    server.close();
  }
});

test('a navigation with a valid session gets the app', async () => {
  const { base, config, server } = await start();
  try {
    const res = await fetch(`${base}/`, { headers: { ...HTML, cookie: sessionCookie(config) } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Claudux<\/title>/);
  } finally {
    server.close();
  }
});

// A redirect or an html body here would land in the JSON parser of app.js
// and produce a misleading error instead of a clean 401.
test('an api call without a session gets json, not a page', async () => {
  const { base, server } = await start();
  try {
    const res = await fetch(`${base}/api/sessions`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.error, 'not authenticated');
    assert.equal(body.setupNeeded, true);
  } finally {
    server.close();
  }
});

test('the frontend files are behind the gate, the stylesheet and the icons are not', async () => {
  const { base, config, server } = await start();
  try {
    assert.equal((await fetch(`${base}/styles.css`)).status, 200);
    assert.equal((await fetch(`${base}/manifest.json`)).status, 200);
    assert.equal((await fetch(`${base}/icons/icon-192.png`)).status, 200);

    assert.equal((await fetch(`${base}/app.js`)).status, 401);
    assert.equal((await fetch(`${base}/js/terminal.js`)).status, 401);
    assert.equal((await fetch(`${base}/sw.js`)).status, 401);
    assert.equal((await fetch(`${base}/index.html`, { headers: HTML })).status, 401);

    const cookie = sessionCookie(config);
    assert.equal((await fetch(`${base}/app.js`, { headers: { cookie } })).status, 200);
  } finally {
    server.close();
  }
});

// The terminal lives in an iframe, and an iframe navigation asks for html.
// Answering it with the login page would render a second login screen inside
// the terminal pane instead of reporting a lost session.
test('the ttyd path never answers with the login page', async () => {
  const { base, server } = await start();
  try {
    const res = await fetch(`${base}/ttyd/?arg=x`, { headers: HTML, redirect: 'manual' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal((await res.text()).includes('name="password"'), false);
  } finally {
    server.close();
  }
});

// The socket behind /ttyd/ws is a shell. This handler hangs off the raw HTTP
// server, so the middleware above never runs for it - both directions are
// asserted, because a guard that refuses everything would pass the first
// half and make the terminal unusable.
test('the terminal upgrade needs a session and works with one', async () => {
  const backend = fakeTtydBackend();
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const { port, config, server } = await start({ ttydPort: backend.address().port });

  try {
    const anonymous = await upgradeRequest(port, {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });
    assert.equal(anonymous.status, 401);
    assert.equal(backend.upgrades, 0, 'the upgrade must not reach ttyd at all');

    const authenticated = await upgradeRequest(port, {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      cookie: sessionCookie(config),
    });
    assert.equal(authenticated.status, 101);
    assert.equal(backend.upgrades, 1);
  } finally {
    for (const socket of backend.sockets) socket.destroy();
    backend.close();
    server.close();
  }
});

test('with authEnabled false everything is reachable as before', async () => {
  const { base, port, server } = await start({ authEnabled: false });
  try {
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/api/projects`)).status, 200);
    const upgrade = await upgradeRequest(port, {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });
    // ttydPort 1 has nothing listening, so the proxy fails - what matters is
    // that the refusal is not a 401 from the gate.
    assert.notEqual(upgrade.status, 401);
  } finally {
    server.close();
  }
});
