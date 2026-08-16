// test/notifyProviders.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { send as sendNtfy } from '../src/lib/notify/ntfy.js';
import { send as sendWebhook } from '../src/lib/notify/webhook.js';
import { send as sendWebpush, SubscriptionGoneError } from '../src/lib/notify/webpush.js';

function recorder(response = { ok: true, status: 200, statusText: 'OK' }) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return response;
    },
  };
}

test('ntfy posts to url/topic with title and click header', async () => {
  const rec = recorder();
  await sendNtfy(
    { url: 'https://ntfy.sh', topic: 'claudux' },
    { title: 'Claudux (work)', body: 'waiting for you', clickUrl: 'https://c.example/#/session/x' },
    { fetchFn: rec.fetchFn },
  );
  assert.equal(rec.calls[0].url, 'https://ntfy.sh/claudux');
  assert.equal(rec.calls[0].init.body, 'waiting for you');
  assert.equal(rec.calls[0].init.headers.Title, 'Claudux (work)');
  assert.equal(rec.calls[0].init.headers.Click, 'https://c.example/#/session/x');
});

test('ntfy omits the click header when there is no link', async () => {
  const rec = recorder();
  await sendNtfy({ url: 'https://ntfy.sh', topic: 'claudux' }, { title: 't', body: 'b' }, { fetchFn: rec.fetchFn });
  assert.equal('Click' in rec.calls[0].init.headers, false);
});

test('webhook fills the placeholders', async () => {
  const rec = recorder();
  await sendWebhook(
    {
      url: 'https://chat.example/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"content": "{{title}} — {{body}}", "link": "{{url}}"}',
    },
    { title: 'Claudux', body: 'done', clickUrl: 'https://c.example/x' },
    { fetchFn: rec.fetchFn },
  );
  assert.equal(rec.calls[0].url, 'https://chat.example/hook');
  assert.deepEqual(JSON.parse(rec.calls[0].init.body), {
    content: 'Claudux — done',
    link: 'https://c.example/x',
  });
});

test('webhook escapes values for a JSON body', async () => {
  const rec = recorder();
  await sendWebhook(
    {
      url: 'https://chat.example/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"content": "{{body}}"}',
    },
    // A quote and a newline would break the body without escaping.
    { title: 't', body: 'he said "no"\nthen left' },
    { fetchFn: rec.fetchFn },
  );
  assert.equal(JSON.parse(rec.calls[0].init.body).content, 'he said "no"\nthen left');
});

test('webhook leaves a plain text body unescaped', async () => {
  const rec = recorder();
  await sendWebhook(
    { url: 'https://x.example/h', method: 'POST', headers: {}, bodyTemplate: '{{body}}' },
    { title: 't', body: 'he said "no"' },
    { fetchFn: rec.fetchFn },
  );
  assert.equal(rec.calls[0].init.body, 'he said "no"');
});

test('an http error status is logged, not thrown', async () => {
  const rec = recorder({ ok: false, status: 429, statusText: 'Too Many Requests' });
  await sendNtfy({ url: 'https://ntfy.sh', topic: 'claudux' }, { title: 't', body: 'b' }, { fetchFn: rec.fetchFn });
  await sendWebhook({ url: 'https://x.example/h', method: 'POST', headers: {}, bodyTemplate: 'b' },
    { title: 't', body: 'b' }, { fetchFn: rec.fetchFn });
  // fetch does not throw on 4xx, so both providers must return normally.
  assert.equal(rec.calls.length, 2);
});

// --- web push ---
//
// A keypair per test run instead of a fixture: it is generated lazily anyway,
// and a checked-in private key is exactly the material that must not sit in
// this repo.
const SUBSCRIPTION = {
  endpoint: 'https://web.push.apple.com/device/abc',
  keys: {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
};
// The matching private key from RFC 8291 section 5, used to decrypt what the
// provider produced - the only honest way to check an opaque payload.
const UA_PRIVATE = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94';

function vapidOptions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-push-'));
  return { vapidKeysPath: path.join(dir, 'vapid.json'), vapidSubject: 'https://claudux.example.com' };
}

