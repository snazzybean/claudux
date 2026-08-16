// The project list and its per-project settings: creating, removing,
// favouriting, and the PATCH route that carries the default account and the
// notify level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { loadProjects } from '../src/lib/projectStore.js';
import { setMeta } from '../src/lib/sessionMeta.js';
import { tmpConfig, startApp, tmpProject, patchJson } from './helpers/routeHarness.js';

test('GET /favicon.ico returns 200 instead of the usual browser 404', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  server.close();
});

test('GET /api/projects returns an empty list without any prior addProject calls', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.projects, []);
  server.close();
});

test('POST /api/projects creates a project, GET then lists it', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Notes', projectPath: path.join(config.dataDir, 'notes') }),
  });
  const created = await createRes.json();
  assert.equal(createRes.status, 201);
  assert.equal(created.name, 'Notes');

  const listRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
  const listed = await listRes.json();
  assert.equal(listed.projects.length, 1);
  server.close();
});

test('POST /api/projects without name/projectPath returns 400', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'NoProjectPath' }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.ok(body.error);
  server.close();
});

// Truthy alone was not enough: an object reached fs.mkdirSync and came back
// as a 500 carrying raw Node text.
test('POST /api/projects rejects a non-string name or projectPath with 400', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  for (const body of [
    { name: 'P', projectPath: { toString: 'nope' } },
    { name: 'P', projectPath: ['/tmp'] },
    { name: { }, projectPath: '/tmp' },
    { name: 'P', projectPath: '   ' },
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `${JSON.stringify(body)} should be refused`);
  }
  server.close();
});

// tmux format-expands the value of `new-session -c`, so a `#(…)` in a
// project path runs a shell command as the service user. A relative path is
// refused for a second reason: mkdirSync would create it relative to the
// service's working directory.
test('POST /api/projects rejects a relative path and one containing #', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const marker = path.join(config.dataDir, 'expanded');
  try {
    for (const projectPath of [
      'relative/notes',
      `/tmp/#(touch ${marker})`,
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'P', projectPath }),
      });
      assert.equal(res.status, 400, `${projectPath} should be refused`);
    }
    assert.equal(fs.existsSync(path.join(process.cwd(), 'relative')), false);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()).projects, []);
  } finally {
    server.close();
  }
});

test('POST /api/projects/:id/favorite with an unknown id returns 404 instead of 500', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/projects/unknown-id/favorite`, {
    method: 'POST',
  });

  assert.equal(res.status, 404);
  server.close();
});

test('POST /api/projects/:id/favorite toggles favorite', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();

  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fav', projectPath: path.join(config.dataDir, 'fav') }),
  });
  const created = await createRes.json();

  const favRes = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}/favorite`, {
    method: 'POST',
  });
  assert.equal(favRes.status, 204);

  const listRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
  const listed = await listRes.json();
  assert.equal(listed.projects[0].favorite, true);
  server.close();
});

test('DELETE /api/projects/:id with an unknown id returns 404 instead of 500', async () => {
  const app = createApp(tmpConfig());
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/projects/unknown-id`, {
    method: 'DELETE',
  });

  assert.equal(res.status, 404);
  server.close();
});

test('DELETE /api/projects/:id removes the project from the list, doesn\'t touch the real folder', async () => {
  const config = tmpConfig();
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const projectPath = path.join(config.dataDir, 'removeme');

  const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RemoveMe', projectPath }),
  });
  const created = await createRes.json();

  const delRes = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
    method: 'DELETE',
  });
  assert.equal(delRes.status, 204);

  const listRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
  const listed = await listRes.json();
  assert.deepEqual(listed.projects, []);
  assert.ok(fs.existsSync(projectPath), 'the real project folder must not be deleted');
  server.close();
});

test('PATCH /api/projects/:id with an unknown id returns 404 instead of 500', async () => {
  const server = createApp(tmpConfig()).listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/unknown-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAccountId: 'id-work' }),
    });

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Project not found' });
  } finally {
    server.close();
  }
});

test('PATCH /api/projects/:id with an empty body returns 400', async () => {
  const config = tmpConfig();
  const server = createApp(config).listen(0);
  const { port } = server.address();

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Std', projectPath: path.join(config.dataDir, 'std') }),
    });
    const created = await createRes.json();

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /api/projects/:id with a wrongly typed defaultAccountId returns 400', async () => {
  const config = tmpConfig();
  const server = createApp(config).listen(0);
  const { port } = server.address();

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Std', projectPath: path.join(config.dataDir, 'std2') }),
    });
    const created = await createRes.json();

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAccountId: 42 }),
    });

    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /api/projects/:id sets the default, GET then includes it', async () => {
  const config = tmpConfig();
  const server = createApp(config).listen(0);
  const { port } = server.address();

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Std', projectPath: path.join(config.dataDir, 'std3') }),
    });
    const created = await createRes.json();

    const patchRes = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAccountId: 'id-work' }),
    });
    assert.equal(patchRes.status, 204);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const listed = await listRes.json();
    assert.equal(listed.projects[0].defaultAccountId, 'id-work');
  } finally {
    server.close();
  }
});

test('PATCH /api/projects/:id with null clears the default', async () => {
  const config = tmpConfig();
  const server = createApp(config).listen(0);
  const { port } = server.address();

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Std', projectPath: path.join(config.dataDir, 'std4') }),
    });
    const created = await createRes.json();

    await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAccountId: 'id-work' }),
    });
    const delRes = await fetch(`http://127.0.0.1:${port}/api/projects/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAccountId: null }),
    });
    assert.equal(delRes.status, 204);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const listed = await listRes.json();
    assert.equal(listed.projects[0].defaultAccountId, undefined);
  } finally {
    server.close();
  }
});

