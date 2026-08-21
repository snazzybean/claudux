import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationEvents, MAX_RESULT_CHARS, MAX_PATCH_HUNKS, MAX_PATCH_LINES_PER_HUNK, MAX_DETAIL_CHARS,
} from '../src/lib/sessionTranscript.js';

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
