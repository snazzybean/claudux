import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  conversationEvents, activeChain, segmentStarts, markAbandoned, queueState, conversationView,
  MAX_RESULT_CHARS, MAX_PATCH_HUNKS, MAX_PATCH_LINES_PER_HUNK, MAX_DETAIL_CHARS, MAX_EVENTS,
  MAX_QUEUE_CHARS,
} from '../src/lib/sessionTranscript.js';
import { readWindow } from '../src/lib/jsonlReader.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;

test('conversationEvents renders a user message as markdown', () => {
  const jsonl = line({
    type: 'user', uuid: 'u1', parentUuid: null, entrypoint: 'cli',
    message: { content: 'look at **styles.css**' },
  });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.kind, 'user');
  assert.equal(event.uuid, 'u1');
  assert.match(event.html, /<strong>styles\.css<\/strong>/);
});

test('conversationEvents keeps thinking as its own kind instead of dropping it', () => {
  const jsonl = line({
    type: 'assistant', uuid: 'a1', parentUuid: 'u1', entrypoint: 'cli',
    message: { content: [{ type: 'thinking', thinking: 'weighing options' }] },
  });
  assert.deepEqual(conversationEvents(jsonl).map((e) => e.kind), ['thinking']);
});

test('conversationEvents pairs a tool call with its result', () => {
  const jsonl =
    line({ type: 'assistant', uuid: 'a1', parentUuid: null, entrypoint: 'cli',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] } })
    + line({ type: 'user', uuid: 'u2', parentUuid: 'a1', entrypoint: 'cli',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 0' }] } });
  const events = conversationEvents(jsonl);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].name, 'Bash');
  assert.equal(events[0].detail, 'ls -la');
  assert.equal(events[0].result, 'total 0');
  assert.equal(events[0].resultLoaded, true);
});

// A call whose result sits beyond the window must not read as "still
// running" - that would be a lie about the state.
test('conversationEvents marks a call without a result as not loaded', () => {
  const jsonl = line({ type: 'assistant', uuid: 'a1', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x/y.js' } }] } });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.result, null);
  assert.equal(event.resultLoaded, false);
});

test('conversationEvents keeps a result whose call is outside the window', () => {
  const jsonl = line({ type: 'user', uuid: 'u2', parentUuid: 'a1', entrypoint: 'cli',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'orphan output' }] } });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.kind, 'toolResult');
  assert.equal(event.toolUseId, 'toolu_9');
  assert.equal(event.result, 'orphan output');
});

test('conversationEvents turns a structuredPatch into a diff event', () => {
  const jsonl = line({
    type: 'user', uuid: 'u3', parentUuid: 'a2', entrypoint: 'cli',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'done' }] },
    toolUseResult: {
      type: 'update', filePath: '/project/app.js',
      structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }],
    },
  });
  const diff = conversationEvents(jsonl).find((e) => e.kind === 'diff');
  assert.equal(diff.filePath, '/project/app.js');
  assert.deepEqual(diff.patch, [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }]);
  assert.equal(diff.toolUseId, 'toolu_2');
  assert.equal(diff.patchTruncated, false);
});

test('conversationEvents turns a Task call into a subagent event', () => {
  const jsonl = line({ type: 'assistant', uuid: 'a3', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Task',
      input: { subagent_type: 'Explore', description: 'find the callers' } }] } });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.kind, 'task');
  assert.equal(event.agentType, 'Explore');
  assert.equal(event.description, 'find the callers');
});

// The tool that spawns a subagent was renamed. Both names have to reach the
// same event, or a card appears for one of them only.
test('conversationEvents reads Task and Agent as the same subagent event', () => {
  const spawn = (name) => line({ type: 'assistant', uuid: 'a3', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id: 'toolu_3', name,
      input: { subagent_type: 'Explore', description: 'find the callers' } }] } });
  const [fromAgent] = conversationEvents(spawn('Agent'));
  assert.equal(fromAgent.kind, 'task');
  assert.equal(fromAgent.agentType, 'Explore');
  assert.equal(fromAgent.toolUseId, 'toolu_3');
  assert.deepEqual(conversationEvents(spawn('Task')), [fromAgent]);
});

// A teammate spawned under a name gets no call id in its meta file, so the
// name is the only thing that can lead from this event to its transcript.
test('conversationEvents carries the name a teammate was spawned under', () => {
  const jsonl = line({ type: 'assistant', uuid: 'a3', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Agent',
      input: { subagent_type: 'general-purpose', description: 'measure it', name: 'probe-run' } }] } });
  assert.equal(conversationEvents(jsonl)[0].name, 'probe-run');
});

