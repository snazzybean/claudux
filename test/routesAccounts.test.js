// The account routes: creating, patching and deleting, and the token
// validation that sits at this boundary and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { VALID_TOKEN, tmpConfig } from './helpers/routeHarness.js';

test('POST /api/accounts creates an account, GET returns {id, name, abbreviation} (never the token)', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const createRes = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: VALID_TOKEN, abbreviation: 'AR' }),
  });
  const createdBody = await createRes.text();
  assert.equal(createRes.status, 201);
  assert.ok(!createdBody.includes(VALID_TOKEN));

  const listRes = await fetch(`http://127.0.0.1:${port}/api/accounts`);
  const listed = await listRes.json();
  assert.equal(listed.accounts.length, 1);
  assert.equal(listed.accounts[0].name, 'work');
  assert.equal(listed.accounts[0].abbreviation, 'AR');
  assert.ok(listed.accounts[0].id);
  assert.ok(!JSON.stringify(listed).includes(VALID_TOKEN));
  server.close();
});

test('POST /api/accounts truncates an overlong abbreviation to 2 characters server-side', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: VALID_TOKEN, abbreviation: 'ARBITRARY' }),
  });

  const listRes = await fetch(`http://127.0.0.1:${port}/api/accounts`);
  const listed = await listRes.json();
  assert.equal(listed.accounts[0].abbreviation, 'AR');
  server.close();
});

test('PATCH /api/accounts/:id changes name and abbreviation', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: VALID_TOKEN }),
  });
  const [created] = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts;

  const patchRes = await fetch(`http://127.0.0.1:${port}/api/accounts/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Work', abbreviation: 'WK' }),
  });
  assert.equal(patchRes.status, 200);

  const listed = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(listed.accounts[0].name, 'Work');
  assert.equal(listed.accounts[0].abbreviation, 'WK');
  server.close();
});

test('PATCH /api/accounts/:id with an unknown id returns 404 instead of 500', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts/unknown-id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X' }),
  });

  assert.equal(res.status, 404);
  server.close();
});

test('POST /api/accounts rejects a token without the sk-ant-oat01 prefix with 400', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Exactly the shape of the real stored value: long enough to look
    // plausible, but without the prefix.
    body: JSON.stringify({ name: 'work', token: 'ujd5uv04ZOf6QAzxn3acjekJ6yGVwW122EeBZ30l4cWyR5vb' }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);
  // The account must not have been created.
  const listed = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.deepEqual(listed.accounts, []);
  server.close();
});

// Copy/pasting from the terminal practically always brings a trailing
// newline along. The TRAILING one is the dangerous case: the prefix check
// passes, the token counts as valid and gets saved broken - Claude Code
// then silently discards it. Exactly the bug the check is supposed to
// prevent.
test('POST /api/accounts trims whitespace around the token', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { getTokenById } = await import('../src/lib/accountStore.js');

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: `  ${VALID_TOKEN}\n` }),
  });
  const created = await res.json();

  assert.equal(res.status, 201);
  assert.equal(getTokenById(config.accountsSecretPath, created.id), VALID_TOKEN);
  server.close();
});

test('PATCH /api/accounts/:id trims whitespace around the token', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { getTokenById } = await import('../src/lib/accountStore.js');

  await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: VALID_TOKEN }),
  });
  const [created] = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts;

  const newToken = `sk-ant-oat01-${'C'.repeat(95)}`;
  await fetch(`http://127.0.0.1:${port}/api/accounts/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: `${newToken}\n` }),
  });

  assert.equal(getTokenById(config.accountsSecretPath, created.id), newToken);
  server.close();
});

// The version digit in the prefix isn't guaranteed. If the check pinned
// down exactly "oat01", a future "oat02" would run into a dead end:
// authorization successful, token valid, and Claudux of all things rejects
// it as a format error. Other CLI prefixes stay rejected.
test('POST /api/accounts also accepts a different oat version digit in the prefix', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: `sk-ant-oat02-${'D'.repeat(95)}` }),
  });

  assert.equal(res.status, 201);
  server.close();
});

test('POST /api/accounts rejects an admin/API key, even if it starts with sk-ant-', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: `sk-ant-admin01-${'E'.repeat(95)}` }),
  });

  assert.equal(res.status, 400);
  server.close();
});

test('PATCH /api/accounts/:id replaces the token', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { getTokenById } = await import('../src/lib/accountStore.js');

  await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: VALID_TOKEN }),
  });
  const [created] = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts;

  const newToken = `sk-ant-oat01-${'B'.repeat(95)}`;
  const patchRes = await fetch(`http://127.0.0.1:${port}/api/accounts/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: newToken }),
  });
  const patchBody = await patchRes.text();

  assert.equal(patchRes.status, 200);
  // The response must never mirror the token back.
  assert.ok(!patchBody.includes(newToken));
  assert.equal(getTokenById(config.accountsSecretPath, created.id), newToken);
  // The ID must stay stable - session-meta.json references it.
  const listed = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(listed.accounts[0].id, created.id);
  server.close();
});

test('PATCH /api/accounts/:id rejects a token without the sk-ant-oat01 prefix with 400', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const { getTokenById } = await import('../src/lib/accountStore.js');

  await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'work', token: VALID_TOKEN }),
  });
  const [created] = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts;

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'broken' }),
  });

  assert.equal(res.status, 400);
  // A rejected PATCH must not lose the existing, valid token - otherwise a
  // typo would render the account unusable.
  assert.equal(getTokenById(config.accountsSecretPath, created.id), VALID_TOKEN);
  server.close();
});

test('POST /api/accounts without name/token returns 400', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'without-token' }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);
  server.close();
});

// Regression test for `__proto__` as an account name: on save this hits
// the prototype setter instead of an own property and silently loses the
// token. A user must not get a seemingly successful 201 response for that,
// while the token ends up nowhere.
test('POST /api/accounts with name "__proto__" returns 400 instead of a false 201 with a lost token', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '__proto__', token: VALID_TOKEN }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);

  const listRes = await fetch(`http://127.0.0.1:${port}/api/accounts`);
  const listed = await listRes.json();
  assert.deepEqual(listed.accounts, []);
  server.close();
});

// On a parse error, express.json() attaches the RAW request body as
// `err.body` to the error object. The body of POST /api/accounts carries a
// token - a `console.error(err)` in the global error handler would write
// it to stderr in plain text on every broken JSON body. The spy checks
// that the token doesn't show up in ANY logged call.
test('POST /api/accounts with a broken JSON body does not log the token to stderr', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => {
    loggedCalls.push(args);
  };

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Deliberately truncated JSON - contains the token in plain text.
      body: '{"name":"work","token":"sk-LEAKME"',
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 400);
  const loggedText = JSON.stringify(loggedCalls);
  assert.ok(!loggedText.includes('sk-LEAKME'), `Token was logged: ${loggedText}`);
  server.close();
});

test('DELETE /api/accounts/:id removes the account', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Throwaway', token: 'sk-ant-' + 'oat01-throwawayvalue' }),
    });
    const { id } = await created.json();

    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);

    const list = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
    assert.deepEqual(list.accounts, []);
  } finally {
    server.close();
  }
});

test('DELETE /api/accounts/:id reports 404 for an unknown id', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/does-not-exist`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
