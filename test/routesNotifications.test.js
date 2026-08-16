// Everything that leaves the host on its own: POST /api/notify, the
// notification targets, the event stream, and web push registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { addTarget, listTargets, updateTarget } from '../src/lib/notificationTargets.js';
import { tmpConfig } from './helpers/routeHarness.js';

// ---------- Notify only when nobody is looking ----------
//
// A notification goes out after every response. If someone is currently
// sitting in front of exactly this session, it is just noise. The
// frontend therefore reports at intervals which session is open and
// visible; the notify route checks that before sending anything.
//
// Instead of injecting a fetch, a real HTTP server stands in for ntfy
// here: that tests the actual path the message takes, rather than a stub
// placed in front of it.
function startNtfyStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ url: req.url, body });
      res.writeHead(200).end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// There is no .env fallback any more: a notification only reaches a target
// that exists in the store, so a test expecting one has to create it.
function configWithNtfyTarget(url) {
  const config = tmpConfig();
  addTarget(config.notificationTargetsPath, { type: 'ntfy', name: 'stub', config: { url, topic: 'test' } });
  return config;
}

test('POST /api/notify sends nothing while the session is reported visible', async () => {
  const ntfy = await startNtfyStub();
  const app = createApp(configWithNtfyTarget(ntfy.url));
  const server = app.listen(0);
  const { port } = server.address();
  const sessionId = crypto.randomUUID();

  try {
    await fetch(`http://127.0.0.1:${port}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, visible: true }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'waiting' }),
    });

    // The caller still gets 204: from its point of view nothing went
    // wrong, there was just nothing to report.
    assert.equal(res.status, 204);
    assert.equal(ntfy.received.length, 0);
  } finally {
    server.close();
    ntfy.server.close();
  }
});

test('POST /api/notify sends once the session is reported hidden', async () => {
  const ntfy = await startNtfyStub();
  const app = createApp(configWithNtfyTarget(ntfy.url));
  const server = app.listen(0);
  const { port } = server.address();
  const sessionId = crypto.randomUUID();

  try {
    for (const visible of [true, false]) {
      await fetch(`http://127.0.0.1:${port}/api/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, visible }),
      });
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'waiting' }),
    });

    assert.equal(res.status, 204);
    assert.equal(ntfy.received.length, 1);
    assert.match(ntfy.received[0].body, /waiting/);
  } finally {
    server.close();
    ntfy.server.close();
  }
});

// A session that was never reported (nobody has Claudux open) must send a
// notification - that's the main case this function exists for.
test('POST /api/notify sends for a session that was never reported', async () => {
  const ntfy = await startNtfyStub();
  const app = createApp(configWithNtfyTarget(ntfy.url));
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: crypto.randomUUID(), message: 'waiting' }),
    });

    assert.equal(res.status, 204);
    assert.equal(ntfy.received.length, 1);
  } finally {
    server.close();
    ntfy.server.close();
  }
});

// The visibility of ANOTHER session must not suppress anything - otherwise
// all notifications would go silent as soon as some tab is open anywhere.
test('POST /api/notify sends when a different session is visible', async () => {
  const ntfy = await startNtfyStub();
  const app = createApp(configWithNtfyTarget(ntfy.url));
  const server = app.listen(0);
  const { port } = server.address();

  try {
    await fetch(`http://127.0.0.1:${port}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: crypto.randomUUID(), visible: true }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: crypto.randomUUID(), message: 'waiting' }),
    });

    assert.equal(res.status, 204);
    assert.equal(ntfy.received.length, 1);
  } finally {
    server.close();
    ntfy.server.close();
  }
});

test('POST /api/notifications/targets creates a target, GET hides the secret', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const created = await fetch(`http://127.0.0.1:${port}/api/notifications/targets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'webhook',
      name: 'Chat',
      config: { url: 'https://chat.example/hooks/secret-part', method: 'POST', headers: {}, bodyTemplate: '{{body}}' },
    }),
  });
  assert.equal(created.status, 201);

  const body = await (await fetch(`http://127.0.0.1:${port}/api/notifications/targets`)).text();
  assert.ok(!body.includes('secret-part'));
  assert.ok(body.includes('"name":"Chat"'));
  server.close();
});

test('PATCH /api/notifications/targets/:id toggles enabled without the config', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const { id } = await (await fetch(`http://127.0.0.1:${port}/api/notifications/targets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'ntfy', name: 'Phone', config: { url: 'https://ntfy.sh', topic: 'x' } }),
  })).json();

  const res = await fetch(`http://127.0.0.1:${port}/api/notifications/targets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 200);

  const { targets } = await (await fetch(`http://127.0.0.1:${port}/api/notifications/targets`)).json();
  assert.equal(targets.find((t) => t.id === id).enabled, false);
  server.close();
});

test('POST /api/notifications/targets rejects an unknown type', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/notifications/targets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'carrier-pigeon', name: 'x', config: {} }),
  });
  assert.equal(res.status, 400);
  server.close();
});