test('conversationEvents leaves the name empty for an unnamed subagent', () => {
  const jsonl = line({ type: 'assistant', uuid: 'a3', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find the callers' } }] } });
  assert.equal(conversationEvents(jsonl)[0].name, '');
});

test('conversationEvents turns TodoWrite into a todos event', () => {
  const jsonl = line({ type: 'assistant', uuid: 'a4', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id: 'toolu_4', name: 'TodoWrite',
      input: { todos: [{ content: 'write the test', status: 'in_progress' }] } }] } });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.kind, 'todos');
  assert.deepEqual(event.todos, [{ content: 'write the test', status: 'in_progress' }]);
});

test('conversationEvents leaves out sidechain lines and control markup', () => {
  const jsonl =
    line({ type: 'assistant', uuid: 's1', parentUuid: null, isSidechain: true, entrypoint: 'cli',
      message: { content: [{ type: 'text', text: 'subagent talking' }] } })
    + line({ type: 'last-prompt', leafUuid: 'x', lastPrompt: 'hi' })
    + line({ type: 'ai-title', aiTitle: 'a title' })
    + line({ type: 'mode', mode: 'normal' })
    + line({ type: 'user', uuid: 'm1', parentUuid: null, isMeta: true, entrypoint: 'cli',
      message: { content: 'meta note' } });
  assert.deepEqual(conversationEvents(jsonl), []);
});

test('conversationEvents caps a huge tool result', () => {
  const jsonl =
    line({ type: 'assistant', uuid: 'a5', parentUuid: null, entrypoint: 'cli',
      message: { content: [{ type: 'tool_use', id: 'toolu_5', name: 'Bash', input: { command: 'cat big' } }] } })
    + line({ type: 'user', uuid: 'u5', parentUuid: 'a5', entrypoint: 'cli',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_5', content: 'x'.repeat(MAX_RESULT_CHARS + 500) }] } });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.result.length, MAX_RESULT_CHARS);
});

// `system` lines carry uuid/parentUuid but no message - a later task
// needs them in the parent index, so they must fall through to "no event"
// on their own rather than via SKIP_TYPES.
test('conversationEvents produces no event for a system line', () => {
  const jsonl = line({ type: 'system', uuid: 's2', parentUuid: 'u1' });
  assert.deepEqual(conversationEvents(jsonl), []);
});

test('conversationEvents survives a half-written last line', () => {
  const jsonl = line({
    type: 'user', uuid: 'u6', parentUuid: null, entrypoint: 'cli',
    message: { content: 'complete' },
  }) + '{"type":"assis';
  assert.deepEqual(conversationEvents(jsonl).map((e) => e.kind), ['user']);
});

// Correction 3 (constraints.md): a structuredPatch line IS the tool_result
// line for the Edit/Write call it belongs to. If the diff branch does not
// also resolve the pending call, that call's card is stuck reading "Result
// not loaded" even though the result did arrive - exactly the lie the spec
// forbids.
test('conversationEvents resolves the pending Edit call when its result is a structuredPatch line', () => {
  const jsonl =
    line({ type: 'assistant', uuid: 'a6', parentUuid: null, entrypoint: 'cli',
      message: { content: [{ type: 'tool_use', id: 'toolu_014W', name: 'Edit',
        input: { file_path: '/example/app.js' } }] } })
    + line({
      type: 'user', uuid: 'u7', parentUuid: 'a6', entrypoint: 'cli',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_014W', type: 'tool_result',
        content: 'The file /example/app.js has been updated successfully.' }] },
      toolUseResult: {
        filePath: '/example/app.js', oldString: 'old', newString: 'new', originalFile: 'old file',
        structuredPatch: [{ oldStart: 10, oldLines: 6, newStart: 10, newLines: 7, lines: ['-old', '+new'] }],
        userModified: false, replaceAll: false,
      },
    });
  const events = conversationEvents(jsonl);
  const tool = events.find((e) => e.kind === 'tool');
  const diff = events.find((e) => e.kind === 'diff');
  assert.ok(tool, 'expected a tool event');
  assert.equal(tool.resultLoaded, true);
  assert.ok(diff, 'expected a diff event alongside the resolved tool event');
  assert.equal(diff.toolUseId, 'toolu_014W');
  assert.equal(events.some((e) => e.kind === 'toolResult'), false);
});

