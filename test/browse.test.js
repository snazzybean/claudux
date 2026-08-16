import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

function tmpConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-data-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-claude-'));
  // realpathSync: os.tmpdir() is a symlink on macOS (/tmp -> /private/tmp),
  // and resolveWithinRoot in browse.js compares against the REAL path -
  // an unresolved browseRoot would reject its own root.
  const browseRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-browse-')));
  return {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    authEnabled: false,
    browseRoot,
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ...overrides,
  };
}

// The fixture resolves browseRoot itself; a real install may reach it through
// a symlink, so the root must be realpath-resolved before comparison.
test('GET /api/browse works when the browse root is reached through a symlink', async () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-real-')));
  fs.mkdirSync(path.join(real, 'sub'));
  const link = path.join(fs.realpathSync(os.tmpdir()), `claudux-link-${process.pid}`);
  fs.symlinkSync(real, link);

  const server = createApp(tmpConfig({ browseRoot: link })).listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/browse`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body.dirs, ['sub']);
  } finally {
    server.close();
    fs.unlinkSync(link);
  }
});

test('GET /api/browse without a path lists the configured browse root', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.path, config.browseRoot);
  assert.equal(body.parent, null);
  assert.ok(Array.isArray(body.dirs));
  server.close();
});

test('GET /api/browse?path=... outside the configured browse root returns 400', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent('/etc')}`);
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error, /Only paths under/);
  server.close();
});

test('GET /api/browse rejects a traversal attempt via <browseRoot>/..', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(path.join(config.browseRoot, '..'))}`);
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error, /Only paths under/);
  server.close();
});

test('GET /api/browse lists subfolders, hidden folders excluded, parent set', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const fixtureDir = fs.mkdtempSync(path.join(config.browseRoot, 'claudux-browse-test-'));
  fs.mkdirSync(path.join(fixtureDir, 'visible'));
  fs.mkdirSync(path.join(fixtureDir, '.hidden'));
  fs.writeFileSync(path.join(fixtureDir, 'file.txt'), 'no session, just a file');

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(fixtureDir)}`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.path, fixtureDir);
    assert.equal(body.parent, config.browseRoot);
    assert.deepEqual(body.dirs, ['visible']); // neither .hidden nor file.txt
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    server.close();
  }
});

test('GET /api/browse?path=... for a non-existent path returns 400', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(path.join(config.browseRoot, 'definitely-does-not-exist-xyz'))}`);
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);
  server.close();
});
