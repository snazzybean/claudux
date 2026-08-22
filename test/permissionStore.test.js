// What a session is being asked, and the key its hook secret is derived
// from. The two routers that fill and read this store have their own file
// beside this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setMeta, getMeta } from '../src/lib/sessionMeta.js';
import { createPermissionStore, forgetDialogIfSettled } from '../src/lib/permissionStore.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

// The store derives its secrets from a key file, so every one of these needs
// a directory of its own - a shared one would let one test's key decide
// another test's secret.
function tmpStore(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-permstore-'));
  return { dataDir, store: createPermissionStore({ dataDir, ...options }) };
}

test('clear removes a held dialog', () => {
  const { store } = tmpStore();
  store.put(SESSION, { toolName: 'Bash' });
  store.clear(SESSION);
  assert.equal(store.get(SESSION), null);
});

// The store used to be emptied by the browser alone, on a tick that only
// runs while the conversation tab is open. A box answered in the terminal
// with that tab closed left its payload behind - and the next box the hook
// failed to report was then drawn with the previous one's title over its
// buttons.
test('a status that is not waiting drops the dialog the hook left', () => {
  const { store } = tmpStore();
  store.put(SESSION, { toolName: 'Bash', at: Date.now() - 60_000 });

  assert.equal(forgetDialogIfSettled(store, { tmuxSession: SESSION, state: 'waiting' }), false);
  assert.ok(store.get(SESSION), 'a session standing in front of a box keeps its payload');

  assert.equal(forgetDialogIfSettled(store, { tmuxSession: SESSION, state: 'busy' }), true);
  assert.equal(store.get(SESSION), null);
});

// The hook fires BEFORE the box is drawn, so for that moment the session
// still reads as working while the payload for the box that is coming is
// already here. A pass landing in it must not take the payload the card is
// about to be drawn from - there is no second hook to bring it back.
test('a payload younger than one watcher pass survives a status that says working', () => {
  const { store } = tmpStore();
  store.put(SESSION, { toolName: 'Bash', at: Date.now() });

  assert.equal(forgetDialogIfSettled(store, { tmuxSession: SESSION, state: 'busy' }), false);
  assert.ok(store.get(SESSION), 'the fresh payload is still there');
  assert.equal(forgetDialogIfSettled(store, { tmuxSession: SESSION, state: 'busy' }, 0), true);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The handover the two halves of knowsSession make between them: the flag
// carries an id from the spawn until its meta entry exists, and hands it over
// there. Written out here rather than driven through createApp, because the
// window is 30 s in production and only a store of the test's own can be
// given a shorter one.
test('knowsSession carries an id from the prepared flag over to its meta entry', async () => {
  const { dataDir, store } = tmpStore({ preparedTtlMs: 100 });
  const knows = (id) => store.isPrepared(id) || Boolean(getMeta(dataDir, id));
  const starting = SESSION;
  // Prepared, but its start never got as far as writing a meta entry.
  const stranded = '22222222-2222-3333-4444-555555555555';
  const never = '33333333-2222-3333-4444-555555555555';

  assert.equal(knows(never), false, 'an id that never started is known by neither half');

  store.prepare(starting);
  store.prepare(stranded);
  assert.equal(knows(starting), true, 'inside the window an id is known without a meta entry');

  setMeta(dataDir, starting, { accountId: 'a', projectId: 'p' });
  await sleep(200);

  assert.equal(knows(starting), true, 'past the window the meta entry has to carry it');
  assert.equal(knows(stranded), false, 'a start without a meta entry stops opening the hook route');
  assert.equal(knows(never), false);
});

// The flag used to be a Set nothing ever removed from: one entry per session
// ever started, for the life of the process.
test('an expired prepared id is dropped rather than piling up', async () => {
  const { store } = tmpStore({ preparedTtlMs: 100 });
  store.prepare(SESSION);
  store.prepare('22222222-2222-3333-4444-555555555555');
  assert.equal(store.preparedCount(), 2);

  await sleep(200);
  store.prepare('33333333-2222-3333-4444-555555555555');

  assert.equal(store.preparedCount(), 1, 'the two expired entries are still held');
});

// Deploying this project restarts the service, and KillMode=process leaves
// every `claude` running with the secret it was started with. A secret held
// in memory would be gone while those sessions keep sending theirs, and
// every dialog they report would be refused for the rest of their lives -
// invisibly, since the terminal keeps its own box either way.
test('a new store over the same data directory derives the same secret', () => {
  const { dataDir, store } = tmpStore();
  const before = store.secretFor(SESSION);
  assert.match(before, /^[0-9a-f]{64}$/);
  const afterRestart = createPermissionStore({ dataDir }).secretFor(SESSION);
  assert.equal(afterRestart, before);
});

test('the secret differs per session and per installation', () => {
  const { dataDir, store } = tmpStore();
  assert.notEqual(store.secretFor(SESSION), store.secretFor('22222222-2222-3333-4444-555555555555'));
  const elsewhere = tmpStore().store.secretFor(SESSION);
  assert.notEqual(elsewhere, store.secretFor(SESSION));
  // The key, not the derived value, is what has to stay unreadable.
  const mode = fs.statSync(path.join(dataDir, 'permission-hook.key')).mode & 0o777;
  assert.equal(mode, 0o600);
});