test('conversationEvents still emits the diff when its call is outside the window', () => {
  const jsonl = line({
    type: 'user', uuid: 'u8', parentUuid: 'a7', entrypoint: 'cli',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_orphan', type: 'tool_result',
      content: 'The file /example/other.js has been updated successfully.' }] },
    toolUseResult: {
      filePath: '/example/other.js',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      userModified: false, replaceAll: false,
    },
  });
  const events = conversationEvents(jsonl);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'diff');
  assert.equal(events[0].filePath, '/example/other.js');
  assert.equal(events[0].toolUseId, 'toolu_orphan');
  assert.equal(events.some((e) => e.kind === 'toolResult'), false);
});

// A patch line's tool_result content can genuinely have no tool_use_id at
// all - the diff still has to render, just without a call to pair with.
test('conversationEvents allows a diff with no toolUseId when the line carries none', () => {
  const jsonl = line({
    type: 'user', uuid: 'u10', parentUuid: null, entrypoint: 'cli',
    message: { content: [] },
    toolUseResult: {
      filePath: '/example/none.js',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    },
  });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.kind, 'diff');
  assert.equal(event.toolUseId, null);
});

// A structuredPatch line's content array usually holds only the
// tool_result part, but a stray part beside it must not be silently
// dropped along with it.
test('conversationEvents keeps a stray text part beside a structuredPatch tool_result', () => {
  const jsonl = line({
    type: 'user', uuid: 'u11', parentUuid: 'a8', entrypoint: 'cli',
    message: {
      content: [
        { type: 'text', text: 'a note beside the patch' },
        { type: 'tool_result', tool_use_id: 'toolu_11', content: 'done' },
      ],
    },
    toolUseResult: {
      filePath: '/example/note.js',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    },
  });
  const events = conversationEvents(jsonl);
  assert.deepEqual(events.map((e) => e.kind).sort(), ['diff', 'user']);
  const text = events.find((e) => e.kind === 'user');
  assert.match(text.html, /a note beside the patch/);
});

test('conversationEvents truncates a patch with too many hunks and marks it', () => {
  const hunks = Array.from({ length: MAX_PATCH_HUNKS + 3 }, (_, i) => (
    { oldStart: i, oldLines: 1, newStart: i, newLines: 1, lines: ['-a', '+b'] }
  ));
  const jsonl = line({
    type: 'user', uuid: 'u12', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_12', content: 'done' }] },
    toolUseResult: { filePath: '/example/many.js', structuredPatch: hunks },
  });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.patch.length, MAX_PATCH_HUNKS);
  assert.equal(event.patchTruncated, true);
});

test('conversationEvents truncates a hunk with too many lines and marks it', () => {
  const longHunk = {
    oldStart: 1, oldLines: MAX_PATCH_LINES_PER_HUNK + 50, newStart: 1, newLines: MAX_PATCH_LINES_PER_HUNK + 50,
    lines: Array.from({ length: MAX_PATCH_LINES_PER_HUNK + 50 }, (_, i) => `+line ${i}`),
  };
  const jsonl = line({
    type: 'user', uuid: 'u13', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_13', content: 'done' }] },
    toolUseResult: { filePath: '/example/long.js', structuredPatch: [longHunk] },
  });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.patch[0].lines.length, MAX_PATCH_LINES_PER_HUNK);
  assert.equal(event.patchTruncated, true);
});

// .slice(0, MAX_RESULT_CHARS) alone can land the cut between the two code
// units of a surrogate pair (an emoji, for instance), leaving a lone high
// surrogate dangling at the end of the string.
test('conversationEvents does not split a surrogate pair at the result cap', () => {
  const prefix = 'a'.repeat(MAX_RESULT_CHARS - 1);
  const jsonl =
    line({ type: 'assistant', uuid: 'a9', parentUuid: null, entrypoint: 'cli',
      message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'echo hi' } }] } })
    + line({ type: 'user', uuid: 'u9', parentUuid: 'a9', entrypoint: 'cli',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: `${prefix}\u{1F600}bbbbbbbbbb` }] } });
  const [event] = conversationEvents(jsonl);
  const lastCode = event.result.charCodeAt(event.result.length - 1);
  assert.ok(lastCode < 0xd800 || lastCode > 0xdbff, 'must not end on a lone high surrogate');
});

