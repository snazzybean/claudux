import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { decide, levelAllows, runWatcherOnce } from '../src/lib/statusWatcher.js';
import { setMeta } from '../src/lib/sessionMeta.js';
import { addTarget, listTargets } from '../src/lib/notificationTargets.js';

// A fixed epoch base: every timestamp below reads as an offset from it, and
// no test depends on the wall clock.
const AT = 1_700_000_000_000;
const busy = { status: 'busy', statusUpdatedAt: AT };
const idle = { status: 'idle', statusUpdatedAt: AT + 1_000 };
const waiting = { status: 'waiting', statusUpdatedAt: AT + 2_000 };
// Well past the settle window, and inside it.
const settled = { now: AT + 200_000 };
const fresh = { now: AT + 3_000 };

test('the first tick only seeds and never notifies', () => {
  // Otherwise every `systemctl restart claudux` would notify for every
  // running session on the host.
  const result = decide(undefined, idle, false, settled);
  assert.equal(result.notify, false);
  assert.equal(result.next.notified, true);
});

test('busy to idle notifies', () => {
  const seeded = decide(undefined, busy, false, settled).next;
  const result = decide(seeded, idle, false, settled);
  assert.equal(result.notify, true);
  assert.equal(result.state, 'idle');
});

test('busy to waiting notifies as well', () => {
  const seeded = decide(undefined, busy, false, settled).next;
  assert.equal(decide(seeded, waiting, false, settled).notify, true);
});

test('a second tick in the same phase stays quiet', () => {
  const seeded = decide(undefined, busy, false, settled).next;
  const after = decide(seeded, idle, false, settled);
  assert.equal(decide(after.next, { status: 'idle', statusUpdatedAt: AT + 1_000 }, false, settled).notify, false);
});

test('staying busy never notifies, not even with a fresh timestamp', () => {
  const seeded = decide(undefined, busy, false, settled).next;
  assert.equal(decide(seeded, { status: 'busy', statusUpdatedAt: AT + 999 }, false, settled).notify, false);
});

test('a visible session is suppressed and not notified later either', () => {
  const seeded = decide(undefined, busy, false, settled).next;
  const suppressed = decide(seeded, idle, true, settled);
  assert.equal(suppressed.notify, false);
  // The hook fired once per response; a suppressed one was never made up
  // for. Same behaviour here.
  assert.equal(decide(suppressed.next, idle, false, settled).notify, false);
});

test('a new phase after busy notifies again', () => {
  const seeded = decide(undefined, busy, false, settled).next;
  const first = decide(seeded, idle, false, settled);
  const backToWork = decide(first.next, { status: 'busy', statusUpdatedAt: AT + 400 }, false, settled);
  assert.equal(backToWork.notify, false);
  assert.equal(decide(backToWork.next, { status: 'idle', statusUpdatedAt: AT + 500 }, false, settled).notify, true);
});

test('an unknown future status counts as not-busy', () => {
  const seeded = decide(undefined, busy, false, settled).next;
  assert.equal(decide(seeded, { status: 'compacting-or-whatever', statusUpdatedAt: AT + 600 }, false, settled).notify, true);
});

test('inside the settle window nothing goes out and the flag stays down', () => {
  // The flag rising here would look like "already reported" while nothing
  // was ever sent - the session would stay silent for the rest of the phase.
  const seeded = decide(undefined, busy, false, fresh).next;
  const first = decide(seeded, idle, false, fresh);
  assert.equal(first.notify, false);
  assert.equal(first.next.notified, false);
  const second = decide(first.next, idle, false, { now: AT + 4_000 });
  assert.equal(second.notify, false);
  assert.equal(second.next.notified, false);
});

test('once the window has elapsed exactly one notification goes out', () => {
  const seeded = decide(undefined, busy, false, fresh).next;
  const waited = decide(seeded, idle, false, fresh);
  const due = decide(waited.next, idle, false, settled);
  assert.equal(due.notify, true);
  assert.equal(decide(due.next, idle, false, { now: AT + 300_000 }).notify, false);
});

test('waiting notifies immediately, window or not', () => {
  // A question and a permission prompt both land here, and both block the
  // session on an answer. Delaying them would postpone the one message
  // somebody is waiting for.
  const seeded = decide(undefined, busy, false, fresh).next;
  assert.equal(decide(seeded, waiting, false, { now: AT + 2_100 }).notify, true);
});

