import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { eventsRouter } from '../src/routes/events.js';
import express from 'express';
import { createApp } from '../src/server.js';
import { tmpConfig } from './helpers/routeHarness.js';

// Minimal SSE client: connects, collects raw chunks, disconnects.
async function collectFirstEvent(port, publishFn) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('\n\n') && buf.includes('event:')) {
          req.destroy();
          resolve(buf);
        }
      });
      res.on('error', reject);
      // The connection banner arrives first; publish once it's open.
      setTimeout(publishFn, 20);
    });
    req.on('error', () => {}); // destroy() above triggers a benign ECONNRESET
  });
}

test('publish defaults to the status event type', async () => {
  const { router, publish } = eventsRouter();
  const app = express();
  app.use('/', router);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const raw = await collectFirstEvent(port, () => publish({ tmuxSession: 'a', state: 'busy' }));
    assert.match(raw, /event: status\ndata: \{"tmuxSession":"a","state":"busy"\}/);
  } finally {
    server.close();
  }
});

test('publish carries a given event type through', async () => {
  const { router, publish } = eventsRouter();
  const app = express();
  app.use('/', router);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const raw = await collectFirstEvent(port, () => publish({ tmuxSession: 'a', agents: [] }, 'subagents'));
    assert.match(raw, /event: subagents\ndata: \{"tmuxSession":"a","agents":\[\]\}/);
  } finally {
    server.close();
  }
});

// Through createApp(), not eventsRouter() alone: compression() sits ahead of
// /api/events in the real middleware chain, and a request that falls through
// past the static-asset middlewares still carries its patched res.write - a
// browser's EventSource always sends Accept-Encoding, unlike the plain HTTP
// client above, so this is the case that actually broke in production
// (gzip buffers writes waiting for its window to fill, and a stream that
// lives on small, infrequent chunks never fills it - the connection sat in
// CONNECTING forever, never even reaching 'open').
test('the real app does not gzip the SSE stream', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    assert.equal(res.headers.get('content-encoding'), null);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    await res.body.cancel();
  } finally {
    server.close();
  }
});

// The stream carries deltas, so a client that connects while agents are
// already running would start blind and stay that way for as long as
// nothing changes - which for a stable set of agents can be forever. The
// opening picture rides on the same connection, ahead of the first delta.
test('a new client receives the current picture before any delta', async () => {
  const { router, setInitialEvents } = eventsRouter();
  setInitialEvents(() => [{ type: 'subagents', event: { tmuxSession: 'a', sessionId: 'sess-1', agents: [{ agentId: 'aaa111', status: 'active' }] } }]);
  const app = express();
  app.use('/', router);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const raw = await collectFirstEvent(port, () => {});
    assert.match(raw, /event: subagents\ndata: \{"tmuxSession":"a","sessionId":"sess-1","agents":\[\{"agentId":"aaa111","status":"active"\}\]\}/);
  } finally {
    server.close();
  }
});

test('a new client gets only the connection banner when nothing is running', async () => {
  const { router, publish, setInitialEvents } = eventsRouter();
  setInitialEvents(() => []);
  const app = express();
  app.use('/', router);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const raw = await collectFirstEvent(port, () => publish({ tmuxSession: 'a', state: 'busy' }));
    assert.equal(raw.indexOf('event:'), raw.lastIndexOf('event:'));
    assert.match(raw, /^: connected\n\nevent: status\n/);
  } finally {
    server.close();
  }
});