test('conversationEvents caps a long tool detail to one summary line', () => {
  const jsonl = line({ type: 'assistant', uuid: 'a10', parentUuid: null, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id: 'toolu_10', name: 'Bash',
      input: { command: 'x'.repeat(MAX_DETAIL_CHARS + 500) } }] } });
  const [event] = conversationEvents(jsonl);
  assert.equal(event.detail.length, MAX_DETAIL_CHARS);
});

// --- the tree, its segments and the queue ---------------------------------

// A transcript shaped like the real ones on this host: the tree's root is a
// line that carries no message at all, a second root marks a fresh start,
// and each segment carries a branch that was rewound away. `filler` pads
// every line so a byte window holds a known handful of them; `fat` blows one
// line up past a window's width.
function forkedTranscript({ filler = '', fat = 0 } = {}) {
  const say = (uuid, parentUuid, type, text) => line({
    type, uuid, parentUuid, entrypoint: 'cli', message: { content: `${text} ${filler}` },
  });
  return [
    line({ type: 'attachment', uuid: 'att', parentUuid: null }),
    say('u1', 'att', 'user', 'first question'),
    say('a1', 'u1', 'assistant', 'first answer'),
    say('x1', 'a1', 'user', 'rewound inside the first segment'),
    say('u2', 'a1', 'user', 'second question'),
    say('a2', 'u2', 'assistant', 'second answer'),
    line({ type: 'system', uuid: 'root2', parentUuid: null }),
    say('u3', 'root2', 'user', 'a question after the fresh start'),
    say('a3', 'u3', 'assistant', `an answer after the fresh start ${'z'.repeat(fat)}`),
    say('x2', 'a3', 'user', 'rewound away'),
    say('x3', 'x2', 'assistant', 'the answer to the rewound turn'),
    say('u4', 'a3', 'user', 'the live turn'),
    say('a4', 'u4', 'assistant', 'the live answer'),
    line({ type: 'system', uuid: 'sys9', parentUuid: 'a4' }),
    line({ type: 'queue-operation', operation: 'enqueue', content: 'still waiting' }),
    line({ type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: 'fixture-session' }),
  ].join('');
}

// The line that was written last belongs to the branch the session is on.
test('activeChain walks back from the last line of the file', () => {
  const jsonl =
    line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'one' } })
    + line({ type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: 'two' } })
    + line({ type: 'user', uuid: 'x', parentUuid: 'a', message: { content: 'abandoned branch' } })
    + line({ type: 'user', uuid: 'c', parentUuid: 'b', message: { content: 'three' } });
  const walk = activeChain(jsonl);
  assert.deepEqual([...walk.chain].sort(), ['a', 'b', 'c']);
  assert.equal(walk.segmentStart, 'a');
  assert.equal(walk.chainAnchor, null);
  assert.equal(walk.anchored, true);
});

// Neither a `system` nor an `attachment` line produces an event, and they
// are regularly the file's last line and the tree's root - a chain built
// from events would break at both ends.
test('activeChain anchors on a system line and roots on an attachment line', () => {
  const walk = activeChain(forkedTranscript());
  assert.equal(walk.anchored, true);
  assert.deepEqual([...walk.chain], ['sys9', 'a4', 'u4', 'a3', 'u3', 'root2']);
  assert.equal(walk.segmentStart, 'root2');
  // Both segments carry a rewound branch; only the live segment's counts,
  // because only its fork point sits on the path.
  assert.deepEqual([...walk.retracted], ['x2', 'x3']);
});

test('activeChain starts from an explicit anchor instead of the last line', () => {
  const jsonl =
    line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'one' } })
    + line({ type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: 'two' } })
    + line({ type: 'user', uuid: 'x', parentUuid: 'a', message: { content: 'a branch of its own' } });
  const walk = activeChain(jsonl, { anchor: 'b' });
  assert.deepEqual([...walk.chain].sort(), ['a', 'b']);
  assert.equal(walk.segmentStart, 'a');
});

// A window in the middle of the file holds no root: the walk runs out of
// parents and has to say which one it was looking for, so the next window
// back can carry on from there.
test('activeChain reports the parent it ran out on as the next anchor', () => {
  const jsonl =
    line({ type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: 'two' } })
    + line({ type: 'user', uuid: 'c', parentUuid: 'b', message: { content: 'three' } });
  const walk = activeChain(jsonl);
  assert.deepEqual([...walk.chain].sort(), ['b', 'c']);
  assert.equal(walk.segmentStart, null);
  assert.equal(walk.chainAnchor, 'a');
});

