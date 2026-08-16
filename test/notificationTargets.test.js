// test/notificationTargets.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listTargets,
  listTargetsForApi,
  addTarget,
  updateTarget,
  removeTarget,
  removeTargets,
  findByEndpoint,
} from '../src/lib/notificationTargets.js';

function freshPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-nt-')), 'notifications.json');
}

const WEBHOOK = {
  type: 'webhook',
  name: 'Chat',
  enabled: true,
  config: {
    url: 'https://chat.example/hooks/secret-part',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
    bodyTemplate: '{"content": "{{title}}: {{body}}"}',
  },
};

// The store is the only source: nothing configured means nothing is sent.
test('an empty store lists nothing', () => {
  assert.deepEqual(listTargets(freshPath()), []);
});

test('the file is written 0600', () => {
  const p = freshPath();
  addTarget(p, WEBHOOK);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test('listTargetsForApi never hands out url or header values', () => {
  const p = freshPath();
  addTarget(p, WEBHOOK);
  const [api] = listTargetsForApi(p);
  const asText = JSON.stringify(api);
  assert.ok(!asText.includes('secret-part'));
  assert.ok(!asText.includes('Bearer abc'));
  assert.equal(api.summary, 'https://chat.example/…');
  assert.equal(api.hasSecret, true);
  assert.equal(api.name, 'Chat');
});

test('updateTarget changes single fields and leaves the rest alone', () => {
  const p = freshPath();
  const id = addTarget(p, WEBHOOK);
  assert.equal(updateTarget(p, id, { enabled: false }), true);
  const [stored] = listTargets(p);
  assert.equal(stored.enabled, false);
  assert.equal(stored.config.url, 'https://chat.example/hooks/secret-part');
  assert.equal(updateTarget(p, 'nope', { enabled: true }), false);
});

test('removeTarget removes exactly one entry', () => {
  const p = freshPath();
  const id = addTarget(p, WEBHOOK);
  assert.equal(removeTarget(p, id), true);
  assert.equal(removeTarget(p, id), false);
  assert.equal(listTargets(p).length, 0);
});

test('a corrupt file reads as empty instead of crashing', () => {
  const p = freshPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ broken');
  assert.deepEqual(listTargets(p), []);
});

// Rotating a webhook's token means patching one header. Replacing the whole
// set would silently drop Content-Type - and with it the flag that makes
// the provider escape quotes in a title.
test('a patch adds single headers instead of replacing the set', () => {
  const p = freshPath();
  const id = addTarget(p, WEBHOOK);
  updateTarget(p, id, { config: { headers: { Authorization: 'Bearer new' } } });
  const [stored] = listTargets(p);
  assert.deepEqual(stored.config.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer new',
  });
  assert.equal(stored.config.bodyTemplate, '{"content": "{{title}}: {{body}}"}');
});

// --- web push targets ---
const SUB = {
  endpoint: 'https://web.push.apple.com/device/abc',
  keys: { p256dh: 'BCVxsr7N_eNg', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
};

test('findByEndpoint locates a webpush target and ignores the others', () => {
  const file = freshPath();
  addTarget(file, { type: 'ntfy', name: 'phone', config: { url: 'https://ntfy.example', topic: 't' } });
  const id = addTarget(file, { type: 'webpush', name: 'iPhone', config: SUB });
  assert.equal(findByEndpoint(file, SUB.endpoint)?.id, id);
  assert.equal(findByEndpoint(file, 'https://web.push.apple.com/device/other'), undefined);
});

test('findByEndpoint on an empty store returns undefined instead of throwing', () => {
  assert.equal(findByEndpoint(freshPath(), SUB.endpoint), undefined);
});

test('a webpush target summarizes to the push service origin', () => {
  const file = freshPath();
  addTarget(file, { type: 'webpush', name: 'iPhone', config: SUB });
  const [listed] = listTargetsForApi(file);
  // The origin says WHICH push service is behind it, and the path - the part
  // identifying the device - stays on the server.
  assert.equal(listed.summary, 'https://web.push.apple.com/…');
  assert.equal(listed.hasSecret, true);
});

test('neither the keys nor the full endpoint leave through the api', () => {
  const file = freshPath();
  addTarget(file, { type: 'webpush', name: 'iPhone', config: SUB });
  const serialized = JSON.stringify(listTargetsForApi(file));
  assert.equal(serialized.includes('BTBZMqHH6r4Tts7J_aSIgg'), false);
  assert.equal(serialized.includes('BCVxsr7N_eNg'), false);
  assert.equal(serialized.includes('/device/abc'), false);
});

test('a webpush target without keys reports no secret', () => {
  const file = freshPath();
  addTarget(file, { type: 'webpush', name: 'broken', config: { endpoint: SUB.endpoint } });
  assert.equal(listTargetsForApi(file)[0].hasSecret, false);
});

test('removeTargets removes several at once and ignores unknown ids', () => {
  const file = freshPath();
  const first = addTarget(file, { type: 'webpush', name: 'a', config: SUB });
  const second = addTarget(file, {
    type: 'webpush',
    name: 'b',
    config: { ...SUB, endpoint: 'https://web.push.apple.com/device/two' },
  });
  const kept = addTarget(file, { type: 'ntfy', name: 'phone', config: { url: 'https://n.example', topic: 't' } });
  removeTargets(file, [first, second, 'never-existed']);
  assert.deepEqual(listTargets(file).map((t) => t.id), [kept]);
});

test('removeTargets on an empty list leaves the store alone', () => {
  const file = freshPath();
  const id = addTarget(file, { type: 'webpush', name: 'a', config: SUB });
  removeTargets(file, []);
  assert.equal(listTargets(file).length, 1);
  assert.equal(listTargets(file)[0].id, id);
});