test('a fresh statusUpdatedAt starts a new phase without a busy in between', () => {
  const seeded = decide(undefined, busy, false, fresh).next;
  const shellPhase = decide(seeded, { status: 'shell', statusUpdatedAt: AT + 1_000 }, false, fresh);
  assert.equal(shellPhase.notify, false);
  const idlePhase = decide(shellPhase.next, { status: 'idle', statusUpdatedAt: AT + 5_000 }, false, { now: AT + 200_000 });
  assert.equal(idlePhase.notify, true);
});

test('looking at a session while the window runs does not swallow the notification', () => {
  // The case the whole change is for: a background agent leaves the session
  // on `idle` while it works. Checking on it must not count as having seen
  // the finished session - the registry cannot tell the two apart.
  const seeded = decide(undefined, busy, false, fresh).next;
  const watched = decide(seeded, idle, true, fresh);
  assert.equal(watched.notify, false);
  assert.equal(watched.next.notified, false);
  assert.equal(decide(watched.next, idle, false, settled).notify, true);
});

test('visible when the window elapses stays quiet and is not made up for', () => {
  const seeded = decide(undefined, busy, false, fresh).next;
  const seen = decide(seeded, idle, true, settled);
  assert.equal(seen.notify, false);
  assert.equal(decide(seen.next, idle, false, { now: AT + 300_000 }).notify, false);
});

test('runWatcherOnce notifies for a carrier that stopped being busy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: 'https://c.example', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const deps = {
    notifyFn: async (message) => { sent.push(message); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    nowFn: () => AT + 200_000,
    registryFn: () => new Map([['carrier-1', {
      pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
      status: 'busy', statusUpdatedAt: AT,
    }]]),
    accountNameFn: (id) => (id === 'id-1' ? 'work' : null),
  };
  // First pass seeds. It does report the state it found - see the first-
  // sighting test - but notifies about nothing.
  assert.deepEqual(await runWatcherOnce(config, state, deps), [
    { tmuxSession: 'carrier-1', sessionId: 'carrier-1', state: 'busy' },
  ]);
  assert.equal(sent.length, 0);

  deps.registryFn = () => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status: 'idle', statusUpdatedAt: AT + 1_000,
  }]]);
  const events = await runWatcherOnce(config, state, deps);
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'idle');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Claudux (work)');
  assert.equal(sent[0].clickUrl, 'https://c.example/#/session/carrier-1');
});

test('runWatcherOnce forgets carriers that stopped running', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const deps = {
    notifyFn: async () => {},
    listFn: async () => [],
    isVisibleFn: () => false,
    registryFn: () => new Map(),
  };
  await runWatcherOnce(config, state, deps);
  // No leftovers: otherwise the map grows for the process's whole lifetime.
  assert.equal(state.size, 0);
});

// The CLI writes `shell` when a turn ends while a background command keeps
// running. Nobody is being waited for, so it stays quiet until the fallback
// frees a session whose background process outlives the work.
test('shell stays quiet inside the fallback and reports once after it', () => {
  const seeded = decide(undefined, busy, false, fresh).next;
  const running = decide(seeded, { status: 'shell', statusUpdatedAt: AT + 1_000 }, false, { now: AT + 200_000 });
  assert.equal(running.notify, false, 'a background command still running is not a finished turn');
  assert.equal(running.next.notified, false);
  const stuck = decide(running.next, { status: 'shell', statusUpdatedAt: AT + 1_000 }, false, { now: AT + 700_000 });
  assert.equal(stuck.notify, true);
  assert.equal(stuck.state, 'shell');
});

// The dot follows every phase change, the notification only the ones nobody
// is looking at. Without this split the stream would carry no `busy` at
// all - that transition is never notifiable - and the dot could never
// start pulsing from it.
test('runWatcherOnce reports the start of a turn without notifying', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const entry = (status, at) => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status, statusUpdatedAt: at,
  }]]);
  const deps = {
    notifyFn: async (m) => { sent.push(m); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    registryFn: () => entry('idle', 1),
  };
  await runWatcherOnce(config, state, deps);          // seeds

  deps.registryFn = () => entry('busy', 2);
  const events = await runWatcherOnce(config, state, deps);
  assert.deepEqual(events, [{ tmuxSession: 'carrier-1', sessionId: 'carrier-1', state: 'busy' }]);
  assert.equal(sent.length, 0);
});

// A session seen for the first time has no delta to report, but the
// frontend learns a state only from this stream or the slower list fetch -
// so a session started just now, or every session after a restart, wore a
// state nobody had measured until it happened to change on its own.
test('the first sighting of a session reports its state', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const events = await runWatcherOnce(config, state, {
    notifyFn: async (m) => { sent.push(m); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    registryFn: () => new Map([['carrier-1', {
      pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
      status: 'busy', statusUpdatedAt: AT,
    }]]),
    nowFn: () => AT,
  });

  assert.deepEqual(events, [{ tmuxSession: 'carrier-1', sessionId: 'carrier-1', state: 'busy' }]);
  // The seed still keeps quiet - only the dot learns something here.
  assert.equal(sent.length, 0);
});