// Decrypts as the receiving browser would. The payload is opaque from the
// outside, so this is the only way to assert what it actually carries.
function decryptAsReceiver(payload) {
  const salt = payload.subarray(0, 16);
  const asPublic = payload.subarray(21, 86);
  const ciphertext = payload.subarray(86);

  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(Buffer.from(UA_PRIVATE, 'base64url'));
  const ikm = Buffer.from(crypto.hkdfSync(
    'sha256',
    ua.computeSecret(asPublic),
    Buffer.from(SUBSCRIPTION.keys.auth, 'base64url'),
    Buffer.concat([
      Buffer.from('WebPush: info\0'),
      Buffer.from(SUBSCRIPTION.keys.p256dh, 'base64url'),
      asPublic,
    ]),
    32,
  ));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const out = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // The last byte is the padding delimiter, not part of the message.
  return JSON.parse(out.subarray(0, out.length - 1).toString());
}

test('webpush posts an encrypted body to the endpoint with the vapid header', async () => {
  const rec = recorder();
  await sendWebpush(
    SUBSCRIPTION,
    { title: 'Claudux (work)', body: 'waiting for you', clickUrl: 'https://claudux.example.com/#/session/x' },
    { fetchFn: rec.fetchFn, ...vapidOptions() },
  );
  const { url, init } = rec.calls[0];
  assert.equal(url, SUBSCRIPTION.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.ok(Number(init.headers.TTL) > 0);
  assert.match(init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.ok(Buffer.isBuffer(init.body));
  // The plaintext must not survive anywhere in the body.
  assert.equal(init.body.includes('waiting for you'), false);
  assert.equal(init.body.readUInt32BE(16), 4096);
});

test('webpush throws SubscriptionGoneError on 410 and on 404', async () => {
  for (const status of [410, 404]) {
    const rec = recorder({ ok: false, status, statusText: 'Gone' });
    await assert.rejects(
      () => sendWebpush(SUBSCRIPTION, { title: 't', body: 'b' }, { fetchFn: rec.fetchFn, ...vapidOptions() }),
      SubscriptionGoneError,
    );
  }
});

test('webpush throws a plain error on 502 - a temporary failure must not prune', async () => {
  const rec = recorder({ ok: false, status: 502, statusText: 'Bad Gateway' });
  await assert.rejects(
    () => sendWebpush(SUBSCRIPTION, { title: 't', body: 'b' }, { fetchFn: rec.fetchFn, ...vapidOptions() }),
    (err) => err instanceof Error && !(err instanceof SubscriptionGoneError),
  );
});

test('webpush throws a plain error on 403 - a wrong keypair is not a dead device', async () => {
  const rec = recorder({ ok: false, status: 403, statusText: 'Forbidden' });
  await assert.rejects(
    () => sendWebpush(SUBSCRIPTION, { title: 't', body: 'b' }, { fetchFn: rec.fetchFn, ...vapidOptions() }),
    (err) => err instanceof Error && !(err instanceof SubscriptionGoneError) && /keypair/.test(err.message),
  );
});

test('webpush never puts the endpoint into an error message', async () => {
  // Together with the keys the endpoint is the credential for pushing to
  // this device, and an error message ends up in the log.
  const rec = recorder({ ok: false, status: 410, statusText: 'Gone' });
  await assert.rejects(
    () => sendWebpush(SUBSCRIPTION, { title: 't', body: 'b' }, { fetchFn: rec.fetchFn, ...vapidOptions() }),
    (err) => !err.message.includes('/device/abc'),
  );
});

test('webpush carries title, body and click url inside the encrypted payload', async () => {
  const rec = recorder();
  await sendWebpush(
    SUBSCRIPTION,
    { title: 'T', body: 'B', clickUrl: 'https://claudux.example.com/#/session/abc' },
    { fetchFn: rec.fetchFn, ...vapidOptions() },
  );
  assert.deepEqual(decryptAsReceiver(rec.calls[0].init.body), {
    title: 'T',
    body: 'B',
    url: 'https://claudux.example.com/#/session/abc',
  });
});

test('webpush omits the url from the payload when there is no link', async () => {
  const rec = recorder();
  await sendWebpush(SUBSCRIPTION, { title: 'T', body: 'B' }, { fetchFn: rec.fetchFn, ...vapidOptions() });
  assert.deepEqual(decryptAsReceiver(rec.calls[0].init.body), { title: 'T', body: 'B' });
});
