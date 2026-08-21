import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConversation, TAIL_BYTES } from '../src/lib/conversationReader.js';
import { conversationEvents } from '../src/lib/sessionTranscript.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;
const turn = (uuid, parentUuid, content, type = 'user') =>
  line({ type, uuid, parentUuid, message: { content } });

const SESSION = '11111111-2222-3333-4444-555555555555';

function transcript(body, name = SESSION) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-reader-'));
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

test('readConversation reports the transcript identity so a swap is visible', () => {
  const file = transcript(turn('a', null, 'hi'));
  assert.equal(readConversation(file, { tail: true }).transcriptId, SESSION);
});

test('readConversation tail reports where it started and where it ended', () => {
  const file = transcript(turn('a', null, 'one'));
  const result = readConversation(file, { tail: true });
  assert.equal(result.from, 0);
  assert.equal(result.offset, fs.statSync(file).size);
  assert.equal(result.atStart, true);
  assert.equal(result.events.length, 1);
});

test('readConversation defaults to the tail when no window is asked for', () => {
  const file = transcript(turn('a', null, 'one'));
  assert.deepEqual(readConversation(file).events.map((e) => e.uuid), ['a']);
});

test('readConversation after returns only what was appended', () => {
  const file = transcript(turn('a', null, 'one'));
  const { offset } = readConversation(file, { tail: true });
  fs.appendFileSync(file, turn('b', 'a', 'two', 'assistant'));
  const result = readConversation(file, { after: offset });
  assert.deepEqual(result.events.map((e) => e.uuid), ['b']);
  assert.equal(result.from, offset);
  assert.equal(result.offset, fs.statSync(file).size);
});

// A file that shrank under the caller's offset is a different file at the
// same path, and readAppendedLines starts over at byte 0 for it. The
// response has to say so, or the client stacks the new conversation under
// the old one.
test('readConversation after an offset past the end reads from the start', () => {
  const file = transcript(turn('a', null, 'one') + turn('b', 'a', 'two', 'assistant'));
  const size = fs.statSync(file).size;
  fs.writeFileSync(file, turn('c', null, 'fresh'));
  const result = readConversation(file, { after: size });
  assert.equal(result.from, 0);
  assert.equal(result.atStart, true);
  assert.deepEqual(result.events.map((e) => e.uuid), ['c']);
});

test('readConversation before returns the window above and flags the start', () => {
  const first = turn('a', null, 'one');
  const file = transcript(first + turn('b', 'a', 'two', 'assistant'));
  const result = readConversation(file, { before: Buffer.byteLength(first) });
  assert.deepEqual(result.events.map((e) => e.uuid), ['a']);
  assert.equal(result.atStart, true);
});

test('readConversation before a window that is not the file start does not claim atStart', () => {
  let body = '';
  for (let i = 0; i < 3; i++) body += turn(`u${i}`, i === 0 ? null : `u${i - 1}`, 'x'.repeat(200));
  const file = transcript(body);
  const result = readConversation(file, { before: fs.statSync(file).size, windowBytes: 120 });
  assert.equal(result.atStart, false);
});

test('TAIL_BYTES is the documented half megabyte', () => {
  assert.equal(TAIL_BYTES, 512 * 1024);
});

// A window that lands inside one line has no line end to cut on and comes
// back empty. Both directions have to widen for it: a transcript whose last
// line is bigger than the window would otherwise show an empty
// conversation, and paging upwards would spend one round trip per window
// width to cross it.
test('readConversation tail widens until a line longer than the window is in', () => {
  const file = transcript(turn('a', null, 'one') + turn('big', 'a', 'x'.repeat(5000), 'assistant'));
  const result = readConversation(file, { tail: true, windowBytes: 500 });
  assert.ok(result.events.map((e) => e.uuid).includes('big'), 'the long line was rendered');
});

test('readConversation before widens until a line longer than the window is in', () => {
  const head = turn('a', null, 'one') + turn('big', 'a', 'x'.repeat(5000), 'assistant');
  const file = transcript(head + turn('c', 'big', 'three'));
  const result = readConversation(file, { before: Buffer.byteLength(head), windowBytes: 500 });
  assert.deepEqual(result.events.map((e) => e.uuid), ['a', 'big']);
  assert.equal(result.atStart, true);
});

// What a response reports as `[from, offset)` has to be whole lines. One
// byte too far and the next poll starts inside the line Claude Code is
// writing: the fragment before the first newline never parses, and that turn
// is gone from every window there will ever be.
function assertWholeLines(file, result, label) {
  const bytes = fs.readFileSync(file);
  assert.ok(result.offset === 0 || bytes[result.offset - 1] === 0x0a,
    `${label}: offset ${result.offset} on a line end`);
  assert.ok(result.from === 0 || bytes[result.from - 1] === 0x0a,
    `${label}: from ${result.from} on a line start`);
}