test('a visible session still moves its dot, it just stays quiet', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const entry = (status, at) => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status, statusUpdatedAt: at,
  }]]);
  const deps = {
    notifyFn: async (m) => { sent.push(m); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    // Whoever is looking at the session is exactly who benefits from the
    // dot - suppressing the delta for them would be backwards.
    isVisibleFn: () => true,
    nowFn: () => AT + 200_000,
    registryFn: () => entry('busy', AT),
  };
  await runWatcherOnce(config, state, deps);

  deps.registryFn = () => entry('idle', AT + 1_000);
  const events = await runWatcherOnce(config, state, deps);
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'idle');
  assert.equal(sent.length, 0);
});

test('a corpse does not keep pulsing as working', async () => {
  // The registry entry freezes at its last value. Without skipping corpses,
  // a session that died mid-turn would pulse "working" forever.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const tmuxSession = crypto.randomUUID();
  const registry = new Map([[tmuxSession, { sessionId: tmuxSession, status: 'busy', statusUpdatedAt: 1 }]]);
  const state = new Map([[tmuxSession, { status: 'busy', statusUpdatedAt: 1, notified: false }]]);

  const events = await runWatcherOnce(config, state, {
    registryFn: () => registry,
    // The watcher needs full entries: reconcile gets every name, while
    // status is judged only on live ones.
    listFn: async () => [{ name: tmuxSession, dead: true, deadStatus: null, deadSignal: 9 }],
    isVisibleFn: () => true,
    notifyFn: async () => {},
  });

  assert.deepEqual(events, [], 'no status event for a dead session');
  assert.equal(state.has(tmuxSession), false, 'the entry does not stay in the map');
});

test('the watcher prunes a push subscription the service reported gone', async () => {
  // Deliberately WITHOUT injecting notifyFn: every other test here replaces
  // it, so the real one - the path production actually takes - would never be
  // exercised. This watcher is the actual sender, so a dead subscription
  // surviving here would outlive anything the route does about it.
  const push = http.createServer((req, res) => {
    res.writeHead(410);
    res.end();
  });
  await new Promise((resolve) => push.listen(0, resolve));
  const { port: pushPort } = push.address();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-prune-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = {
    dataDir,
    claudeHome: '/unused',
    publicBaseUrl: 'https://claudux.example.com',
    notificationTargetsPath: path.join(dataDir, 'notifications.json'),
    vapidKeysPath: path.join(dataDir, 'vapid.json'),
    vapidSubject: 'https://claudux.example.com',
  };
  const id = addTarget(config.notificationTargetsPath, {
    type: 'webpush',
    name: 'iPhone',
    config: {
      endpoint: `http://127.0.0.1:${pushPort}/device/abc`,
      keys: {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
    },
  });
  const kept = addTarget(config.notificationTargetsPath, {
    type: 'ntfy',
    name: 'phone',
    // Nothing listens there; a failing ntfy target must not affect the
    // pruning of the push one.
    config: { url: 'http://127.0.0.1:1', topic: 't' },
  });

  const state = new Map();
  const deps = {
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    nowFn: () => AT + 200_000,
    registryFn: () => new Map([['carrier-1', {
      pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
      status: 'busy', statusUpdatedAt: AT,
    }]]),
  };
  await runWatcherOnce(config, state, deps); // seeds
  deps.registryFn = () => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status: 'idle', statusUpdatedAt: AT + 1_000,
  }]]);
  await runWatcherOnce(config, state, deps);

  push.close();
  push.closeAllConnections();

  const remaining = listTargets(config.notificationTargetsPath).map((t) => t.id);
  assert.deepEqual(remaining, [kept]);
  assert.equal(remaining.includes(id), false);
});

test('runWatcherOnce holds a finished session back until the window elapsed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const entry = (status, at) => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status, statusUpdatedAt: at,
  }]]);
  let clock = AT;
  const deps = {
    notifyFn: async (m) => { sent.push(m); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    nowFn: () => clock,
    registryFn: () => entry('busy', AT),
  };
  await runWatcherOnce(config, state, deps);              // seeds

  deps.registryFn = () => entry('idle', AT + 1_000);
  clock = AT + 30_000;
  await runWatcherOnce(config, state, deps);
  assert.equal(sent.length, 0, 'half a minute of quiet is not a finished session');

  clock = AT + 200_000;
  await runWatcherOnce(config, state, deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'Session is waiting for input');

  clock = AT + 400_000;
  await runWatcherOnce(config, state, deps);
  assert.equal(sent.length, 1, 'one per phase, no matter how long it lasts');
});