// A target missing the field its provider cannot work without is accepted
// and then fails as a notification that never arrives - the one failure mode
// nobody notices.
test('POST /api/notifications/targets rejects a config without the required fields', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const cases = [
    { type: 'ntfy', name: 'no url', config: { topic: 't' } },
    { type: 'ntfy', name: 'no topic', config: { url: 'https://ntfy.example' } },
    { type: 'ntfy', name: 'blank topic', config: { url: 'https://ntfy.example', topic: '  ' } },
    { type: 'webhook', name: 'no url', config: {} },
  ];
  for (const body of cases) {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `${body.type}/${body.name} should be refused`);
  }

  const { targets } = await (await fetch(`http://127.0.0.1:${port}/api/notifications/targets`)).json();
  assert.deepEqual(targets, []);
  server.close();
});

test('DELETE /api/notifications/targets/:id answers 404 for an unknown id', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/notifications/targets/nope`, { method: 'DELETE' });
  assert.equal(res.status, 404);
  server.close();
});

test('GET /api/events answers as an unbuffered event stream', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  // A reverse proxy in front of the server is outside this repo; the header
  // is what keeps it from buffering the stream.
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  // Abort before close: an open stream keeps the server from closing, and
  // node --test would hang on the pending handle.
  controller.abort();
  server.close();
});

// --- web push registration ---
const VALID_SUBSCRIPTION = {
  endpoint: 'https://web.push.apple.com/device/abc',
  keys: {
    // 65 bytes and 16 bytes respectively - the lengths the route insists on.
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
  name: 'iPhone',
};

test('GET /api/notifications/vapid-key returns only the public key', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/vapid-key`);
    assert.equal(res.status, 200);
    const raw = await res.text();
    const payload = JSON.parse(raw);
    assert.equal(Buffer.from(payload.publicKey, 'base64url').length, 65);
    assert.equal('privateKey' in payload, false);
    assert.equal(raw.includes('BEGIN PRIVATE KEY'), false);
  } finally {
    server.close();
  }
});

test('GET /api/notifications/vapid-key answers 500 for an unreadable keypair', async () => {
  // A keypair that exists but does not parse must never be replaced: a fresh
  // one silently invalidates every registered device.
  const config = tmpConfig();
  fs.mkdirSync(path.dirname(config.vapidKeysPath), { recursive: true });
  fs.writeFileSync(config.vapidKeysPath, '{ not json');
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/vapid-key`);
    assert.equal(res.status, 500);
    assert.equal((await res.text()).includes('not json'), false);
  } finally {
    server.close();
  }
});

test('POST /api/notifications/subscribe creates a webpush target', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_SUBSCRIPTION),
    });
    assert.equal(res.status, 201);
    const stored = listTargets(config.notificationTargetsPath);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, 'webpush');
    assert.equal(stored[0].name, 'iPhone');
    assert.equal(stored[0].config.endpoint, VALID_SUBSCRIPTION.endpoint);
    assert.equal(stored[0].config.keys.auth, VALID_SUBSCRIPTION.keys.auth);
  } finally {
    server.close();
  }
});

test('subscribing twice with the same endpoint updates instead of duplicating', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/notifications/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const first = await post(VALID_SUBSCRIPTION);
    assert.equal(first.status, 201);
    const second = await post({ ...VALID_SUBSCRIPTION, name: 'iPhone 2' });
    assert.equal(second.status, 200);
    assert.equal((await first.json()).id, (await second.json()).id);
    const stored = listTargets(config.notificationTargetsPath);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'iPhone 2');
  } finally {
    server.close();
  }
});

test('re-subscribing re-enables a target that had been switched off', async () => {
  // Whoever taps "activate" on the device wants notifications - leaving the
  // row disabled would look like it worked and stay silent.
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const post = () => fetch(`http://127.0.0.1:${port}/api/notifications/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_SUBSCRIPTION),
  });
  try {
    await post();
    const [stored] = listTargets(config.notificationTargetsPath);
    updateTarget(config.notificationTargetsPath, stored.id, { enabled: false });
    await post();
    assert.equal(listTargets(config.notificationTargetsPath)[0].enabled, true);
  } finally {
    server.close();
  }
});