const fragment = '{"type":"assistant","uuid":"c","parentUuid":"b","message":{"content":"ha';

test('readConversation stops at the last line end of a file that ends mid-line', () => {
  const complete = turn('a', null, 'one') + turn('b', 'a', 'two', 'assistant');
  const file = transcript(complete + fragment);
  const result = readConversation(file, { tail: true });
  assert.equal(result.offset, Buffer.byteLength(complete));
  assert.deepEqual(result.events.map((e) => e.uuid), ['a', 'b']);
  assertWholeLines(file, result, 'tail over a trailing fragment');
});

test('readConversation delivers a line that was still being written exactly once', () => {
  const file = transcript(turn('a', null, 'one') + turn('b', 'a', 'two', 'assistant') + fragment);
  const { offset } = readConversation(file, { tail: true });
  fs.appendFileSync(file, 'lf"}}\n');
  const poll = readConversation(file, { after: offset });
  assert.deepEqual(poll.events.map((e) => e.uuid), ['c']);
  assertWholeLines(file, poll, 'poll over the completed line');
  assert.deepEqual(readConversation(file, { after: poll.offset }).events, []);
});

test('every path reports whole lines, over a fragment and over an overlong line', () => {
  const cases = [
    ['ends mid-line', turn('a', null, 'one') + turn('b', 'a', 'two', 'assistant') + fragment],
    ['last line wider than the window', turn('a', null, 'one') + turn('big', 'a', 'x'.repeat(5000), 'assistant')],
  ];
  for (const [label, body] of cases) {
    const file = transcript(body);
    const tail = readConversation(file, { tail: true, windowBytes: 500 });
    assertWholeLines(file, tail, `${label}: tail`);
    assertWholeLines(file, readConversation(file, { after: 0 }), `${label}: after`);
    assertWholeLines(file, readConversation(file, { before: tail.offset, windowBytes: 500 }), `${label}: before`);
  }
});

// A poll window's last line is not the file's, so a walk that starts there
// retracts against a chain the session is not on - and the client never asks
// for those bytes again. Here the whole fork arrives in one poll: `p` is the
// fork point, `r1` the rewound turn the window ends on.
test('readConversation after never filters, however much one poll holds', () => {
  const file = transcript(turn('root', null, 'earlier'));
  const { offset } = readConversation(file, { tail: true });
  fs.appendFileSync(file, turn('p', 'root', 'the fork point')
    + turn('a1', 'p', 'kept one', 'assistant')
    + turn('a2', 'a1', 'kept two')
    + turn('r1', 'p', 'rewound', 'assistant'));
  const poll = readConversation(file, { after: offset });
  assert.deepEqual(poll.events.map((e) => e.uuid), ['p', 'a1', 'a2', 'r1']);
  assert.equal(poll.abandoned, 0);
  // What the poll would have hidden: the session comes back to a2, and a
  // read that sees the whole file drops r1 instead of a1 and a2.
  fs.appendFileSync(file, turn('u3', 'a2', 'the session came back'));
  const whole = readConversation(file, { tail: true });
  assert.deepEqual(whole.events.map((e) => e.uuid), ['root', 'p', 'a1', 'a2', 'u3']);
  assert.equal(whole.abandoned, 1);
});

// Which window is read and whether it may filter hang on one predicate. Two
// would let a `before` sent alongside hand a poll window the older window's
// filter - unreachable through the route today, and a range read would walk
// straight into it. `a2` is the anchor that would prove the difference: with
// it, a filtered walk retracts r1.
test('readConversation after leaves abandoned at 0 whatever is passed beside it', () => {
  const file = transcript(turn('root', null, 'earlier'));
  const { offset } = readConversation(file, { tail: true });
  fs.appendFileSync(file, turn('p', 'root', 'the fork point')
    + turn('a1', 'p', 'kept one', 'assistant')
    + turn('a2', 'a1', 'kept two')
    + turn('r1', 'p', 'rewound', 'assistant'));
  const size = fs.statSync(file).size;
  for (const beside of [{}, { anchor: 'a2' }, { before: size }, { before: size, anchor: 'a2' }]) {
    const poll = readConversation(file, { after: offset, ...beside });
    const label = JSON.stringify(beside);
    assert.deepEqual(poll.events.map((e) => e.uuid), ['p', 'a1', 'a2', 'r1'], label);
    assert.equal(poll.abandoned, 0, label);
  }
});

