import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentBlocks, readAgentBlocks, MAX_RESULT_CHARS } from '../src/lib/agentTranscript.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;

test('agentBlocks renders the agent own text as markdown', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking **styles.css**' }] } });
  const [block] = agentBlocks(jsonl);
  assert.equal(block.kind, 'text');
  assert.match(block.html, /<strong>styles\.css<\/strong>/);
});

// A thinking block is the agent reasoning with itself, not something it
// chose to say - and it is the bulkiest part of a transcript.
test('agentBlocks leaves thinking out', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } });
  assert.deepEqual(agentBlocks(jsonl), []);
});

test('agentBlocks turns a tool call into a name and its most telling argument', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'wc -l styles.css' } }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/srv/project/x.js' } }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Grep', input: { pattern: 'font-size' } }] } });
  assert.deepEqual(agentBlocks(jsonl).map((b) => [b.name, b.detail]), [
    ['Bash', 'wc -l styles.css'],
    ['Read', '/srv/project/x.js'],
    ['Grep', 'font-size'],
  ]);
});

test('agentBlocks attaches a tool result to the call it belongs to', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'wc -l' } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '2841 styles.css' }] } });
  const [block] = agentBlocks(jsonl);
  assert.equal(block.result, '2841 styles.css');
});

// A single result can be megabytes; it must not reach an HTTP response
// whole.
test('agentBlocks truncates a long tool result', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat big' } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(MAX_RESULT_CHARS + 500) }] } });
  const [block] = agentBlocks(jsonl);
  assert.equal(block.result.length, MAX_RESULT_CHARS);
});

// The tools that can return an image report their content as blocks rather
// than as one string.
test('agentBlocks reads a tool result made of blocks', () => {
  const jsonl =
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'x.png' } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'first' }, { type: 'image' }] }] } });
  assert.equal(agentBlocks(jsonl)[0].result, 'first');
});

test('agentBlocks skips a broken line instead of throwing', () => {
  const jsonl = '{"type":"assistant","mess\n' + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  assert.equal(agentBlocks(jsonl).length, 1);
});

test('readAgentBlocks reads only what the transcript grew by', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-at-'));
  const file = path.join(dir, 'agent-aaa111.jsonl');
  fs.writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }));
  const first = readAgentBlocks(file, 0);
  assert.equal(first.blocks.length, 1);

  fs.appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }));
  const second = readAgentBlocks(file, first.offset);
  assert.equal(second.blocks.length, 1);
  assert.match(second.blocks[0].html, /second/);
});

test('readAgentBlocks reports no blocks for a transcript that has not grown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-at-'));
  const file = path.join(dir, 'agent-aaa111.jsonl');
  fs.writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'only' }] } }));
  const { offset } = readAgentBlocks(file, 0);
  assert.deepEqual(readAgentBlocks(file, offset).blocks, []);
});

// A nested agent's spawning call is in its PARENT's transcript, never in the
// session's own - so this is the only place a card for one can be offered.
// Its files sit in the same directory, which is what makes the lookup the
// same one.
test('readAgentBlocks names the transcript of an agent this one spawned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-at-'));
  const file = path.join(dir, 'agent-aparent111.jsonl');
  fs.writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01AAA', name: 'Agent', input: { description: 'dig deeper', subagent_type: 'Explore' } }] } }));
  fs.writeFileSync(path.join(dir, 'agent-anested222.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_01AAA', parentAgentId: 'aparent111', spawnDepth: 2 }));
  const [block] = readAgentBlocks(file, 0).blocks;
  assert.equal(block.kind, 'tool');
  assert.equal(block.agentId, 'anested222');
});

// The session's cards resolve by name as well; a nested one has to, or a
// teammate started inside an agent could never be opened.
test('readAgentBlocks names a nested agent that ran under a name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-at-'));
  const file = path.join(dir, 'agent-aparent111.jsonl');
  fs.writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01AAA', name: 'Agent', input: { description: 'dig deeper', subagent_type: 'Explore', name: 'digger' } }] } }));
  fs.writeFileSync(path.join(dir, 'agent-adigger-2222.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'dig deeper', name: 'digger' }));
  const [block] = readAgentBlocks(file, 0).blocks;
  assert.equal(block.agentName, 'digger');
  assert.equal(block.agentType, 'Explore');
  assert.equal(block.agentId, 'adigger-2222');
});

// The card shows a different sentence for "several ran under this name" than
// for "nothing on disk names this call".
test('readAgentBlocks marks a nested name several agents ran under', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-at-'));
  const file = path.join(dir, 'agent-aparent111.jsonl');
  fs.writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01AAA', name: 'Agent', input: { description: 'dig deeper', name: 'digger' } }] } }));
  for (const id of ['adigger-1111', 'adigger-2222']) {
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'dig deeper', name: 'digger' }));
  }
  const [block] = readAgentBlocks(file, 0).blocks;
  assert.equal(block.agentId, null);
  assert.equal(block.agentAmbiguous, true);
});

test('readAgentBlocks leaves a spawning call unnamed when no meta claims it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-at-'));
  const file = path.join(dir, 'agent-aparent111.jsonl');
  fs.writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01AAA', name: 'Task', input: { description: 'dig deeper' } }] } }));
  assert.equal(readAgentBlocks(file, 0).blocks[0].agentId, null);
});

test('readAgentBlocks puts no agent id on an ordinary tool call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-at-'));
  const file = path.join(dir, 'agent-aparent111.jsonl');
  fs.writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01AAA', name: 'Bash', input: { command: 'ls' } }] } }));
  const [block] = readAgentBlocks(file, 0).blocks;
  assert.equal(block.agentId, undefined);
  assert.equal(block.agentType, undefined);
});