// An anchor can be missing from a window that is too narrow to hold the
// line it sits on. Carrying it forward unchanged lets the next, wider
// window find it; reporting null would switch the filter off for the whole
// rest of the scrollback.
test('activeChain carries an unfound anchor forward and reports itself unanchored', () => {
  const jsonl = line({ type: 'user', uuid: 'c', parentUuid: 'b', message: { content: 'three' } });
  const walk = activeChain(jsonl, { anchor: 'somewhere-else' });
  assert.equal(walk.anchored, false);
  assert.equal(walk.chainAnchor, 'somewhere-else');
  assert.deepEqual([...walk.chain], []);
});

test('segmentStarts finds every root in file order', () => {
  const jsonl =
    line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'first talk' } })
    + line({ type: 'user', uuid: 'b', parentUuid: 'a', message: { content: 'more' } })
    + line({ type: 'user', uuid: 'c', parentUuid: null, message: { content: 'after a compact' } });
  assert.deepEqual(segmentStarts(jsonl), ['a', 'c']);
});

// A line with a null parent and no uuid of its own is not a root - it has
// no identity to be one with.
test('segmentStarts ignores a null-parent line that carries no uuid', () => {
  const jsonl =
    line({ type: 'attachment', parentUuid: null, content: 'a pasted file' })
    + line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'the real root' } });
  assert.deepEqual(segmentStarts(jsonl), ['a']);
});

// The big mistake would be hiding everything before a second root: that is
// real conversation, not an abandoned branch.
test('markAbandoned keeps a whole earlier segment and drops only real siblings', () => {
  const jsonl =
    line({ type: 'user', uuid: 'a', parentUuid: null, message: { content: 'segment one' } })
    + line({ type: 'user', uuid: 'b', parentUuid: 'a', message: { content: 'still segment one' } })
    + line({ type: 'user', uuid: 'c', parentUuid: null, message: { content: 'segment two' } })
    + line({ type: 'user', uuid: 'd', parentUuid: 'c', message: { content: 'rewound away' } })
    + line({ type: 'user', uuid: 'e', parentUuid: 'c', message: { content: 'the live one' } });
  const result = markAbandoned(conversationEvents(jsonl), activeChain(jsonl));
  assert.deepEqual(result.events.map((e) => e.uuid), ['a', 'b', 'c', 'e']);
  assert.equal(result.abandoned, 1);
});