// An offset that is not a line boundary is not a cursor into this file.
test('readConversation after a cursor that is not a line boundary reads from the start', () => {
  const file = transcript(turn('a', null, 'one') + turn('b', 'a', 'two', 'assistant'));
  const result = readConversation(file, { after: 1 });
  assert.equal(result.from, 0);
  assert.equal(result.atStart, true);
  assert.deepEqual(result.events.map((e) => e.uuid), ['a', 'b']);
});

test('readConversation after a cursor into a transcript rewritten in place reads from the start', () => {
  const first = turn('u0', null, 'old one');
  const file = transcript(first + turn('u1', 'u0', 'old two', 'assistant'));
  fs.writeFileSync(file, turn('n0', null, 'a different conversation at the same path')
    + turn('n1', 'n0', 'and its answer', 'assistant'));
  const result = readConversation(file, { after: Buffer.byteLength(first) });
  assert.equal(result.from, 0);
  assert.equal(result.atStart, true);
  assert.deepEqual(result.events.map((e) => e.uuid), ['n0', 'n1']);
});

// Only reachable from a second caller - the route rejects both - but a
// negative bound must not become a negative offset or an fs error.
test('readConversation takes a negative window bound as the start of the file', () => {
  const file = transcript(turn('a', null, 'one'));
  const back = readConversation(file, { before: -5 });
  assert.equal(back.from, 0);
  assert.equal(back.offset, 0);
  assert.deepEqual(back.events, []);
  const forward = readConversation(file, { after: -3 });
  assert.equal(forward.from, 0);
  assert.deepEqual(forward.events.map((e) => e.uuid), ['a']);
});

test('readConversation reports the last permission mode a tail read saw', () => {
  const file = transcript(
    turn('a', null, 'one')
    + line({ type: 'permission-mode', permissionMode: 'plan', sessionId: SESSION })
    + line({ type: 'permission-mode', permissionMode: 'auto', sessionId: SESSION }),
  );
  assert.equal(readConversation(file, { tail: true }).permissionMode, 'auto');
});

test('readConversation reports no permission mode for a transcript that names none', () => {
  const file = transcript(turn('a', null, 'one'));
  assert.equal(readConversation(file, { tail: true }).permissionMode, null);
});

// In a window that is not the tail, the queue under-reports (an enqueue
// above the window is invisible) and the mode is usually absent. Leaving
// both fields out says "unknown"; a null would read as "empty queue, no
// mode".
test('readConversation carries queue and mode on a tail read', () => {
  const file = transcript(
    turn('a', null, 'one')
    + line({ type: 'queue-operation', operation: 'enqueue', content: 'later' })
    + line({ type: 'permission-mode', permissionMode: 'plan', sessionId: SESSION }),
  );
  const result = readConversation(file, { tail: true });
  assert.deepEqual(result.queue, { waiting: [{ content: 'later' }] });
  assert.equal(result.permissionMode, 'plan');
});

test('readConversation leaves queue and mode out of a before response', () => {
  const first = turn('a', null, 'one');
  const file = transcript(first + turn('b', 'a', 'two', 'assistant'));
  const result = readConversation(file, { before: Buffer.byteLength(first) });
  assert.equal('queue' in result, false);
  assert.equal('permissionMode' in result, false);
});

test('readConversation leaves queue and mode out of an after response', () => {
  const file = transcript(turn('a', null, 'one'));
  const { offset } = readConversation(file, { tail: true });
  fs.appendFileSync(file, turn('b', 'a', 'two', 'assistant'));
  const result = readConversation(file, { after: offset });
  assert.equal('queue' in result, false);
  assert.equal('permissionMode' in result, false);
});

// u0 is the fork: b0 hangs off it beside the live path, u1 continues on it.
// One turn away from the anchor on purpose - a branch beside the anchor
// itself is not judgeable, since the window below is what holds the line the
// chain arrived from. The first three turns are padded so a 200 byte window
// provably holds the last two lines and provably cuts inside u1's.
const pad = '.'.repeat(400);
const forked = ''
  + turn('u0', null, `zero ${pad}`)
  + turn('b0', 'u0', `rewound ${pad}`, 'assistant')
  + turn('u1', 'u0', `one ${pad}`)
  + turn('u2', 'u1', 'two', 'assistant')
  + turn('u3', 'u2', 'three');

test('readConversation hands the uuid above its cut to the next window', () => {
  const file = transcript(forked);
  const tail = readConversation(file, { tail: true, windowBytes: 200 });
  assert.deepEqual(tail.events.map((e) => e.uuid), ['u2', 'u3']);
  assert.equal(tail.anchored, true);
  assert.equal(tail.chainAnchor, 'u1');
  assert.equal(tail.events.every((e) => e.uuid !== 'u1'), true, 'the anchor is not in the events');
});

