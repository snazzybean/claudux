// test/sessionList.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionList } from '../src/lib/sessionList.js';

// Defaults that each test overrides individually. `carrierFor` and
// `conversationFor` model the normal case: without a /clear, a session carries
// its own name and runs its own conversation.
function build(overrides = {}) {
  return buildSessionList({
    history: [],
    running: [],
    projectId: 'p1',
    metaFor: () => null,
    carrierFor: (id) => id,
    conversationFor: (carrier) => carrier,
    ...overrides,
  });
}

const HIST = (id, startMs) => ({ id, title: `Title ${id}`, lastPrompt: null, mtimeMs: startMs, startMs });
const TMUX = (name, createdEpoch) => ({ name, activityEpoch: createdEpoch, attached: false, createdEpoch });

test('a session without a JSONL file appears as a placeholder', () => {
  const list = build({
    running: [TMUX('new-1', 1723000000)],
    metaFor: (id) => (id === 'new-1' ? { projectId: 'p1', accountId: 'id-1' } : null),
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'new-1');
  assert.equal(list[0].live, true);
  assert.equal(list[0].startMs, 1723000000 * 1000);
  assert.ok(list[0].title, 'placeholder needs a title');
});

// listTmuxSessions sees the WHOLE tmux server, including foreign sessions and
// those of other projects. Without this check they'd land in every project's
// list.
test('running sessions of foreign projects do not show up', () => {
  const list = build({
    running: [TMUX('foreign-1', 1723000000), TMUX('no-meta', 1723000000)],
    metaFor: (id) => (id === 'foreign-1' ? { projectId: 'p2' } : null),
  });
  assert.deepEqual(list, []);
});

test('once the JSONL file exists, it stays at ONE row', () => {
  const list = build({
    history: [HIST('new-1', 5000)],
    running: [TMUX('new-1', 5)],
    metaFor: () => ({ projectId: 'p1' }),
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Title new-1');
  assert.equal(list[0].live, true);
});

// After a /clear the conversation continues under a new Claude ID while the
// tmux session keeps its old name; liveness needs carrier resolution.
test('a session after /clear counts as live', () => {
  const list = build({
    history: [HIST('after-clear', 5000)],
    running: [TMUX('tmux-1', 5)],
    carrierFor: (id) => (id === 'after-clear' ? 'tmux-1' : id),
    conversationFor: () => 'after-clear',
    metaFor: () => ({ projectId: 'p1' }),
  });
  assert.equal(list.length, 1, 'the carrier session must not produce a second row');
  assert.equal(list[0].id, 'after-clear');
  assert.equal(list[0].live, true);
  assert.equal(list[0].carrier, 'tmux-1');
  assert.equal(list[0].current, true);
});

// Both conversations of a carrier are in the list. The one from BEFORE the
// /clear has ended even though its tmux session keeps running - the stop
// button hangs off the live row, so it must not sit on the old one.
test('the conversation from before a /clear is no longer live', () => {
  const list = build({
    history: [HIST('tmux-1', 4000), HIST('after-clear', 5000)],
    running: [TMUX('tmux-1', 5)],
    carrierFor: (id) => (id === 'after-clear' ? 'tmux-1' : id),
    conversationFor: () => 'after-clear',
    metaFor: () => ({ projectId: 'p1' }),
  });
  const before = list.find((s) => s.id === 'tmux-1');
  const after = list.find((s) => s.id === 'after-clear');
  assert.equal(before.live, false, 'the row from before the /clear must not carry a stop button');
  assert.equal(before.current, false);
  assert.equal(after.live, true);
  assert.equal(after.current, true);
});

// Between the /clear and the first prompt after it, the new conversation
// already exists, but its JSONL doesn't yet (Claude Code only creates it on
// the first prompt). Without its own row for that, NO row carries the green
// dot during that time: the old one no longer runs the conversation, the new
// one is missing.
test('after a /clear, the still-fileless conversation shows up as a placeholder in the list', () => {
  const list = build({
    history: [HIST('tmux-1', 4000)],
    running: [TMUX('tmux-1', 5)],
    conversationFor: () => 'after-clear',
    metaFor: () => ({ projectId: 'p1' }),
  });
  const before = list.find((s) => s.id === 'tmux-1');
  const after = list.find((s) => s.id === 'after-clear');
  assert.ok(after, 'the running conversation is missing from the list');
  assert.equal(after.live, true);
  assert.equal(after.carrier, 'tmux-1');
  assert.equal(before.live, false);
});

// Older entries carry no marker for which conversation a tmux session is
// running, so without a fallback every cleared session counts as finished.
test('without a report, the most recently started conversation of the carrier counts as the running one', () => {
  const list = build({
    history: [HIST('tmux-1', 4000), HIST('after-clear', 5000)],
    running: [TMUX('tmux-1', 5)],
    carrierFor: (id) => (id === 'after-clear' ? 'tmux-1' : id),
    metaFor: () => ({ projectId: 'p1' }),
  });
  assert.equal(list.find((s) => s.id === 'after-clear').live, true);
  assert.equal(list.find((s) => s.id === 'tmux-1').live, false);
});

test('a finished session is not live', () => {
  const list = build({ history: [HIST('old-1', 5000)] });
  assert.equal(list[0].live, false);
});

test('the list is sorted by start, newest first', () => {
  const list = build({
    history: [HIST('old', 1000), HIST('mid', 2000)],
    running: [TMUX('fresh', 9)],
    metaFor: (id) => (id === 'fresh' ? { projectId: 'p1' } : null),
  });
  assert.deepEqual(
    list.map((s) => s.id),
    ['fresh', 'mid', 'old']
  );
});

// Without this the row starts out as plain "live", which pulses - and the
// stream only corrects it on the NEXT change. A session that has been
// waiting for a while would pulse from every list rebuild onwards until it
// happens to work again.
test('a live row carries the activity it is in right now', () => {
  const sessions = build({
    history: [{ id: 'tmux-1', title: 't', startMs: 1, mtimeMs: 1 }],
    running: [{ name: 'tmux-1', createdEpoch: 1 }],
    metaFor: () => ({ projectId: 'p1' }),
    activityFor: () => 'waiting',
  });
  assert.equal(sessions[0].activity, 'waiting');
});

test('activity stays null when nothing is known about the carrier', () => {
  const sessions = build({
    history: [{ id: 'tmux-1', title: 't', startMs: 1, mtimeMs: 1 }],
    running: [{ name: 'tmux-1', createdEpoch: 1 }],
    metaFor: () => ({ projectId: 'p1' }),
  });
  // The row then falls back to the plain live dot - no invented state.
  assert.equal(sessions[0].activity, null);
});