// The root of the live segment is usually a line that produces no event, so
// the boundary cannot be found by watching event uuids go past.
test('markAbandoned finds the segment boundary on a line that produces no event', () => {
  const jsonl = forkedTranscript();
  const result = markAbandoned(conversationEvents(jsonl), activeChain(jsonl));
  assert.deepEqual(result.events.map((e) => e.uuid), ['u1', 'a1', 'x1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
  assert.equal(result.abandoned, 2);
});

// A window that begins inside the live segment has no root of its own; every
// off-chain turn in it is a sibling that was rewound away.
test('markAbandoned filters a whole window whose segment start lies before it', () => {
  const jsonl =
    line({ type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: 'two' } })
    + line({ type: 'user', uuid: 'x', parentUuid: 'b', message: { content: 'rewound away' } })
    + line({ type: 'user', uuid: 'c', parentUuid: 'b', message: { content: 'the live one' } });
  const result = markAbandoned(conversationEvents(jsonl), activeChain(jsonl));
  assert.deepEqual(result.events.map((e) => e.uuid), ['b', 'c']);
  assert.equal(result.abandoned, 1);
});

test('markAbandoned keeps everything when the anchor was never found', () => {
  const jsonl =
    line({ type: 'user', uuid: 'x', parentUuid: 'b', message: { content: 'rewound away' } })
    + line({ type: 'user', uuid: 'c', parentUuid: 'b', message: { content: 'the live one' } });
  const result = markAbandoned(conversationEvents(jsonl), activeChain(jsonl, { anchor: 'not-in-here' }));
  assert.deepEqual(result.events.map((e) => e.uuid), ['x', 'c']);
  assert.equal(result.abandoned, 0);
});

test('queueState rebuilds what is waiting', () => {
  const jsonl =
    line({ type: 'queue-operation', operation: 'enqueue', content: 'first waiting' })
    + line({ type: 'queue-operation', operation: 'enqueue', content: 'second waiting' })
    + line({ type: 'queue-operation', operation: 'dequeue' });
  assert.deepEqual(queueState(jsonl).waiting, [{ content: 'second waiting' }]);
});

test('queueState removes a specific entry and empties on popAll', () => {
  const removed =
    line({ type: 'queue-operation', operation: 'enqueue', content: 'keep me' })
    + line({ type: 'queue-operation', operation: 'enqueue', content: 'take me back' })
    + line({ type: 'queue-operation', operation: 'remove', content: 'take me back' });
  assert.deepEqual(queueState(removed).waiting, [{ content: 'keep me' }]);

  const cleared = removed + line({ type: 'queue-operation', operation: 'popAll', content: 'keep me' });
  assert.deepEqual(queueState(cleared).waiting, []);
});

// Saying "one waiting message" without text beats inventing one.
test('queueState keeps a contentless entry as an unknown one', () => {
  const jsonl = line({ type: 'queue-operation', operation: 'enqueue' });
  assert.deepEqual(queueState(jsonl).waiting, [{ content: null }]);
});

// A `remove` whose `enqueue` sits outside the window has nothing to match.
// Dropping the head instead would report an empty queue while a message is
// waiting.
test('queueState ignores a remove it cannot match', () => {
  const jsonl =
    line({ type: 'queue-operation', operation: 'enqueue', content: 'still waiting' })
    + line({ type: 'queue-operation', operation: 'remove', content: 'enqueued in an older window' });
  assert.deepEqual(queueState(jsonl).waiting, [{ content: 'still waiting' }]);
});

// What gets queued is not always something a person typed: Claude Code
// queues its own task notifications, which are XML blobs.
test('queueState caps a queued blob and keeps a message at the cap whole', () => {
  const exact = line({ type: 'queue-operation', operation: 'enqueue', content: 'q'.repeat(MAX_QUEUE_CHARS) });
  assert.equal(queueState(exact).waiting[0].content.length, MAX_QUEUE_CHARS);

  const over = line({ type: 'queue-operation', operation: 'enqueue', content: 'q'.repeat(MAX_QUEUE_CHARS + 400) });
  assert.equal(queueState(over).waiting[0].content.length, MAX_QUEUE_CHARS);
});

test('conversationView caps the number of events and keeps the newest', () => {
  let jsonl = '';
  for (let i = 0; i < 250; i++) {
    jsonl += line({ type: 'user', uuid: `u${i}`, parentUuid: i === 0 ? null : `u${i - 1}`, message: { content: `m${i}` } });
  }
  const view = conversationView(jsonl);
  assert.equal(view.events.length, MAX_EVENTS);
  assert.equal(view.events.at(-1).uuid, 'u249');
});

test('conversationView reports the queue and every root beside the events', () => {
  const view = conversationView(forkedTranscript());
  assert.deepEqual(view.queue.waiting, [{ content: 'still waiting' }]);
  assert.deepEqual(view.segmentStarts, ['att', 'root2']);
  assert.equal(view.segmentStart, 'root2');
});

// A window paged past the root of the live segment has nothing left to
// judge: everything older than the root is conversation. Walking the tree
// anyway would anchor the next window's filter on a branch nobody asked
// about.
test('conversationView keeps every event and reports no anchor when told not to filter', () => {
  const jsonl = forkedTranscript();
  const view = conversationView(jsonl, { filtered: false });
  assert.deepEqual(view.events.map((e) => e.uuid), ['u1', 'a1', 'x1', 'u2', 'a2', 'u3', 'a3', 'x2', 'x3', 'u4', 'a4']);
  assert.equal(view.abandoned, 0);
  assert.equal(view.chainAnchor, null);
  assert.equal(view.anchored, false);

  // An anchor passed alongside it is handed back, not dropped: losing it
  // would break the chain for every window after this one.
  assert.equal(conversationView(jsonl, { anchor: 'u4', filtered: false }).chainAnchor, 'u4');
});

// A window's walk starts where the caller pointed it, and nothing in the
// window says how the chain arrived there - in a newer window it can be a
// resume marker that jumped over this branch. So the fork at the walk's own
// starting point is not judged.
test('activeChain does not judge the fork at the line it started from', () => {
  const jsonl =
    line({ type: 'user', uuid: 'fork', parentUuid: 'older', entrypoint: 'cli',
      message: { content: 'the line the caller anchored on' } })
    + line({ type: 'user', uuid: 'beside', parentUuid: 'fork', entrypoint: 'cli',
      message: { content: 'a branch beside the anchor' } });
  const walk = activeChain(jsonl, { anchor: 'fork' });
  assert.deepEqual([...walk.chain], ['fork']);
  assert.deepEqual([...walk.retracted], []);
  assert.equal(walk.chainAnchor, 'older');
});

// A parent link can name a line further down the file. The walk cannot
// follow that backwards, so a window it cuts through must keep what it
// could not reach - this is the shape that hid live conversation when
// everything off the path counted as abandoned.
test('activeChain keeps what a forward parent link put out of reach', () => {
  const windowText =
    line({ type: 'user', uuid: 'first', parentUuid: 'root', message: { content: 'a turn on the live path' } })
    + line({ type: 'user', uuid: 'old', parentUuid: 'later', message: { content: 'hangs off a line further down' } });
  const walk = activeChain(windowText, { anchor: 'old' });
  assert.equal(walk.anchored, true);
  assert.deepEqual([...walk.chain], ['old']);
  assert.deepEqual([...walk.retracted], []);
  assert.equal(walk.chainAnchor, 'later');
});

// A turn is only recognisable as taken back where its fork point is, and
// paging backwards reaches the fork after the turn that hangs off it. This
// is the direction to be wrong in: one turn too many on screen, never one
// missing.
test('markAbandoned keeps a rewound turn whose fork point lies outside the window', () => {
  const fork = line({ type: 'assistant', uuid: 'a', parentUuid: null, message: { content: 'the fork point' } });
  const rest =
    line({ type: 'user', uuid: 'x', parentUuid: 'a', message: { content: 'rewound away' } })
    + line({ type: 'user', uuid: 'c', parentUuid: 'a', message: { content: 'the live one' } });

  const whole = markAbandoned(conversationEvents(fork + rest), activeChain(fork + rest));
  assert.deepEqual(whole.events.map((e) => e.uuid), ['a', 'c']);
  assert.equal(whole.abandoned, 1);

  const window = markAbandoned(conversationEvents(rest), activeChain(rest, { anchor: 'c' }));
  assert.deepEqual(window.events.map((e) => e.uuid), ['x', 'c']);
  assert.equal(window.abandoned, 0);
});

// One request's tool calls are separate lines under one parent, and their
// results come back in whatever order they finish - so the call whose result
// landed last is the one on the path and its siblings hang off the same
// parent. They are one turn, not a fork.
test('activeChain keeps a live turn\'s parallel tool calls', () => {
  const request = 'req_fixture_a';
  const call = (uuid, parentUuid, id, command, req) => line({
    type: 'assistant', uuid, parentUuid, requestId: req, entrypoint: 'cli',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const result = (uuid, parentUuid, id, text) => line({
    type: 'user', uuid, parentUuid, entrypoint: 'cli',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });
  const jsonl = call('callA', 'turn', 'toolu_a', 'echo a', request)
    + call('callB', 'callA', 'toolu_b', 'echo b', request)
    + result('resB', 'callB', 'toolu_b', 'b')
    + result('resA', 'callA', 'toolu_a', 'a');

  const walk = activeChain(jsonl);
  assert.deepEqual([...walk.chain], ['resA', 'callA']);
  assert.deepEqual([...walk.retracted], []);
  const marked = markAbandoned(conversationEvents(jsonl), walk);
  assert.deepEqual(marked.events.map((e) => e.detail), ['echo a', 'echo b']);
  assert.deepEqual(marked.events.map((e) => e.resultLoaded), [true, true]);
  assert.equal(marked.abandoned, 0);

  // A turn re-generated after a rewind is a different request, so that fork
  // is still a fork.
  const rewound = call('callA', 'turn', 'toolu_a', 'echo a', request)
    + call('callB', 'callA', 'toolu_b', 'echo b', 'req_fixture_b')
    + result('resB', 'callB', 'toolu_b', 'b')
    + result('resA', 'callA', 'toolu_a', 'a');
  assert.deepEqual([...activeChain(rewound).retracted], ['callB', 'resB']);
});

// A session resumed after an interrupt writes a marker line parented to a
// turn from before the interrupt, so the walk reaches that turn through the
// marker rather than through the conversation. Everything done in between
// hangs off that same turn and is not a branch beside it.
test('activeChain keeps the work a resume marker jumps over', () => {
  const jsonl =
    line({ type: 'user', uuid: 'before', parentUuid: null, entrypoint: 'cli',
      message: { content: 'the turn the session was interrupted on' } })
    + line({ type: 'user', uuid: 'work1', parentUuid: 'before', entrypoint: 'cli',
      message: { content: 'work carried on after the interrupt' } })
    + line({ type: 'assistant', uuid: 'work2', parentUuid: 'work1', entrypoint: 'cli',
      message: { content: 'and more of it' } })
    + line({ type: 'user', uuid: 'resume', parentUuid: 'before', isMeta: true, entrypoint: 'cli',
      message: { content: 'Continue from where you left off.' } })
    + line({ type: 'assistant', uuid: 'after', parentUuid: 'resume', entrypoint: 'cli',
      message: { content: 'carrying on' } });

  const walk = activeChain(jsonl);
  assert.deepEqual([...walk.chain], ['after', 'resume', 'before']);
  assert.deepEqual([...walk.retracted], []);
  const marked = markAbandoned(conversationEvents(jsonl), walk);
  assert.deepEqual(marked.events.map((e) => e.uuid), ['before', 'work1', 'work2', 'after']);
  assert.equal(marked.abandoned, 0);
});

// --- the invariant: windows compose into the whole file -------------------

const identify = (event) => `${event.kind}:${event.uuid}`;

function tmpTranscript(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-st-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, contents);
  return file;
}

// What the route has to do, and the reason this is a test and not a note:
// the view starts at the end of the file and pages backwards, carrying the
// chain anchor from one window into the next. A window that comes back empty
// is widened until it holds a line end, which is also what pulls in a line
// too long to fit one window. An anchor the window does not contain is
// deliberately NOT chased: the walk's own start cannot be judged as a fork
// point anyway, so a missing anchor costs a little filtering and nothing
// else, while chasing one that can never be found - a parent named further
// down the file - reads the file back to byte 0. Once the walk reaches the
// root of the live segment the anchor comes back null: everything further
// back is conversation.
function pageBackwards(file, windowBytes) {
  const size = fs.statSync(file).size;
  const events = [];
  const seen = new Set();
  let to = size;
  let anchor = null;
  let tail = true;
  while (to > 0) {
    let width = windowBytes;
    let read;
    let view;
    for (;;) {
      read = readWindow(file, Math.max(0, to - width), to);
      view = tail ? conversationView(read.text) : conversationView(read.text, { anchor, filtered: anchor !== null });
      if (read.text !== '' || read.from === 0 || width >= size) break;
      width *= 2;
    }
    events.unshift(...view.events);
    for (const event of conversationEvents(read.text)) seen.add(identify(event));
    anchor = view.chainAnchor;
    tail = false;
    to = read.from;
  }
  return { events, seen };
}

// The property that holds at every window size, and the only one: paging
// backwards never hides what a whole-file run keeps, and every event in the
// file surfaces in some window. Equality of the two runs is NOT the
// property - only the anchor crosses a window boundary, never the set of
// retracted uuids, so a rewound branch is filtered in the window that holds
// its fork point and nowhere else.
function assertComposes(file, jsonl, windowBytes) {
  const whole = conversationView(jsonl);
  const composed = pageBackwards(file, windowBytes);
  const kept = new Set(composed.events.map(identify));

  const hidden = whole.events.map(identify).filter((id) => !kept.has(id));
  assert.deepEqual(hidden, [], 'windowing hid events a whole-file run keeps');

  const lost = conversationEvents(jsonl).map(identify).filter((id) => !composed.seen.has(id));
  assert.deepEqual(lost, [], 'events that no window ever read');

  return { whole, composed };
}

test('paging backwards never hides what a whole-file run keeps', () => {
  const jsonl = forkedTranscript({ filler: 'y'.repeat(120) });
  const file = tmpTranscript(jsonl);

  // Pinned, not just compared against itself: the earlier segment survives
  // whole (x1 included), only the rewound siblings of the live segment go.
  const { whole } = assertComposes(file, jsonl, 700);
  assert.deepEqual(whole.events.map((e) => e.uuid), ['u1', 'a1', 'x1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
  assert.equal(whole.abandoned, 2);
});

// The same, with one line wider than the window. Without the widening on an
// empty read that line is never read at all: readWindow drops the partial
// first line, and moving further back only ever yields another partial.
test('paging backwards holds up across a line wider than the window', () => {
  const jsonl = forkedTranscript({ filler: 'y'.repeat(120), fat: 3000 });
  const file = tmpTranscript(jsonl);

  const { composed } = assertComposes(file, jsonl, 700);
  assert.equal(composed.events.some((e) => e.uuid === 'a3'), true);
});