test('subscribe rejects a bad endpoint or bad key lengths', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/notifications/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const cases = [
      { ...VALID_SUBSCRIPTION, endpoint: 'http://web.push.apple.com/x' }, // not https
      { ...VALID_SUBSCRIPTION, endpoint: 'not a url' },
      { ...VALID_SUBSCRIPTION, keys: { ...VALID_SUBSCRIPTION.keys, p256dh: 'tooshort' } },
      { ...VALID_SUBSCRIPTION, keys: { ...VALID_SUBSCRIPTION.keys, auth: 'tooshort' } },
      { ...VALID_SUBSCRIPTION, keys: undefined },
      {},
    ];
    for (const body of cases) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(listTargets(config.notificationTargetsPath).length, 0);
  } finally {
    server.close();
  }
});

test('subscribe without a name derives one from the endpoint host', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_SUBSCRIPTION, name: '   ' }),
    });
    assert.equal(listTargets(config.notificationTargetsPath)[0].name, 'web.push.apple.com');
  } finally {
    server.close();
  }
});

test('POST /api/notifications/subscribed answers yes or no without handing out an endpoint', async () => {
  // The frontend has to tell "this device is registered" from "another device
  // on the same push service is". The target list only carries the shortened
  // origin, and the full endpoint is a credential - so the server answers the
  // question instead of handing out the data for it.
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const ask = (endpoint) => fetch(`http://127.0.0.1:${port}/api/notifications/subscribed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  try {
    assert.deepEqual(
      await (await ask(VALID_SUBSCRIPTION.endpoint)).json(),
      { registered: false, enabled: false },
    );

    await fetch(`http://127.0.0.1:${port}/api/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_SUBSCRIPTION),
    });
    assert.deepEqual(
      await (await ask(VALID_SUBSCRIPTION.endpoint)).json(),
      { registered: true, enabled: true },
    );

    // A second device on the SAME push service must not read as registered.
    assert.deepEqual(
      await (await ask('https://web.push.apple.com/device/zzz')).json(),
      { registered: false, enabled: false },
    );

    // Registered but switched off: saying "receives notifications" would be a
    // lie, so the two flags are separate.
    const [stored] = listTargets(config.notificationTargetsPath);
    updateTarget(config.notificationTargetsPath, stored.id, { enabled: false });
    assert.deepEqual(
      await (await ask(VALID_SUBSCRIPTION.endpoint)).json(),
      { registered: true, enabled: false },
    );

    // Nothing about any endpoint comes back out.
    assert.equal((await (await ask(VALID_SUBSCRIPTION.endpoint)).text()).includes('/device/'), false);
  } finally {
    server.close();
  }
});

test('subscribed tolerates a missing or non-string endpoint', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    for (const body of [{}, { endpoint: 42 }, { endpoint: null }]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/notifications/subscribed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { registered: false, enabled: false });
    }
  } finally {
    server.close();
  }
});

test('POST /api/notifications/targets refuses to create a webpush target', async () => {
  // Such a target needs a real browser with granted permission; it must not
  // be creatable from typed fields.
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'webpush', name: 'fake', config: VALID_SUBSCRIPTION }),
    });
    assert.equal(res.status, 400);
    assert.equal(listTargets(config.notificationTargetsPath).length, 0);
  } finally {
    server.close();
  }
});

test('the test button removes a subscription the service reports as gone', async () => {
  // A 410 is final per RFC 8030, so even a test removes the row - and the
  // response says so, otherwise a row vanishing on "test" is a surprise.
  const push = http.createServer((req, res) => {
    res.writeHead(410);
    res.end();
  });
  await new Promise((resolve) => push.listen(0, resolve));
  const { port: pushPort } = push.address();

  const config = tmpConfig();
  const id = addTarget(config.notificationTargetsPath, {
    type: 'webpush',
    name: 'iPhone',
    config: { endpoint: `http://127.0.0.1:${pushPort}/device/abc`, keys: VALID_SUBSCRIPTION.keys },
  });
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/targets/${id}/test`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: true, removed: true });
    assert.equal(listTargets(config.notificationTargetsPath).length, 0);
  } finally {
    server.close();
    push.close();
    push.closeAllConnections();
  }
});

test('the test button keeps a subscription after a temporary failure', async () => {
  const push = http.createServer((req, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise((resolve) => push.listen(0, resolve));
  const { port: pushPort } = push.address();

  const config = tmpConfig();
  const id = addTarget(config.notificationTargetsPath, {
    type: 'webpush',
    name: 'iPhone',
    config: { endpoint: `http://127.0.0.1:${pushPort}/device/abc`, keys: VALID_SUBSCRIPTION.keys },
  });
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/targets/${id}/test`, {
      method: 'POST',
    });
    assert.deepEqual(await res.json(), { sent: true, removed: false });
    assert.ok(listTargets(config.notificationTargetsPath).find((t) => t.id === id));
  } finally {
    server.close();
    push.close();
    push.closeAllConnections();
  }
});
