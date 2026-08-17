import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { MAX_VIEW_BYTES } from '../src/lib/fileType.js';

// Creates a project and data directory, starts the server, and returns a
// fetch helper. The data directory lives INSIDE the project - just like in a
// checkout that is itself a registered project, where the token directory
// would otherwise be reachable.
function start() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-route-'));
  const projectPath = path.join(base, 'project');
  const dataDir = path.join(projectPath, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify([{ id: 'p1', name: 'Project', path: projectPath, favorite: false }]),
  );
  const config = {
    port: 0,
    claudeHome: path.join(base, 'claude'),
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    authEnabled: false,
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
  };
  const server = createApp(config).listen(0);
  const { port } = server.address();
  const url = (routePath) => `http://127.0.0.1:${port}${routePath}`;
  return { server, projectPath, dataDir, url };
}

function q(filePath) {
  return encodeURIComponent(filePath);
}

test('GET /api/files lists folders before files and hides .git and node_modules', async () => {
  const { server, projectPath, url } = start();
  fs.mkdirSync(path.join(projectPath, 'src'));
  fs.mkdirSync(path.join(projectPath, '.git'));
  fs.mkdirSync(path.join(projectPath, 'node_modules'));
  fs.writeFileSync(path.join(projectPath, 'README.md'), '# Hello\n');
  fs.writeFileSync(path.join(projectPath, '.env'), 'SECRET=1\n');

  try {
    const res = await fetch(url('/api/files?project=p1'));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.path, '');
    assert.equal(body.parent, null);
    const names = body.entries.map((e) => e.name);
    assert.deepEqual(names, ['data', 'src', '.env', 'README.md']);
    assert.equal(body.entries[0].type, 'folder');
    assert.equal(body.entries.find((e) => e.name === 'README.md').type, 'markdown');
  } finally {
    server.close();
  }
});

test('GET /api/files sets parent for a subdirectory', async () => {
  const { server, projectPath, url } = start();
  fs.mkdirSync(path.join(projectPath, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'src', 'lib', 'a.js'), 'const a = 1;\n');

  try {
    const res = await fetch(url(`/api/files?project=p1&path=${q('src/lib')}`));
    const body = await res.json();

    assert.equal(body.path, 'src/lib');
    assert.equal(body.parent, 'src');
    assert.deepEqual(body.entries.map((e) => e.name), ['a.js']);
  } finally {
    server.close();
  }
});

test('GET /api/files hides the token directory and denies access to it', async () => {
  const { server, projectPath, dataDir, url } = start();
  const tokenDir = path.join(dataDir, 'session-tokens');
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tokenDir, 'abc.token'), 'sk-ant-' + 'oat01-secret', { mode: 0o600 });
  fs.writeFileSync(path.join(projectPath, 'a.txt'), 'x');

  try {
    const list = await (await fetch(url(`/api/files?project=p1&path=${q('data')}`))).json();
    assert.ok(!list.entries.some((e) => e.name === 'session-tokens'));

    const raw = await fetch(url(`/api/files/raw?project=p1&path=${q('data/session-tokens/abc.token')}`));
    assert.equal(raw.status, 400);
    const view = await fetch(url(`/api/files/view?project=p1&path=${q('data/session-tokens/abc.token')}`));
    assert.equal(view.status, 400);
  } finally {
    server.close();
  }
});

// The account tokens are the payload a reader of the public repo would go
// after: the file lives outside the checkout, but a project rooted at one of
// its parents puts it inside a project root all the same.
test('GET /api/files hides the accounts file and denies access to it', async () => {
  const { server, dataDir, url } = start();
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), '{"accounts":[]}', { mode: 0o600 });

  try {
    const list = await (await fetch(url(`/api/files?project=p1&path=${q('data')}`))).json();
    assert.ok(!list.entries.some((e) => e.name === 'accounts.json'));

    const raw = await fetch(url(`/api/files/raw?project=p1&path=${q('data/accounts.json')}`));
    assert.equal(raw.status, 400);
    const view = await fetch(url(`/api/files/view?project=p1&path=${q('data/accounts.json')}`));
    assert.equal(view.status, 400);
  } finally {
    server.close();
  }
});