// The oldest chain member of a window is regularly a line that produces no
// event at all, so the anchor cannot be read off the events array.
test('readConversation anchors on a line that carries no event', () => {
  const body = line({ type: 'system', uuid: 's1', parentUuid: null, content: `hook ran ${pad}` })
    + turn('u1', 's1', 'hi');
  const file = transcript(body);
  const result = readConversation(file, { tail: true, windowBytes: 40 });
  assert.deepEqual(result.events.map((e) => e.uuid), ['u1']);
  assert.equal(result.chainAnchor, 's1');
});

// Reading from byte 0 means there is nothing older, whatever parent the
// oldest line names - a compacted transcript names one that was never in
// this file.
test('readConversation reports no anchor for a window that began at byte 0', () => {
  const file = transcript(turn('u0', 'compacted-away', 'zero') + turn('u1', 'u0', 'one'));
  const result = readConversation(file, { tail: true });
  assert.equal(result.from, 0);
  assert.equal(result.chainAnchor, null);
});

test('readConversation before filters the rewound branch when it is given the anchor', () => {
  const file = transcript(forked);
  const tail = readConversation(file, { tail: true, windowBytes: 200 });
  const older = readConversation(file, { before: tail.from, anchor: tail.chainAnchor });
  assert.deepEqual(older.events.map((e) => e.uuid), ['u0', 'u1']);
  assert.equal(older.abandoned, 1);
});

// Without an anchor a backward walk would start at the window's last line -
// which is a branch nobody asked about, and filtering against it would hide
// real conversation.
test('readConversation before filters nothing when it has no anchor', () => {
  const file = transcript(forked);
  const tail = readConversation(file, { tail: true, windowBytes: 200 });
  const older = readConversation(file, { before: tail.from });
  assert.deepEqual(older.events.map((e) => e.uuid), ['u0', 'b0', 'u1']);
  assert.equal(older.abandoned, 0);
});

// Paging upwards must not lose conversation, and it must not hide more than
// a whole-file read would. Only equality is missing from that pair, on
// purpose: `chainAnchor` crosses a window boundary, the retracted set does
// not, so a rewound branch is filtered only in the window holding its fork.
test('windowed reads lose nothing and hide no more than a whole-file read', () => {
  let body = '';
  for (let i = 0; i < 40; i++) {
    body += turn(`u${i}`, i === 0 ? null : `u${i - 1}`, `turn ${i} ${'.'.repeat(60)}`, i % 2 ? 'assistant' : 'user');
    // A rewound turn and one hanging off it, mid-file.
    if (i === 10) {
      body += turn('b0', 'u10', `rewound ${'.'.repeat(60)}`, 'assistant');
      body += turn('b1', 'b0', `rewound follow-up ${'.'.repeat(60)}`);
    }
  }
  const file = transcript(body);
  const size = fs.statSync(file).size;
  const uuidsOf = (events) => new Set(events.map((e) => e.uuid));
  const bytes = fs.readFileSync(file);

  const whole = readConversation(file, { tail: true, windowBytes: size });
  assert.equal(whole.from, 0, 'precondition: the whole file was read in one window');
  const wholeShown = uuidsOf(whole.events);
  const wholeDropped = new Set(
    [...uuidsOf(conversationEvents(bytes.toString('utf8')))].filter((u) => !wholeShown.has(u)),
  );
  assert.ok(wholeDropped.size > 0, 'precondition: the whole-file read drops something');

  const shown = new Set();
  const dropped = new Set();
  let result = readConversation(file, { tail: true, windowBytes: 1500 });
  for (let step = 0; step < 200; step++) {
    // What this window held before the filter ran - the text is exactly the
    // bytes it reported reading, which is checked here rather than assumed.
    assertWholeLines(file, result, `window at ${result.from}`);
    const windowText = bytes.subarray(result.from, result.offset).toString('utf8');
    const visible = uuidsOf(result.events);
    for (const uuid of visible) shown.add(uuid);
    for (const uuid of uuidsOf(conversationEvents(windowText))) {
      if (!visible.has(uuid)) dropped.add(uuid);
    }
    if (result.atStart) break;
    const from = result.from;
    result = readConversation(file, { before: from, anchor: result.chainAnchor, windowBytes: 1500 });
    assert.ok(result.from < from, 'the walk upwards makes progress');
  }
  assert.equal(result.atStart, true, 'the walk upwards reached the start of the file');

  for (const uuid of wholeShown) {
    assert.ok(shown.has(uuid), `${uuid} survived windowing`);
  }
  for (const uuid of dropped) {
    assert.ok(wholeDropped.has(uuid), `${uuid} is hidden by the whole-file read too`);
  }
});
