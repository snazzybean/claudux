import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createApp } from '../src/server.js';
import { uploadsRouter, cleanupUploads } from '../src/routes/uploads.js';

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

// 1x1 PNG (smallest valid PNG, transparent pixel) - good enough as a test
// payload, the endpoint only cares about bytes + content type, not about
// the image content.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('POST /api/uploads/image saves the image and returns its path', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: ONE_PX_PNG,
  });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.match(body.path, /^\/tmp\/claudux-uploads\/[0-9a-f-]+\.png$/);
  assert.ok(fs.existsSync(body.path));
  assert.deepEqual(fs.readFileSync(body.path), ONE_PX_PNG);
  fs.rmSync(body.path);
  server.close();
});

test('POST /api/uploads/image gives two uploads different file names', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const upload = () =>
    fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: ONE_PX_PNG,
    }).then((r) => r.json());

  const [first, second] = await Promise.all([upload(), upload()]);

  assert.notEqual(first.path, second.path);
  fs.rmSync(first.path);
  fs.rmSync(second.path);
  server.close();
});

test('POST /api/uploads/image rejects an unsupported content type', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'not an image',
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);
  server.close();
});

test('POST /api/uploads/image with an empty body returns 400 instead of creating an empty file', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: '',
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);
  server.close();
});

test('POST /api/uploads/image supports jpeg, gif and webp with the matching file extension', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  for (const [contentType, ext] of [
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: ONE_PX_PNG, // content is irrelevant to the endpoint, only the header counts
    });
    const body = await res.json();
    assert.equal(res.status, 201, `${contentType} should be accepted`);
    assert.ok(body.path.endsWith(`.${ext}`), `${contentType} should result in .${ext}, was ${body.path}`);
    fs.rmSync(body.path);
  }
  server.close();
});

test('cleanupUploads empties the directory but keeps it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-up-'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', 'b.png'), 'x');

  cleanupUploads(dir);

  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(fs.existsSync(dir));
});

test('cleanupUploads on a missing directory is a no-op', () => {
  assert.doesNotThrow(() => cleanupUploads(path.join(os.tmpdir(), 'claudux-not-there')));
});

// A world- or group-writable upload directory is somebody else's, and a
// screenshot is written into it in plain bytes.
test('POST /api/uploads/image refuses a directory others can write to', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-up-'));
  fs.chmodSync(dir, 0o777);
  const app = express();
  app.use('/api/uploads', uploadsRouter({ uploadDir: dir }));
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: ONE_PX_PNG,
    });

    assert.equal(res.status, 500);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    server.close();
  }
});

test('an uploaded file is readable by nobody else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-up-'));
  const app = express();
  app.use('/api/uploads', uploadsRouter({ uploadDir: dir }));
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: ONE_PX_PNG,
    });
    const { path: filePath } = await res.json();

    assert.equal(fs.statSync(filePath).mode & 0o077, 0);
  } finally {
    server.close();
  }
});

// On a platform without process.getuid() the ownership check must not reject
// every directory.
test('POST /api/uploads/image works where the platform has no uids', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-up-'));
  const realGetuid = process.getuid;
  delete process.getuid;
  const app = express();
  app.use('/api/uploads', uploadsRouter({ uploadDir: dir }));
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/uploads/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: ONE_PX_PNG,
    });

    assert.equal(res.status, 201);
  } finally {
    process.getuid = realGetuid;
    server.close();
  }
});