test('PUT /api/files refuses to overwrite the accounts file', async () => {
  const { server, dataDir, url } = start();
  const accountsPath = path.join(dataDir, 'accounts.json');
  fs.writeFileSync(accountsPath, '{"accounts":[]}', { mode: 0o600 });

  try {
    const res = await fetch(url(`/api/files?project=p1&path=${q('data/accounts.json')}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'overwritten', expectedModified: Date.now() }),
    });

    assert.equal(res.status, 400);
    assert.equal(fs.readFileSync(accountsPath, 'utf8'), '{"accounts":[]}');
  } finally {
    server.close();
  }
});

test('GET /api/files returns 404 for an unknown project ID', async () => {
  const { server, url } = start();
  try {
    const res = await fetch(url('/api/files?project=does-not-exist'));
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/files returns 400 on a path traversal attempt', async () => {
  const { server, url } = start();
  try {
    const res = await fetch(url(`/api/files?project=p1&path=${q('../../etc')}`));
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/files/view renders markdown and includes the source text', async () => {
  const { server, projectPath, url } = start();
  fs.writeFileSync(path.join(projectPath, 'README.md'), '# Title\n\n<script>alert(1)</script>\n');

  try {
    const res = await fetch(url(`/api/files/view?project=p1&path=${q('README.md')}`));
    const body = await res.json();

    assert.equal(body.type, 'markdown');
    assert.ok(body.html.includes('<h1 id="title">Title</h1>'));
    assert.ok(!body.html.includes('<script>'));
    assert.ok(body.raw.includes('<script>'));
    assert.equal(body.editable, true);
  } finally {
    server.close();
  }
});

test('GET /api/files/view highlights source text', async () => {
  const { server, projectPath, url } = start();
  fs.writeFileSync(path.join(projectPath, 'a.js'), 'const a = 1;\n');

  try {
    const body = await (await fetch(url(`/api/files/view?project=p1&path=${q('a.js')}`))).json();

    assert.equal(body.type, 'text');
    assert.ok(body.html.includes('hljs-keyword'));
    assert.ok(body.html.includes('code-line'));
  } finally {
    server.close();
  }
});

test('GET /api/files/view returns neither html nor raw for images', async () => {
  const { server, projectPath, url } = start();
  fs.writeFileSync(path.join(projectPath, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    const body = await (await fetch(url(`/api/files/view?project=p1&path=${q('image.png')}`))).json();

    assert.equal(body.type, 'image');
    assert.equal(body.html, null);
    assert.equal(body.raw, null);
    assert.equal(body.editable, false);
  } finally {
    server.close();
  }
});

test('GET /api/files/view does not render an oversized file', async () => {
  const { server, projectPath, url } = start();
  fs.writeFileSync(path.join(projectPath, 'large.txt'), 'x'.repeat(MAX_VIEW_BYTES + 10));

  try {
    const body = await (await fetch(url(`/api/files/view?project=p1&path=${q('large.txt')}`))).json();

    assert.equal(body.tooLarge, true);
    assert.equal(body.html, null);
    assert.equal(body.editable, false);
  } finally {
    server.close();
  }
});

test('GET /api/files/raw returns the bytes with matching Content-Type', async () => {
  const { server, projectPath, url } = start();
  fs.writeFileSync(path.join(projectPath, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(projectPath, 'a.txt'), 'hello');

  try {
    const image = await fetch(url(`/api/files/raw?project=p1&path=${q('image.png')}`));
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal((await image.arrayBuffer()).byteLength, 4);

    const text = await fetch(url(`/api/files/raw?project=p1&path=${q('a.txt')}`));
    assert.match(text.headers.get('content-type'), /text\/plain/);
    assert.equal(await text.text(), 'hello');
  } finally {
    server.close();
  }
});

test('GET /api/files/raw with download=1 sets Content-Disposition', async () => {
  const { server, projectPath, url } = start();
  fs.writeFileSync(path.join(projectPath, 'Example Ä.txt'), 'hello');

  try {
    const res = await fetch(url(`/api/files/raw?project=p1&path=${q('Example Ä.txt')}&download=1`));
    const disposition = res.headers.get('content-disposition');

    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename\*=UTF-8''Example%20%C3%84\.txt/);
    await res.arrayBuffer();
  } finally {
    server.close();
  }
});

test('PUT /api/files saves and returns the new modification time', async () => {
  const { server, projectPath, url } = start();
  const file = path.join(projectPath, 'TODO.md');
  fs.writeFileSync(file, 'old\n');
  const modifiedAt = Math.floor(fs.statSync(file).mtimeMs);

  try {
    const res = await fetch(url(`/api/files?project=p1&path=${q('TODO.md')}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'new\n', expectedModified: modifiedAt }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
    assert.equal(body.modified, Math.floor(fs.statSync(file).mtimeMs));
  } finally {
    server.close();
  }
});

test('PUT /api/files responds with 409 and the current content on mtime mismatch', async () => {
  const { server, projectPath, url } = start();
  const file = path.join(projectPath, 'TODO.md');
  fs.writeFileSync(file, 'changed externally in the meantime\n');
  const modifiedAt = Math.floor(fs.statSync(file).mtimeMs);

  try {
    const res = await fetch(url(`/api/files?project=p1&path=${q('TODO.md')}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'mine\n', expectedModified: modifiedAt - 5000 }),
    });
    const body = await res.json();

    assert.equal(res.status, 409);
    assert.equal(body.raw, 'changed externally in the meantime\n');
    assert.equal(body.modified, modifiedAt);
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed externally in the meantime\n');
  } finally {
    server.close();
  }
});

test('PUT /api/files rejects binary files and directories', async () => {
  const { server, projectPath, url } = start();
  fs.writeFileSync(path.join(projectPath, 'image.png'), Buffer.from([0x89, 0x50]));
  fs.mkdirSync(path.join(projectPath, 'folder'));

  try {
    for (const filePath of ['image.png', 'folder']) {
      const res = await fetch(url(`/api/files?project=p1&path=${q(filePath)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x', expectedModified: 1 }),
      });
      assert.equal(res.status, 400, filePath);
    }
  } finally {
    server.close();
  }
});

test('PUT /api/files accepts a body larger than express.json\'s default limit', async () => {
  const { server, projectPath, url } = start();
  const file = path.join(projectPath, 'large.txt');
  fs.writeFileSync(file, 'small\n');
  const modifiedAt = Math.floor(fs.statSync(file).mtimeMs);
  const content = 'z'.repeat(300 * 1024); // well above the default's 100 kB

  try {
    const res = await fetch(url(`/api/files?project=p1&path=${q('large.txt')}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, expectedModified: modifiedAt }),
    });

    assert.equal(res.status, 200);
    assert.equal(fs.statSync(file).size, content.length);
  } finally {
    server.close();
  }
});
