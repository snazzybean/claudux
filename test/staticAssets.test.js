import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';
import { minifyStatic } from '../src/lib/staticAssets.js';

function tmpRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-static-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

// The middleware is mounted the way server.js mounts it, so the tests
// exercise the real interaction with express.static behind it rather than
// the handler in isolation.
async function withServer(root, run) {
  const app = express();
  app.use(minifyStatic(root));
  app.use(express.static(root));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(server.address().port);
  } finally {
    server.close();
  }
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const COMMENTED_JS = `// a comment that gzip cannot remove entirely
export function greet(name) {
  // another comment
  const greeting = 'hello ' + name;
  return greeting;
}
`;

test('minifies a javascript file and keeps it valid', async () => {
  const root = tmpRoot({ 'app.js': COMMENTED_JS });
  await withServer(root, async (port) => {
    const res = await get(port, '/app.js');
    assert.equal(res.status, 200);
    const body = res.body.toString();
    assert.ok(body.length < COMMENTED_JS.length, `expected shrink, got ${body.length}`);
    assert.ok(!body.includes('a comment'), 'comments should be gone');
    assert.ok(body.includes('greet'), 'the exported name must survive');
    assert.match(res.headers['content-type'], /javascript/);
  });
});

test('minifies a stylesheet', async () => {
  const css = `/* a comment */\n.a {\n  color: red;\n  padding: 10px;\n}\n`;
  const root = tmpRoot({ 'styles.css': css });
  await withServer(root, async (port) => {
    const res = await get(port, '/styles.css');
    assert.equal(res.status, 200);
    const body = res.body.toString();
    assert.ok(body.length < css.length);
    assert.ok(body.includes('red'));
    assert.match(res.headers['content-type'], /css/);
  });
});

// The whole point of the fallback: a file the minifier chokes on must still
// reach the browser unchanged. Serving nothing, or serving a truncated
// result, would take the interface down for a syntax error in one module.
test('falls back to the original bytes when minification fails', async () => {
  const broken = 'function ( { this is not javascript\n';
  const root = tmpRoot({ 'broken.js': broken });
  await withServer(root, async (port) => {
    const res = await get(port, '/broken.js');
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), broken);
  });
});

// public/ is deployed by editing files in place - a cached minified body
// that outlives its source would serve yesterday's interface until restart.
test('picks up a changed file instead of serving a stale cache', async () => {
  const root = tmpRoot({ 'app.js': 'export const version = 1;\n' });
  await withServer(root, async (port) => {
    const first = await get(port, '/app.js');
    assert.ok(first.body.toString().includes('1'));

    // A future mtime rather than a real wait: the cache key has to notice
    // the change, and the test must not depend on filesystem timestamp
    // resolution.
    const target = path.join(root, 'app.js');
    fs.writeFileSync(target, 'export const version = 2;\n');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(target, future, future);

    const second = await get(port, '/app.js');
    assert.ok(second.body.toString().includes('2'), 'must serve the new content');
  });
});

test('answers a conditional request with 304 so warm loads stay free', async () => {
  const root = tmpRoot({ 'app.js': COMMENTED_JS });
  await withServer(root, async (port) => {
    const first = await get(port, '/app.js');
    const etag = first.headers.etag;
    assert.ok(etag, 'a minified response needs its own etag');

    const second = await get(port, '/app.js', { 'If-None-Match': etag });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
  });
});

test('leaves files it does not handle to express.static', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const root = tmpRoot({ 'icon.png': png });
  await withServer(root, async (port) => {
    const res = await get(port, '/icon.png');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, png);
  });
});

// Without an explicit containment check the middleware would happily read
// and serve any .js file on the host - it resolves the path itself instead
// of going through express.static's own guard.
test('refuses to read outside the public directory', async () => {
  const root = tmpRoot({ 'app.js': 'export const ok = 1;\n' });
  const secret = path.join(path.dirname(root), 'outside-secret.js');
  fs.writeFileSync(secret, 'export const secret = "must not leak";\n');
  await withServer(root, async (port) => {
    const res = await get(port, `/../${path.basename(secret)}`);
    assert.notEqual(res.status, 200);
  });
});

// The comments in index.html explain the interface to whoever maintains it,
// not to whoever visits it. They stay in the file and come off on the way
// out.
test('strips comments from html', async () => {
  const html = '<!doctype html><html><!-- why the body is like this --><body>hi</body></html>';
  const root = tmpRoot({ 'index.html': html });
  await withServer(root, async (port) => {
    const res = await get(port, '/index.html');
    const body = res.body.toString();
    assert.ok(!body.includes('<!--'), 'no comment may survive');
    assert.ok(body.includes('<body>hi</body>'), 'the markup itself stays');
  });
});

// The interface is opened at "/", so a rule that only matches *.html would
// leave the one file this is about untouched.
test('strips comments when index.html is served for a directory', async () => {
  const html = '<!doctype html><html><!-- secret rationale --><body>hi</body></html>';
  const root = tmpRoot({ 'index.html': html });
  await withServer(root, async (port) => {
    const res = await get(port, '/');
    assert.equal(res.status, 200);
    assert.ok(!res.body.toString().includes('secret rationale'));
  });
});

// A comment marker inside a script is script content, not a comment. Cutting
// from there to the next "-->" would silently delete live code.
test('leaves comment markers inside a script alone', async () => {
  const html = `<html><script>const s = "<!-- not a comment -->"; const keep = 1;</script><!-- real --></html>`;
  const root = tmpRoot({ 'index.html': html });
  await withServer(root, async (port) => {
    const body = (await get(port, '/index.html')).body.toString();
    assert.ok(body.includes('const keep = 1'), 'code after the marker must survive');
    assert.ok(body.includes('<!-- not a comment -->'), 'the string content stays as written');
    assert.ok(!body.includes('<!-- real -->'), 'the real comment is gone');
  });
});

test('compresses a minified response when the client accepts gzip', async () => {
  const root = tmpRoot({ 'app.js': COMMENTED_JS.repeat(50) });
  const app = express();
  const compression = (await import('compression')).default;
  app.use(compression());
  app.use(minifyStatic(root));
  app.use(express.static(root));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const res = await get(port, '/app.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip');
    const inflated = zlib.gunzipSync(res.body).toString();
    assert.ok(inflated.includes('greet'));
  } finally {
    server.close();
  }
});