test('the project default is stored as an id', async () => {
  const config = tmpConfig();
  const project = tmpProject(config);
  const { port, close } = startApp(config);

  const missing = await patchJson(port, `/api/projects/${project.id}`, {});
  assert.equal(missing.status, 400);

  const res = await patchJson(port, `/api/projects/${project.id}`, { defaultAccountId: 'id-1' });
  assert.equal(res.status, 204);
  assert.equal(
    loadProjects(path.join(config.dataDir, 'projects.json'))[0].defaultAccountId,
    'id-1',
  );
  close();
});

test('PATCH /api/projects/:id changes only what it was given', async () => {
  const config = tmpConfig();
  const project = tmpProject(config);
  const { port, close } = startApp(config);
  const projectsPath = path.join(config.dataDir, 'projects.json');

  assert.equal((await patchJson(port, `/api/projects/${project.id}`, { defaultAccountId: 'id-1' })).status, 204);
  assert.equal((await patchJson(port, `/api/projects/${project.id}`, { notify: 'blocking' })).status, 204);

  const stored = loadProjects(projectsPath)[0];
  assert.equal(stored.notify, 'blocking');
  // The point of the partial patch: the field that was not sent survives.
  assert.equal(stored.defaultAccountId, 'id-1');

  assert.equal((await patchJson(port, `/api/projects/${project.id}`, { defaultAccountId: null })).status, 204);
  assert.equal(loadProjects(projectsPath)[0].notify, 'blocking');
  close();
});

test('PATCH /api/projects/:id refuses an unknown notify level and writes nothing', async () => {
  const config = tmpConfig();
  const project = tmpProject(config);
  const { port, close } = startApp(config);
  const projectsPath = path.join(config.dataDir, 'projects.json');

  await patchJson(port, `/api/projects/${project.id}`, { notify: 'none' });
  // Both fields in one call, one of them broken: the check runs before any
  // write, so a rejected call must not leave the other half applied.
  const res = await patchJson(port, `/api/projects/${project.id}`, { notify: 'quiet', defaultAccountId: 'id-9' });
  assert.equal(res.status, 400);

  const stored = loadProjects(projectsPath)[0];
  assert.equal(stored.notify, 'none');
  assert.equal(stored.defaultAccountId, undefined);
  close();
});

test('PATCH /api/projects/:id with notify all drops the field again', async () => {
  // The path the UI takes when a project is set back to the default. The
  // store deletes the field for 'all'; without this the route could store
  // the string and nobody would notice until a file was read by hand.
  const config = tmpConfig();
  const project = tmpProject(config);
  const { port, close } = startApp(config);
  const projectsPath = path.join(config.dataDir, 'projects.json');

  await patchJson(port, `/api/projects/${project.id}`, { notify: 'none' });
  assert.equal((await patchJson(port, `/api/projects/${project.id}`, { notify: 'all' })).status, 204);
  assert.equal('notify' in loadProjects(projectsPath)[0], false);
  close();
});

test('the session list reports the stored assignment as an id', async () => {
  const config = tmpConfig();
  const project = tmpProject(config);
  const { encodeProjectPath } = await import('../src/lib/sessionStore.js');
  const sessionId = crypto.randomUUID();
  setMeta(config.dataDir, sessionId, { accountId: 'id-1', projectId: project.id });
  // Without a JSONL fixture, listSessions returns nothing and the loop
  // below never runs - see the same pattern in routesSessionList.test.js
  // at "returns the associated accountId from session-meta.json".
  const projectDir = path.join(config.claudeHome, 'projects', encodeProjectPath(project.path));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n',
  );
  const { port, close } = startApp(config);

  const res = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(body.sessions.length > 0, 'the fixture must produce at least one row');
  for (const session of body.sessions) {
    assert.ok(!('account' in session), 'no name-based field may remain');
    assert.ok(!('activeAccount' in session));
  }
  close();
});
