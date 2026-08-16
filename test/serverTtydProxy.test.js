// test/serverTtydProxy.test.js
//
// test/ttydProxy.test.js proves the proxy pattern itself works against a
// throwaway Express app; it never imports src/server.js. This file proves
// createApp() actually wires that pattern correctly - target port from
// config, /ttyd prefix and query string preserved end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';

// Stands in for the real ttyd process: echoes the path it received, which
// is exactly what proves the /ttyd prefix survived the proxy hop (Express'
// own path-mounting would have stripped it, see the comment in server.js).
function fakeTtydBackend() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('path-seen:' + req.url);
  });
  // Counts what got through: the origin check has to be measured by whether
  // the upgrade ever reached ttyd, not just by the client's status code.
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

// A raw upgrade request rather than `new WebSocket()`: the browser sets
// Origin itself and the WebSocket API offers no way to choose it, which is
// exactly the header under test here.
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

function tmpConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-data-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-claude-'));
  return {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    authEnabled: false,
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ttydPort: 1,
    ...overrides,
  };
}

test('createApp wires /ttyd/* to the configured ttydPort, prefix and query string intact', async () => {
  const backend = fakeTtydBackend();
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;

  const app = createApp(tmpConfig({ ttydPort: backendPort }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/ttyd/foo?arg=x`, { headers: { connection: 'close' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'path-seen:/ttyd/foo?arg=x');
  } finally {
    // Mirrors the cleanup in test/ttydProxy.test.js - an open listener
    // left dangling here would keep the test run from ever exiting.
    backend.close();
    server.close();
  }
});

// The socket behind /ttyd/ws is a shell, and a browser sends the upgrade
// with the user's network position. Without this check any open page could
// open a terminal against the loopback port. The wiring is what matters
// here: the handler hangs off the raw HTTP server, where no Express
// middleware runs.
test('createApp refuses a cross-origin terminal upgrade and lets the same origin through', async () => {
  const backend = fakeTtydBackend();
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));

  const app = createApp(tmpConfig({ ttydPort: backend.address().port }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  server.on('upgrade', app.locals.ttydUpgrade);

  try {
    const foreign = await upgradeRequest(port, {
      host: `127.0.0.1:${port}`,
      origin: 'https://evil.example',
    });
    assert.equal(foreign.status, 403);
    assert.equal(backend.upgrades, 0, 'the upgrade must not reach ttyd at all');

    const own = await upgradeRequest(port, {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });
    assert.equal(own.status, 101);
    assert.equal(backend.upgrades, 1);
  } finally {
    for (const socket of backend.sockets) socket.destroy();
    backend.close();
    server.close();
  }
});
