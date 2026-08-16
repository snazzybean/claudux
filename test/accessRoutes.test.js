import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { accessPublicRouter, accessProtectedRouter } from '../src/routes/access.js';
import { createAccessGate } from '../src/lib/accessGate.js';
import { isConfigured, setPassword, getSessionTtlDays, setSessionTtlDays } from '../src/lib/accessStore.js';

// The same order server.js uses: setup and login in front of the gate,
// everything that presupposes a session behind it.
async function startApp(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-accessroutes-'));
  const config = { authEnabled: true, accessSecretPath: path.join(dir, 'access.json'), ...overrides };
  const app = express();
  app.use(express.json());
  app.use('/access', accessPublicRouter(config));
  app.use(createAccessGate(config));
  app.use('/access', accessProtectedRouter(config));
  const server = app.listen(0, '127.0.0.1');
  // With a host given, the port is only assigned once the socket is up -
  // reading address() straight after listen() returns null here.
  await new Promise((resolve) => server.once('listening', resolve));
  return { config, server, base: `http://127.0.0.1:${server.address().port}` };
}

function post(base, route, body, headers = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

test('the first request sets the password, gets a session, and cannot be repeated', async () => {
  const { base, config, server } = await startApp();
  try {
    const res = await post(base, '/access/setup', { password: 'first-password' });
    assert.equal(res.status, 200);
    const raw = res.headers.get('set-cookie');
    assert.match(raw, /^claudux_session=/);
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    assert.match(raw, /Path=\//i);
    assert.equal(isConfigured(config.accessSecretPath), true);
    // A second setup would be a way to take over an installation.
    const again = await post(base, '/access/setup', { password: 'second-password' });
    assert.equal(again.status, 409);
  } finally {
    server.close();
  }
});

test('a password under eight characters is refused', async () => {
  const { base, config, server } = await startApp();
  try {
    const res = await post(base, '/access/setup', { password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(isConfigured(config.accessSecretPath), false);
  } finally {
    server.close();
  }
});

test('the state route says whether a password exists and nothing else', async () => {
  const { base, config, server } = await startApp();
  try {
    const before = await (await fetch(`${base}/access/state`)).json();
    assert.deepEqual(before, { configured: false });
    setPassword(config.accessSecretPath, 'set-from-the-side');
    const after = await (await fetch(`${base}/access/state`)).json();
    assert.deepEqual(after, { configured: true });
  } finally {
    server.close();
  }
});

test('login accepts the right password and refuses the wrong one without a cookie', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    const good = await post(base, '/access/login', { password: 'the-password' });
    assert.equal(good.status, 200);
    assert.match(good.headers.get('set-cookie'), /^claudux_session=/);

    const bad = await post(base, '/access/login', { password: 'the-passworb' });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);
  } finally {
    server.close();
  }
});

// A Secure cookie over http is accepted by the browser and never sent back,
// which shows up as a login loop rather than as an error.
test('Secure is set behind an https proxy and left off over plain http', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    const plain = await post(base, '/access/login', { password: 'the-password' });
    assert.equal(/Secure/i.test(plain.headers.get('set-cookie')), false);

    const proxied = await post(base, '/access/login', { password: 'the-password' }, {
      'x-forwarded-proto': 'https',
    });
    assert.match(proxied.headers.get('set-cookie'), /Secure/i);
  } finally {
    server.close();
  }
});

test('the cookie lifetime follows the setting, and a session that never expires gets 400 days', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    setSessionTtlDays(config.accessSecretPath, 7);
    const week = await post(base, '/access/login', { password: 'the-password' });
    assert.match(week.headers.get('set-cookie'), /Max-Age=604800/i);

    setSessionTtlDays(config.accessSecretPath, null);
    const forever = await post(base, '/access/login', { password: 'the-password' });
    // Chrome and Edge cap any longer value at 400 days regardless.
    assert.match(forever.headers.get('set-cookie'), /Max-Age=34560000/i);
  } finally {
    server.close();
  }
});

