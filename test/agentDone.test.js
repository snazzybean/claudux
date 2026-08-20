import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAppearsDone } from '../src/lib/agentDone.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;

test('agentAppearsDone accepts a last assistant turn that only answers', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is what I found.' }], stop_reason: 'end_turn' } });
  assert.equal(agentAppearsDone(jsonl), true);
});

test('agentAppearsDone rejects a last assistant turn that still calls a tool', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look.' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', input: {} }] } });
  assert.equal(agentAppearsDone(jsonl), false);
});

test('agentAppearsDone rejects a transcript without any assistant entry', () => {
  assert.equal(agentAppearsDone(line({ type: 'user', message: { content: [] } })), false);
  assert.equal(agentAppearsDone(''), false);
  assert.equal(agentAppearsDone(null), false);
});

test('agentAppearsDone falls back to the last VALID assistant entry on a broken line', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } })
    + '{"type":"assistant","message":{"con\n';
  assert.equal(agentAppearsDone(jsonl), true);
});

// The case caught in the browser: an agent reading a file in slices wrote
// a line of commentary between two Bash calls and was reported done in the
// middle of its work - and 'done' is sticky, so its node faded and never
// came back. A turn that has really ended says so in stop_reason.
test('agentAppearsDone rejects an answer that is still mid-turn', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] }, stop_reason: 'tool_use' })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now the next slice.' }], stop_reason: null } });
  assert.equal(agentAppearsDone(jsonl), false);
});

test('agentAppearsDone accepts every stop_reason that ends a turn', () => {
  for (const stop of ['end_turn', 'stop_sequence', 'max_tokens']) {
    const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }], stop_reason: stop } });
    assert.equal(agentAppearsDone(jsonl), true, stop);
  }
});
