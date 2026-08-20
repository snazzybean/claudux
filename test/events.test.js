import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { eventsRouter } from '../src/routes/events.js';
import express from 'express';

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
