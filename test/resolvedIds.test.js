import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolvedToolUseIds, createResolvedTracker } from '../src/lib/resolvedIds.js';

const line = (entry) => `${JSON.stringify(entry)}\n`;

test('resolvedToolUseIds collects tool_use_id from tool_result blocks', () => {
  const jsonl =
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'done' }] } });
  assert.deepEqual([...resolvedToolUseIds(jsonl)], ['toolu_1', 'toolu_2']);
});

test('resolvedToolUseIds ignores non-tool_result content and broken lines', () => {
  const jsonl = line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }) + '{ broken\n';
  assert.deepEqual([...resolvedToolUseIds(jsonl)], []);
});

// A finished agent's tool_result sits wherever the session happened to be
// when it returned - measured against a real 4.9 MB transcript on this
// host, every one of its 46 finished agents was 0.5-3 MB from the end, so
// none of them was resolvable from a tail read of any sane size.
test('createResolvedTracker finds a tool_result far beyond a tail-sized window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-rt-'));
  const transcript = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(transcript,
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_early', content: 'ok' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200 * 1024) }] } }));

  const tracker = createResolvedTracker();
  assert.equal(tracker.idsFor(transcript).has('toolu_early'), true);
});

test('createResolvedTracker keeps earlier ids when the transcript grows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-rt-'));
  const transcript = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(transcript, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }));

  const tracker = createResolvedTracker();
  tracker.idsFor(transcript);
  fs.appendFileSync(transcript, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } }));

  assert.deepEqual([...tracker.idsFor(transcript)].sort(), ['toolu_1', 'toolu_2']);
});

// These files are read while Claude Code writes them, so the last line is
// regularly incomplete. Consuming it would drop the very tool_result the
// scan is after, since the offset would move past a line that was never
// parsed.
test('createResolvedTracker picks up a line that was still being written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-rt-'));
  const transcript = path.join(dir, 'sess-1.jsonl');
  const complete = line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
  fs.writeFileSync(transcript, complete.slice(0, 30));

  const tracker = createResolvedTracker();
  assert.deepEqual([...tracker.idsFor(transcript)], []);
  fs.writeFileSync(transcript, complete);
  assert.deepEqual([...tracker.idsFor(transcript)], ['toolu_1']);
});

// A shorter file under the same path is a different file - after a /clear
// chooseTranscript may hand back a fresh, small transcript, and reading it
// from the old offset would never find anything again.
test('createResolvedTracker rescans from the start when the transcript shrank', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-rt-'));
  const transcript = path.join(dir, 'sess-1.jsonl');
  const long = line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'x'.repeat(4096) }] } });
  fs.writeFileSync(transcript, long);

  const tracker = createResolvedTracker();
  tracker.idsFor(transcript);
  fs.writeFileSync(transcript, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_new', content: 'ok' }] } }));

  assert.deepEqual([...tracker.idsFor(transcript)], ['toolu_new']);
});
