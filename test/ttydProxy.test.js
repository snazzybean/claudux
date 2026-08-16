// test/ttydProxy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

// Stands in for the real ttyd process: a plain HTTP server that echoes
// back the path it saw (proving the /ttyd prefix survives being passed on),
// plus a minimal WebSocket handshake with a test message (proving the
// upgrade is passed through too). No real ttyd binary needed here.
function fakeTtydBackend() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('path-seen:' + req.url);
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // unmasked text frame "hi"
  });
  return { server, sockets };
}

test('the /ttyd proxy middleware keeps the path for HTTP and passes the WebSocket upgrade through', async () => {
  const { server: backend, sockets: backendSockets } = fakeTtydBackend();
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;

  const app = express();
  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${backendPort}`,
    ws: true,
    pathFilter: '/ttyd',
  });
  app.use(proxy);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  server.on('upgrade', proxy.upgrade);

  const res = await fetch(`http://127.0.0.1:${port}/ttyd/foo`, { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'path-seen:/ttyd/foo');

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ttyd/ws`);
    ws.onmessage = (ev) => {
      try {
        assert.equal(ev.data, 'hi');
        ws.close();
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    ws.onerror = (e) => reject(new Error(e.message));
  });

  // The hand-built fake server implements no real close handshake -
  // without an explicit destroy() the sockets stay open and the test run
  // never finishes.
  for (const s of backendSockets) s.destroy();
  backend.close();
  server.close();
});
