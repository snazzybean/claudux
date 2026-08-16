// test/sessionStore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeProjectPath, listSessions } from '../src/lib/sessionStore.js';

test('encodeProjectPath replaces slashes with dashes', () => {
  assert.equal(encodeProjectPath('/srv/project'), '-srv-project');
});

test('listSessions reads title from last-prompt lines and mtime from the file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    jsonlPath,
    [
      JSON.stringify({ type: 'user', message: { content: 'first message' } }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'last prompt text', sessionId }),
    ].join('\n') + '\n'
  );

  const sessions = listSessions(tmp, '/srv/project');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, sessionId);
  assert.equal(sessions[0].title, 'last prompt text');
  assert.ok(sessions[0].mtimeMs > 0);
});

// Claude Code writes its own title alongside `last-prompt`. It stays stable
// for the whole session, while `last-prompt` changes on every turn.
test('listSessions prefers ai-title over last-prompt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-title');
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '44444444-4444-4444-4444-444444444444';
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: 'user', message: { content: 'first message' } }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'last prompt text', sessionId }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Stable session title', sessionId }),
    ].join('\n') + '\n'
  );

  const [session] = listSessions(tmp, '/srv/title');
  assert.equal(session.title, 'Stable session title');
  // The last prompt still comes along: in the frontend it carries the
  // second line under the title.
  assert.equal(session.lastPrompt, 'last prompt text');
});

// A session that begins with a slash command and was never answered has
// neither ai-title nor last-prompt, so the title falls back to the first
// user message - raw control markup, out of which the command name is
// pulled.
test('listSessions shows the command when a slash command is the first message', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-command');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '99999999-9999-9999-9999-999999999999.jsonl'),
    JSON.stringify({
      type: 'user',
      message: { content: '<command-name>/goal</command-name>\n<command-args>something</command-args>' },
    }) + '\n'
  );

  const [session] = listSessions(tmp, '/srv/command');
  assert.equal(session.title, '/goal');
});

// A `/clear` starts a new JSONL that carries two pure control entries
// before the first real message: the caveat block and the command itself.
test('listSessions skips the caveat and /clear and takes the first real message', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-clear');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        message: { content: '<local-command-caveat>Caveat: The messages below…</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' },
      }),
      JSON.stringify({ type: 'user', message: { content: 'The scrollbar should go away' } }),
    ].join('\n') + '\n'
  );

  const [session] = listSessions(tmp, '/srv/clear');
  assert.equal(session.title, 'The scrollbar should go away');
});

// A message with an image arrives as a list of parts instead of a string,
// and it still carries text.
test('listSessions reads the title from a message with an image attachment', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-picture');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'),
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'What is in the picture?' },
          { type: 'image', source: { type: 'base64', data: 'x' } },
        ],
      },
    }) + '\n'
  );

  const [session] = listSessions(tmp, '/srv/picture');
  assert.equal(session.title, 'What is in the picture?');
});

// The state right after a /clear: the file exists but doesn't yet contain
// a typed message. Same wording as in sessionList.js, where a started
// session without a file has the same state.
test('listSessions shows "(no prompt yet)" as long as only control markup is in the file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-markup-only');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        message: { content: '<local-command-caveat>Caveat: …</local-command-caveat>' },
      }),
      JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
    ].join('\n') + '\n'
  );

  const [session] = listSessions(tmp, '/srv/markup-only');
  assert.equal(session.title, '(no prompt yet)');
});

test('listSessions returns startMs from the file birth time', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-start');
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '55555555-5555-5555-5555-555555555555';
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"user","message":{"content":"hi"}}\n');

  const [session] = listSessions(tmp, '/srv/start');
  assert.ok(session.startMs > 0, 'startMs must be set');
});

// Not every filesystem carries a birth time - there, stat returns 0.
// Without a fallback, every session would land on the same sort value and
// therefore in directory order.
test('listSessions falls back to mtime for startMs when there is no birth time', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-no-birthtime');
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '66666666-6666-6666-6666-666666666666';
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, '{"type":"user","message":{"content":"hi"}}\n');

  const real = fs.statSync(jsonlPath);
  t.mock.method(fs, 'statSync', () => ({ ...real, size: real.size, birthtimeMs: 0, mtimeMs: 1700000000000 }));

  const [session] = listSessions(tmp, '/srv/no-birthtime');
  assert.equal(session.startMs, 1700000000000);
});

// The older session is the most recently USED one. Both times come from a
// mock: two files created back to back share the same birth millisecond,
// and a birth time cannot be set after the fact.
test('listSessions sorts by startMs, not by the last activity', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-sorting');
  fs.mkdirSync(projectDir, { recursive: true });
  const older = '77777777-7777-7777-7777-777777777777';
  const newer = '88888888-8888-8888-8888-888888888888';
  for (const id of [older, newer]) {
    fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), '{"type":"user","message":{"content":"x"}}\n');
  }

  const real = fs.statSync(path.join(projectDir, `${older}.jsonl`));
  const times = {
    [older]: { birthtimeMs: 1000, mtimeMs: 9000 }, // started earlier, used most recently
    [newer]: { birthtimeMs: 2000, mtimeMs: 3000 },
  };
  t.mock.method(fs, 'statSync', (p) => ({ ...real, size: real.size, ...times[path.basename(p, '.jsonl')] }));

  const sessions = listSessions(tmp, '/srv/sorting');
  assert.deepEqual(
    sessions.map((s) => s.id),
    [newer, older]
  );
});

