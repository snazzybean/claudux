import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setMeta } from '../src/lib/sessionMeta.js';
import { tmpConfig, startApp } from './helpers/routeHarness.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;
const turn = (uuid, parentUuid, content, type = 'user') =>
  line({ type, uuid, parentUuid, message: { content } });

const CARRIER = 'carrier-1';
// What Claude Code assigns after a /clear: the tmux session keeps its name,
// the conversation moves into a file named after the new session id.
const AFTER_CLEAR = '22222222-3333-4444-5555-666666666666';

function projectDir(config) {
  const dir = path.join(config.claudeHome, 'projects', '-srv-project');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A session Claudux started, with its transcript under the carrier's own
// name - which is how it is until the first /clear.
function fixture(config, body = turn('a', null, 'hi')) {
  setMeta(config.dataDir, CARRIER, { accountId: 'id-1', projectId: 'proj-1' });
  const file = path.join(projectDir(config), `${CARRIER}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

const get = (port, query = '') =>
  fetch(`http://127.0.0.1:${port}/api/sessions/${CARRIER}/conversation${query}`);

test('the route serves the conversation of the session itself', async () => {
  const config = tmpConfig();
  fixture(config, turn('a', null, 'hi') + turn('b', 'a', 'there', 'assistant'));
  const { port, close } = startApp(config);
  try {
    const res = await get(port);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.events.map((e) => e.uuid), ['a', 'b']);
    assert.equal(body.transcriptId, CARRIER);
    assert.equal(body.atStart, true);
    assert.ok(body.offset > 0);
  } finally {
    close();
  }
});

// After a /clear the session's conversation lives under a different id, and
// only the meta entry pointing back at the carrier connects the two. A gate
// keyed on the carrier alone would 404 a session whose transcript is fine.
test('the route finds the transcript a /clear moved to a new id', async () => {
  const config = tmpConfig();
  fixture(config);
  setMeta(config.dataDir, AFTER_CLEAR, { tmuxSession: CARRIER, accountId: 'id-1', projectId: 'proj-1' });
  const cleared = path.join(projectDir(config), `${AFTER_CLEAR}.jsonl`);
  fs.writeFileSync(cleared, turn('c', null, 'after the clear'));
  const now = Date.now() / 1000;
  fs.utimesSync(cleared, now, now);
  fs.utimesSync(path.join(projectDir(config), `${CARRIER}.jsonl`), now - 60, now - 60);
  const { port, close } = startApp(config);
  try {
    const body = await (await get(port)).json();
    assert.equal(body.transcriptId, AFTER_CLEAR);
    assert.deepEqual(body.events.map((e) => e.uuid), ['c']);
  } finally {
    close();
  }
});

test('the route returns only what the transcript grew by after an offset', async () => {
  const config = tmpConfig();
  const file = fixture(config);
  const { port, close } = startApp(config);
  try {
    const first = await (await get(port, '?tail=1')).json();
    fs.appendFileSync(file, turn('b', 'a', 'there', 'assistant'));
    const second = await (await get(port, `?after=${first.offset}`)).json();
    assert.deepEqual(second.events.map((e) => e.uuid), ['b']);
    assert.equal('queue' in second, false);
  } finally {
    close();
  }
});

// The poll path does not filter, whatever one window holds - see the reader
// test of the same name for why.
test('the route does not filter what one poll window holds', async () => {
  const config = tmpConfig();
  const file = fixture(config, turn('root', null, 'earlier'));
  const { port, close } = startApp(config);
  try {
    const first = await (await get(port, '?tail=1')).json();
    fs.appendFileSync(file, turn('p', 'root', 'the fork point')
      + turn('a1', 'p', 'kept one', 'assistant')
      + turn('a2', 'a1', 'kept two')
      + turn('r1', 'p', 'rewound', 'assistant'));
    const poll = await (await get(port, `?after=${first.offset}`)).json();
    assert.deepEqual(poll.events.map((e) => e.uuid), ['p', 'a1', 'a2', 'r1']);
    assert.equal(poll.abandoned, 0);
  } finally {
    close();
  }
});

// `Number.parseInt('1e9', 10)` is 1, and byte 1 is inside the first line -
// the answer would silently be missing that turn.
test('the route does not take the numeric prefix of an unusable offset', async () => {
  const config = tmpConfig();
  fixture(config, turn('a', null, 'hi') + turn('b', 'a', 'there', 'assistant'));
  const { port, close } = startApp(config);
  try {
    const body = await (await get(port, '?after=1e9')).json();
    assert.deepEqual(body.events.map((e) => e.uuid), ['a', 'b']);
    assert.equal(body.from, 0);
  } finally {
    close();
  }
});

test('the route pages upwards from a byte offset', async () => {
  const config = tmpConfig();
  const first = turn('a', null, 'hi');
  fixture(config, first + turn('b', 'a', 'there', 'assistant'));
  const { port, close } = startApp(config);
  try {
    const body = await (await get(port, `?before=${Buffer.byteLength(first)}`)).json();
    assert.deepEqual(body.events.map((e) => e.uuid), ['a']);
    assert.equal(body.atStart, true);
  } finally {
    close();
  }
});

// The anchor is what the previous window handed back; without it the walk
// would start at this window's last line, and a rewound branch beside it
// would read as the live path. b0 forks off u0 rather than off the anchor -
// a branch beside the anchor itself is not judgeable from this window.
test('the route filters an older window against the anchor it is given', async () => {
  const config = tmpConfig();
  const body = turn('u0', null, 'zero')
    + turn('b0', 'u0', 'rewound', 'assistant')
    + turn('u1', 'u0', 'one');
  fixture(config, body + turn('u2', 'u1', 'two', 'assistant'));
  const before = Buffer.byteLength(body);
  const { port, close } = startApp(config);
  try {
    const anchored = await (await get(port, `?before=${before}&anchor=u1`)).json();
    assert.deepEqual(anchored.events.map((e) => e.uuid), ['u0', 'u1']);
    assert.equal(anchored.abandoned, 1);
    const bare = await (await get(port, `?before=${before}`)).json();
    assert.deepEqual(bare.events.map((e) => e.uuid), ['u0', 'b0', 'u1']);
  } finally {
    close();
  }
});

// Mixing the three has no meaning; preferring one is friendlier than a 400.
test('the route prefers tail over after and before', async () => {
  const config = tmpConfig();
  fixture(config, turn('a', null, 'hi') + turn('b', 'a', 'there', 'assistant'));
  const { port, close } = startApp(config);
  try {
    const body = await (await get(port, '?tail=1&after=0&before=10')).json();
    assert.deepEqual(body.events.map((e) => e.uuid), ['a', 'b']);
    assert.equal(body.from, 0);
  } finally {
    close();
  }
});

test('the route carries the queue and the permission mode on a tail read', async () => {
  const config = tmpConfig();
  fixture(config, turn('a', null, 'hi')
    + line({ type: 'queue-operation', operation: 'enqueue', content: 'later' })
    + line({ type: 'permission-mode', permissionMode: 'plan', sessionId: CARRIER }));
  const { port, close } = startApp(config);
  try {
    const body = await (await get(port, '?tail=1')).json();
    assert.deepEqual(body.queue, { waiting: [{ content: 'later' }] });
    assert.equal(body.permissionMode, 'plan');
  } finally {
    close();
  }
});

// The state every session is in for its first seconds: the file exists and
// holds nothing yet.
test('the route answers an empty conversation for a transcript with no lines', async () => {
  const config = tmpConfig();
  fixture(config, '');
  const { port, close } = startApp(config);
  try {
    const res = await get(port);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.events, []);
    assert.equal(body.offset, 0);
    assert.equal(body.atStart, true);
  } finally {
    close();
  }
});

test('the route answers 404 for a session claudux did not start', async () => {
  const config = tmpConfig();
  const { port, close } = startApp(config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/stranger-1/conversation`);
    assert.equal(res.status, 404);
  } finally {
    close();
  }
});

test('the route answers 404 for a session whose transcript is not written yet', async () => {
  const config = tmpConfig();
  setMeta(config.dataDir, CARRIER, { accountId: 'id-1', projectId: 'proj-1' });
  const { port, close } = startApp(config);
  try {
    const res = await get(port);
    assert.equal(res.status, 404);
  } finally {
    close();
  }
});

test('the route rejects a session id that is not a slug', async () => {
  const config = tmpConfig();
  fixture(config);
  const { port, close } = startApp(config);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent('../secret')}/conversation`);
    assert.equal(res.status, 400);
  } finally {
    close();
  }
});