test('the notification title carries the account name resolved from the id', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: 'https://c.example', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const deps = {
    notifyFn: async (message) => { sent.push(message); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    nowFn: () => AT + 200_000,
    registryFn: () => new Map([['carrier-1', {
      pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
      status: 'busy', statusUpdatedAt: AT,
    }]]),
    accountNameFn: (id) => (id === 'id-1' ? 'work' : null),
  };

  await runWatcherOnce(config, state, deps); // seeds
  await runWatcherOnce(config, state, {
    ...deps,
    registryFn: () => new Map([['carrier-1', {
      pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
      status: 'idle', statusUpdatedAt: AT + 1_000,
    }]]),
  });

  assert.match(sent.at(-1).title, /work/);
});

test('levelAllows lets exactly four of nine combinations through', () => {
  // `blocking` is exactly the status the session cannot leave on its own.
  // A finished turn and the background-shell fallback both say "have a
  // look", not "I am stuck".
  for (const state of ['waiting', 'idle', 'shell']) {
    assert.equal(levelAllows('all', state), true, `all/${state}`);
    assert.equal(levelAllows('none', state), false, `none/${state}`);
  }
  assert.equal(levelAllows('blocking', 'waiting'), true);
  assert.equal(levelAllows('blocking', 'idle'), false);
  assert.equal(levelAllows('blocking', 'shell'), false);
});

test('a silenced project still moves its dot, it just sends nothing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const entry = (status, at) => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status, statusUpdatedAt: at,
  }]]);
  const deps = {
    notifyFn: async (m) => { sent.push(m); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    nowFn: () => AT + 200_000,
    notifyLevelFn: () => 'none',
    registryFn: () => entry('busy', AT),
  };
  await runWatcherOnce(config, state, deps);          // seeds

  deps.registryFn = () => entry('idle', AT + 1_000);
  const events = await runWatcherOnce(config, state, deps);
  // The dot belongs to whoever has the list open - silencing the message
  // must not silence the display.
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'idle');
  assert.equal(sent.length, 0);
});

test('a project set to blocking reports the question but not the finished turn', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'proj-1' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const entry = (status, at) => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status, statusUpdatedAt: at,
  }]]);
  const deps = {
    notifyFn: async (m) => { sent.push(m); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    nowFn: () => AT + 200_000,
    notifyLevelFn: (projectId) => (projectId === 'proj-1' ? 'blocking' : 'all'),
    registryFn: () => entry('busy', AT),
  };
  await runWatcherOnce(config, state, deps);          // seeds

  deps.registryFn = () => entry('idle', AT + 1_000);
  await runWatcherOnce(config, state, deps);
  assert.equal(sent.length, 0, 'a finished turn is not blocking');

  deps.registryFn = () => entry('busy', AT + 2_000);
  await runWatcherOnce(config, state, deps);
  deps.registryFn = () => entry('waiting', AT + 3_000);
  await runWatcherOnce(config, state, deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'Session is asking for confirmation');
});

test('a project missing from the list keeps notifying', async () => {
  // Deliberately WITHOUT injecting notifyLevelFn: this exercises the real
  // lookup, which finds nothing in an empty projects.json and has to fall
  // back to 'all' rather than going silent.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-watch-'));
  setMeta(dataDir, 'carrier-1', { accountId: 'id-1', projectId: 'gone' });
  const config = { dataDir, claudeHome: '/unused', publicBaseUrl: '', notificationTargetsPath: '/unused' };
  const state = new Map();
  const sent = [];
  const entry = (status, at) => new Map([['carrier-1', {
    pid: 1, sessionId: 'carrier-1', tmuxSession: 'carrier-1', cwd: '/srv/project',
    status, statusUpdatedAt: at,
  }]]);
  const deps = {
    notifyFn: async (m) => { sent.push(m); },
    listFn: async () => [{ name: 'carrier-1', dead: false }],
    isVisibleFn: () => false,
    nowFn: () => AT + 200_000,
    registryFn: () => entry('busy', AT),
  };
  await runWatcherOnce(config, state, deps);          // seeds
  deps.registryFn = () => entry('idle', AT + 1_000);
  await runWatcherOnce(config, state, deps);
  assert.equal(sent.length, 1);
});
