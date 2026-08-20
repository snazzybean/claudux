import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTrafficTracker } from '../src/lib/teamTraffic.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;

function tmpTranscript(contents = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tt-'));
  const file = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(file, contents);
  return file;
}

// Verbatim shapes from this host's own transcripts: a spawn names the agent
// in `name`, a later message names it in `to`.
const spawn = (name) => line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Agent', input: { name, subagent_type: 'general-purpose', prompt: '…' } }] },
});
const message = (to) => line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to, message: '…' } }] },
});

test('a spawn counts as the first message to that agent', () => {
  const tracker = createTrafficTracker();
  assert.deepEqual([...tracker.messagedSince(tmpTranscript(spawn('Vermessung')))], ['Vermessung']);
});

test('a SendMessage counts for its recipient', () => {
  const tracker = createTrafficTracker();
  assert.deepEqual([...tracker.messagedSince(tmpTranscript(message('Vermessung')))], ['Vermessung']);
});

// Only what happened since the last look: a pulse stands for one message, so
// reporting the same one every two seconds would make an idle line flash
// forever.
test('the same message is reported once', () => {
  const file = tmpTranscript(spawn('Vermessung'));
  const tracker = createTrafficTracker();
  tracker.messagedSince(file);
  assert.deepEqual([...tracker.messagedSince(file)], []);
  fs.appendFileSync(file, message('Vermessung'));
  assert.deepEqual([...tracker.messagedSince(file)], ['Vermessung']);
});

test('several recipients in one pass all count', () => {
  const tracker = createTrafficTracker();
  const file = tmpTranscript(spawn('Vermessung') + spawn('Kommentare') + message('Vermessung'));
  assert.deepEqual([...tracker.messagedSince(file)].sort(), ['Kommentare', 'Vermessung']);
});

// The lead is not an agent, and a window for it would have nothing behind it.
test('a message to the lead is not counted as one to an agent', () => {
  const tracker = createTrafficTracker();
  assert.deepEqual([...tracker.messagedSince(tmpTranscript(message('team-lead')))], []);
});

test('other tool calls and broken lines are ignored', () => {
  const tracker = createTrafficTracker();
  const file = tmpTranscript(
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })
    + '{"type":"assistant","mess\n',
  );
  assert.deepEqual([...tracker.messagedSince(file)], []);
});

test('a missing transcript reports nothing rather than throwing', () => {
  const tracker = createTrafficTracker();
  assert.deepEqual([...tracker.messagedSince('/nowhere/sess-9.jsonl')], []);
});