test('logout ends this session and leaves the other device alone', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    const one = cookieFrom(await post(base, '/access/login', { password: 'the-password' }));
    const two = cookieFrom(await post(base, '/access/login', { password: 'the-password' }));

    const out = await post(base, '/access/logout', {}, { cookie: one });
    assert.equal(out.status, 200);
    assert.equal((await fetch(`${base}/anything`, { headers: { cookie: one } })).status, 401);
    assert.equal((await fetch(`${base}/anything`, { headers: { cookie: two } })).status, 404);
  } finally {
    server.close();
  }
});

test('logout-all ends every session', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    const one = cookieFrom(await post(base, '/access/login', { password: 'the-password' }));
    const two = cookieFrom(await post(base, '/access/login', { password: 'the-password' }));

    assert.equal((await post(base, '/access/logout-all', {}, { cookie: one })).status, 200);
    assert.equal((await fetch(`${base}/anything`, { headers: { cookie: one } })).status, 401);
    assert.equal((await fetch(`${base}/anything`, { headers: { cookie: two } })).status, 401);
  } finally {
    server.close();
  }
});

test('changing the password needs the current one and logs every device out', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    const mine = cookieFrom(await post(base, '/access/login', { password: 'the-password' }));
    const other = cookieFrom(await post(base, '/access/login', { password: 'the-password' }));

    const wrong = await post(base, '/access/password', {
      current: 'not-the-password', next: 'a-new-password',
    }, { cookie: mine });
    assert.equal(wrong.status, 401);

    const tooShort = await post(base, '/access/password', {
      current: 'the-password', next: 'short',
    }, { cookie: mine });
    assert.equal(tooShort.status, 400);

    const ok = await post(base, '/access/password', {
      current: 'the-password', next: 'a-new-password',
    }, { cookie: mine });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${base}/anything`, { headers: { cookie: mine } })).status, 401);
    assert.equal((await fetch(`${base}/anything`, { headers: { cookie: other } })).status, 401);
    assert.equal((await post(base, '/access/login', { password: 'a-new-password' })).status, 200);
  } finally {
    server.close();
  }
});

test('the session lifetime can be read and set, and unknown values are refused', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    const cookie = cookieFrom(await post(base, '/access/login', { password: 'the-password' }));

    const read = await (await fetch(`${base}/access/session-ttl`, { headers: { cookie } })).json();
    assert.deepEqual(read, { days: 30 });

    const put = (body) => fetch(`${base}/access/session-ttl`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    assert.equal((await put({ days: 180 })).status, 200);
    assert.equal(getSessionTtlDays(config.accessSecretPath), 180);
    assert.equal((await put({ days: null })).status, 200);
    assert.equal(getSessionTtlDays(config.accessSecretPath), null);
    assert.equal((await put({ days: 3 })).status, 400);
    assert.equal((await put({ days: '30' })).status, 400);
    assert.equal(getSessionTtlDays(config.accessSecretPath), null);
  } finally {
    server.close();
  }
});

// Without the gate in between, the password change would be reachable by
// anyone who can send a request.
test('the managing routes are unreachable without a session', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    assert.equal((await post(base, '/access/logout')).status, 401);
    assert.equal((await post(base, '/access/logout-all')).status, 401);
    assert.equal((await post(base, '/access/password', {
      current: 'the-password', next: 'a-new-password',
    })).status, 401);
    assert.equal((await fetch(`${base}/access/session-ttl`)).status, 401);
  } finally {
    server.close();
  }
});

// The throttle must not make an honest login wait, and it has to make a
// guessing run wait.
test('the wait grows only after several wrong passwords', async () => {
  const { base, config, server } = await startApp();
  try {
    setPassword(config.accessSecretPath, 'the-password');
    for (let i = 0; i < 4; i++) {
      const res = await post(base, '/access/login', { password: 'wrong' });
      assert.equal(res.status, 401);
    }
    const started = Date.now();
    await post(base, '/access/login', { password: 'wrong' });
    await post(base, '/access/login', { password: 'wrong' });
    assert.ok(Date.now() - started >= 1000, 'the sixth attempt has to be held back');
  } finally {
    server.close();
  }
});
