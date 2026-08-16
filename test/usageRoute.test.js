// The route is tested with stubbed dependencies: no tmux, no network. A
// real fetch would burn quota, and the suite runs before every commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { usageRouter } from '../src/routes/usage.js';
import { setMeta } from '../src/lib/sessionMeta.js';

function buildEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-usage-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-home-'));
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));
  return { dataDir, claudeHome, accountsSecretPath: path.join(dataDir, 'accounts.json') };
}

function writeTranscript(claudeHome, sessionId, tokens) {
  const dir = path.join(claudeHome, 'projects', '-srv-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: tokens } } })}\n`,
  );
}

async function ask(config, deps, routePath) {
  const app = express();
  app.use('/api', usageRouter(config, deps));
  // Without our own error handler Express responds with an HTML page, and
  // the test fails on "Unexpected token '<'" instead of on the actual
  // error.
  app.use((err, req, res, _next) => res.status(500).json({ error: err.stack }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api${routePath}`);
  const body = await res.json();
  // closeAllConnections in addition to close(): fetch keeps the connection
  // alive via keep-alive, and node:test waits for open handles - without
  // this the suite runs into the timeout instead of completing.
  server.closeAllConnections();
  server.close();
  return { status: res.status, body };
}

const LIMITS = {
  fiveHour: { percent: 8, resetsAt: 1786198200, status: 'allowed' },
  sevenDay: { percent: 71, resetsAt: 1786262400, status: 'allowed' },
};

test('returns the session\'s context and limits', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 160384);
  const { status, body } = await ask(config, {
    activeAccounts: async () => new Map([['sess-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => LIMITS,
    nowSec: () => 1786180000,
  }, '/sessions/sess-1/usage');

  assert.equal(status, 200);
  assert.equal(body.accountId, 'id-1');
  assert.equal(body.context.tokens, 160384);
  assert.equal(Math.round(body.context.percent * 10) / 10, 16.0);
  assert.equal(body.limits.fiveHour.percent, 8);
  assert.equal(body.limits.sevenDay.percent, 71);
});

// The color is decided in the backend, not the browser: it lives in a
// projection that belongs under test, and the frontend has no test harness
// here.
test('returns a color tier for every value', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 160384);
  const { body } = await ask(config, {
    activeAccounts: async () => new Map([['sess-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => LIMITS,
    nowSec: () => 1786180000,
  }, '/sessions/sess-1/usage');

  assert.equal(body.context.level, 'ok'); // 16% context
  assert.equal(body.limits.fiveHour.level, 'dim'); // below 10%
  assert.ok(['ok', 'warn', 'crit'].includes(body.limits.sevenDay.level));
});

// The model name comes from the transcript, not from settings.json: this
// test's environment carries "opus[1m]" there, but the session runs
// "claude-opus-5". That's exactly how the two sources diverge in
// production once a session was started or switched with a different
// model.
test('names the session\'s model from the transcript', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 160384);
  const { body } = await ask(config, {
    activeAccounts: async () => new Map([['sess-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => LIMITS,
  }, '/sessions/sess-1/usage');
  assert.equal(body.context.model, 'claude-opus-5');
});

// The projection reports exhaustedAt as an absolute time, not just a color
// tier.
test('names the expected exhaustion time when the pace runs into the limit', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 1000);
  const reset = 1786198200;
  const now = reset - 18000 / 2; // half of the 5-hour window has elapsed
  const { body } = await ask(config, {
    activeAccounts: async () => new Map([['sess-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => ({
      fiveHour: { percent: 60, resetsAt: reset, status: 'allowed' },
      sevenDay: { percent: 5, resetsAt: 1786262400, status: 'allowed' },
    }),
    nowSec: () => now,
  }, '/sessions/sess-1/usage');

  assert.equal(body.limits.fiveHour.exhaustedAt, now + 6000);
  // 5% in the 7-day window is too little for a projection.
  assert.equal(body.limits.sevenDay.exhaustedAt, null);
});

// The account comes from /proc, not from session-meta.json - the stored
// assignment can diverge from reality (see activeAccount.js). Stored and
// active ids differ here, so a body that reported the stored one would
// give this test away.
test('prefers the actually running account over the stored assignment', async () => {
  const config = buildEnv();
  setMeta(config.dataDir, 'sess-1', { accountId: 'id-2', projectId: 'p1' });
  writeTranscript(config.claudeHome, 'sess-1', 1000);
  const { body } = await ask(config, {
    activeAccounts: async () => new Map([['sess-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => LIMITS,
  }, '/sessions/sess-1/usage');
  assert.equal(body.accountId, 'id-1');
});

test('falls back to the stored assignment when the session isn\'t running', async () => {
  const config = buildEnv();
  setMeta(config.dataDir, 'sess-1', { accountId: 'id-2', projectId: 'p1' });
  writeTranscript(config.claudeHome, 'sess-1', 1000);
  const { body } = await ask(config, {
    activeAccounts: async () => new Map(),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => LIMITS,
  }, '/sessions/sess-1/usage');
  assert.equal(body.accountId, 'id-2');
});

// After a /clear the current conversation is under a different ID (see
// claude-switch in routes/sessions.js).
test('finds the context even after a /clear', async () => {
  const config = buildEnv();
  setMeta(config.dataDir, 'tmux-1', { accountId: 'id-1', projectId: 'p1' });
  setMeta(config.dataDir, 'after-clear', { accountId: 'id-1', projectId: 'p1', tmuxSession: 'tmux-1' });
  writeTranscript(config.claudeHome, 'tmux-1', 500000);
  writeTranscript(config.claudeHome, 'after-clear', 30000);
  // The conversation after the /clear is the newer one.
  const dir = path.join(config.claudeHome, 'projects', '-srv-project');
  fs.utimesSync(path.join(dir, 'tmux-1.jsonl'), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(dir, 'after-clear.jsonl'), new Date(9000), new Date(9000));

  const { body } = await ask(config, {
    activeAccounts: async () => new Map([['tmux-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => LIMITS,
  }, '/sessions/tmux-1/usage');
  assert.equal(body.context.tokens, 30000);
});

// Without an account there's no quota, but there is very much a context
// state - an empty response would be needlessly unhelpful here.
test('returns the context even without a resolvable account', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 12345);
  const { body } = await ask(config, {
    activeAccounts: async () => new Map(),
    tokenFor: () => null,
    fetchLimitsDep: async () => LIMITS,
  }, '/sessions/sess-1/usage');
  assert.equal(body.context.tokens, 12345);
  assert.equal(body.limits, null);
  assert.equal(body.accountId, null);
});

test('reports a failed fetch without losing the context', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 12345);
  const { status, body } = await ask(config, {
    activeAccounts: async () => new Map([['sess-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => {
      const err = new Error('Quota not retrievable (HTTP 403)');
      err.status = 403;
      throw err;
    },
  }, '/sessions/sess-1/usage');
  assert.equal(status, 200);
  assert.equal(body.context.tokens, 12345);
  assert.equal(body.limits, null);
  assert.match(body.error, /403/);
});

// A filename is built from the session ID - the same check as everywhere
// else in the project.
test('rejects implausible session IDs', async () => {
  const config = buildEnv();
  const { status } = await ask(config, {
    activeAccounts: async () => new Map(),
    tokenFor: () => null,
    fetchLimitsDep: async () => LIMITS,
  }, '/sessions/..%2F..%2Fetc/usage');
  assert.equal(status, 400);
});

// Two sessions of the same account share one fetch: the quota belongs to
// the subscription, not the session.
test('queries only once for two sessions of the same account', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 1000);
  writeTranscript(config.claudeHome, 'sess-2', 2000);
  let calls = 0;
  const deps = {
    activeAccounts: async () => new Map([
      ['sess-1', { accountId: 'id-1', hasToken: true }],
      ['sess-2', { accountId: 'id-1', hasToken: true }],
    ]),
    tokenFor: () => 'secret',
    fetchLimitsDep: async () => {
      calls += 1;
      return LIMITS;
    },
  };
  const app = express();
  app.use('/api', usageRouter(config, deps));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await fetch(`http://127.0.0.1:${port}/api/sessions/sess-1/usage`);
  await fetch(`http://127.0.0.1:${port}/api/sessions/sess-2/usage`);
  // closeAllConnections: see ask() above.
  server.closeAllConnections();
  server.close();
  assert.equal(calls, 1);
});

test('the usage response carries the accountId, not a name', async () => {
  const config = buildEnv();
  writeTranscript(config.claudeHome, 'sess-1', 1000);
  setMeta(config.dataDir, 'sess-1', { accountId: 'id-1', projectId: 'proj-1' });

  const { body } = await ask(config, {
    activeAccounts: async () => new Map([['sess-1', { accountId: 'id-1', hasToken: true }]]),
    tokenFor: (id) => (id === 'id-1' ? 'secret' : null),
    fetchLimitsDep: async () => LIMITS,
  }, '/sessions/sess-1/usage');

  assert.equal(body.accountId, 'id-1');
  assert.ok(!('account' in body));
});