test('listSessions returns an empty array when the project folder doesn\'t exist', () => {
  const sessions = listSessions('/tmp/does-not-exist-claudux', '/srv/nope');
  assert.deepEqual(sessions, []);
});

// .jsonl files reach three-digit megabyte sizes; a full readFileSync per
// file blocks the event loop on every sidebar request. These tests build a
// file well above the tail window and verify via a mock on
// fs.readFileSync/fs.readSync that the tail-read path is actually taken -
// not just that the title happens to be right.
function buildPaddingLines(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(500) } }));
  }
  return lines;
}

test('listSessions reads only the end of the file for a large JSONL file (no full readFileSync), title stays correct', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-big');
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '22222222-2222-2222-2222-222222222222';
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);

  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'very first message, should not win' } }),
    ...buildPaddingLines(400),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'last prompt in tail chunk', sessionId }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  const size = fs.statSync(jsonlPath).size;
  assert.ok(size > 64 * 1024, `test file must be > 64 KB, but is only ${size} bytes`);

  const readFileSyncMock = t.mock.method(fs, 'readFileSync');
  const readSyncMock = t.mock.method(fs, 'readSync');

  const sessions = listSessions(tmp, '/srv/big');

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'last prompt in tail chunk');
  assert.equal(readFileSyncMock.mock.calls.length, 0, 'readFileSync was called even though the tail chunk should have been enough');
  assert.ok(readSyncMock.mock.calls.length > 0, 'readSync was not called');
});

test('listSessions falls back to a full file scan for a large JSONL file without last-prompt in the tail chunk', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-test-'));
  const projectDir = path.join(tmp, 'projects', '-srv-big-fallback');
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '33333333-3333-3333-3333-333333333333';
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);

  // The last-prompt entry sits far BEFORE the large padding block, i.e.
  // outside the last 64 KB tail chunk - only the full scan finds it.
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'very first message' } }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'earlier prompt outside the tail window', sessionId }),
    ...buildPaddingLines(400),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  const size = fs.statSync(jsonlPath).size;
  assert.ok(size > 64 * 1024, `test file must be > 64 KB, but is only ${size} bytes`);

  const readFileSyncMock = t.mock.method(fs, 'readFileSync');

  const sessions = listSessions(tmp, '/srv/big-fallback');

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'earlier prompt outside the tail window');
  // Core claim: the fallback scan MUST kick in here (readFileSync gets
  // called), because the tail chunk alone can't supply the title.
  assert.ok(readFileSyncMock.mock.calls.length > 0, 'fallback readFileSync was not called');
});

// ---------- Not reading unchanged files again ----------
//
// The sidebar tick pulls every project every 15 seconds and reads EVERY
// JSONL in it. In practice one single file changes between two ticks - the
// running session. All the others are finished conversations whose title
// can no longer change.

test('listSessions does not read a file again that has not changed', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-cache-'));
  const projectDir = path.join(tmp, 'projects', encodeProjectPath('/srv/cached'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'sess.jsonl'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'first title' }) + '\n',
  );

  const first = listSessions(tmp, '/srv/cached');
  assert.equal(first[0].title, 'first title');

  const readMock = t.mock.method(fs, 'readFileSync');
  const second = listSessions(tmp, '/srv/cached');

  assert.equal(second[0].title, 'first title');
  assert.equal(readMock.mock.calls.length, 0, 'the unchanged file was read a second time');
});

// The counterpart, without which a cache that never invalidates is green:
// a changed file has to yield the new title.
test('listSessions reads a file again once it has changed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-cache-'));
  const projectDir = path.join(tmp, 'projects', encodeProjectPath('/srv/changing'));
  fs.mkdirSync(projectDir, { recursive: true });
  const jsonlPath = path.join(projectDir, 'sess.jsonl');
  fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'last-prompt', lastPrompt: 'before' }) + '\n');

  assert.equal(listSessions(tmp, '/srv/changing')[0].title, 'before');

  fs.writeFileSync(
    jsonlPath,
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'after, and noticeably longer' }) + '\n',
  );

  assert.equal(listSessions(tmp, '/srv/changing')[0].title, 'after, and noticeably longer');
});

// Two projects can hold a file of the same name - the cache key has to be
// the full path, or one project would show the other's title.
test('listSessions keeps files of the same name in different projects apart', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-cache-'));
  for (const [project, title] of [['/srv/one', 'title of one'], ['/srv/two', 'title of two']]) {
    const dir = path.join(tmp, 'projects', encodeProjectPath(project));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'same.jsonl'), JSON.stringify({ type: 'last-prompt', lastPrompt: title }) + '\n');
  }

  assert.equal(listSessions(tmp, '/srv/one')[0].title, 'title of one');
  assert.equal(listSessions(tmp, '/srv/two')[0].title, 'title of two');
});
