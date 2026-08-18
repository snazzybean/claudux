import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

function tmpConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-data-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-claude-'));
  return {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    authEnabled: false,
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    ...overrides,
  };
}

test('GET /api/browse works when the start directory is reached through a symlink', async () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-real-')));
  fs.mkdirSync(path.join(real, 'sub'));
  const link = path.join(fs.realpathSync(os.tmpdir()), `claudux-link-${process.pid}`);
  fs.symlinkSync(real, link);

  const server = createApp(tmpConfig(), { browseStartDirFn: () => link }).listen(0);
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

test('GET /api/browse without a path lists the home directory by default', async () => {
  const server = createApp(tmpConfig()).listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse`);
  const body = await res.json();
  const realHome = fs.realpathSync(os.homedir());

  assert.equal(res.status, 200);
  assert.equal(body.path, realHome);
  assert.equal(body.parent, path.dirname(realHome));
  assert.ok(Array.isArray(body.dirs));
  server.close();
});

test('GET /api/browse navigates above the folder it started in', async () => {
  // What the old fixed root rejected with 400: a step above where the
  // browser started. There is no boundary left to hit.
  const start = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-browse-')));
  const server = createApp(tmpConfig(), { browseStartDirFn: () => start }).listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(path.join(start, '..'))}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.path, path.dirname(start));
  server.close();
});

test('GET /api/browse at the filesystem root has no parent', async () => {
  const server = createApp(tmpConfig()).listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=/`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.path, '/');
  assert.equal(body.parent, null);
  server.close();
});

test('GET /api/browse lists subfolders, hidden folders excluded, parent set', async () => {
  const start = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-browse-')));
  const server = createApp(tmpConfig(), { browseStartDirFn: () => start }).listen(0);
  const { port } = server.address();

  const fixtureDir = fs.mkdtempSync(path.join(start, 'claudux-browse-test-'));
  fs.mkdirSync(path.join(fixtureDir, 'visible'));
  fs.mkdirSync(path.join(fixtureDir, '.hidden'));
  fs.writeFileSync(path.join(fixtureDir, 'file.txt'), 'no session, just a file');

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(fixtureDir)}`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.path, fixtureDir);
    assert.equal(body.parent, start);
    assert.deepEqual(body.dirs, ['visible']); // neither .hidden nor file.txt
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    server.close();
  }
});

test('GET /api/browse?path=... for a non-existent path returns 400', async () => {
  const start = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-browse-')));
  const server = createApp(tmpConfig(), { browseStartDirFn: () => start }).listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(path.join(start, 'definitely-does-not-exist-xyz'))}`);
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);
  server.close();
});
