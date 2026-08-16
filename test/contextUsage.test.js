// test/contextUsage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contextFromTranscript,
  windowFromModelEntry,
  resolveContext,
  findTranscriptPath,
  chooseTranscript,
  readTranscriptTail,
  contextForSession,
} from '../src/lib/contextUsage.js';

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function assistantWith(usage, extra = {}) {
  return line({ type: 'assistant', message: { model: 'claude-opus-5', usage }, ...extra });
}

test('contextFromTranscript sums input, cache_read, and cache_creation', () => {
  const jsonl = assistantWith({
    input_tokens: 5,
    output_tokens: 999, // does NOT count toward context - that's generated text
    cache_read_input_tokens: 100000,
    cache_creation_input_tokens: 20292,
  });
  assert.equal(contextFromTranscript(jsonl).tokens, 120297);
});

test('contextFromTranscript takes the last line, not the first', () => {
  const jsonl = assistantWith({ input_tokens: 10 }) + assistantWith({ input_tokens: 40 });
  assert.equal(contextFromTranscript(jsonl).tokens, 40);
});

// The session's model name lives ONLY here. settings.json carries its own
// entry, which can diverge from the running session.
test('contextFromTranscript reads the model name from the same line', () => {
  const jsonl = line({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 10 } } })
    + line({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 40 } } });
  assert.equal(contextFromTranscript(jsonl).model, 'claude-opus-5');
});

test('contextFromTranscript returns null as the model when the line names none', () => {
  const jsonl = line({ type: 'assistant', message: { usage: { input_tokens: 40 } } });
  assert.equal(contextFromTranscript(jsonl).model, null);
});

// Subagents write their own usage lines into the SAME JSONL, marked with
// isSidechain. Their context is not the session's.
test('contextFromTranscript ignores sidechain lines from subagents', () => {
  const jsonl = assistantWith({ input_tokens: 500000 })
    + assistantWith({ input_tokens: 3000 }, { isSidechain: true });
  assert.equal(contextFromTranscript(jsonl).tokens, 500000);
});

test('contextFromTranscript skips broken lines', () => {
  const jsonl = assistantWith({ input_tokens: 40 }) + '{ half a line\n';
  assert.equal(contextFromTranscript(jsonl).tokens, 40);
});

test('contextFromTranscript returns null when there is no assistant reply in it', () => {
  assert.deepEqual(contextFromTranscript(line({ type: 'user', message: { content: 'hi' } })), { tokens: null, model: null });
  assert.deepEqual(contextFromTranscript(''), { tokens: null, model: null });
});

// The JSONL only carries the model name without a 1M marker. The window size
// lives in the `model` entry of settings.json, there as "opus[1m]".
test('windowFromModelEntry recognizes the 1M window from the model entry', () => {
  assert.equal(windowFromModelEntry('opus[1m]'), 1000000);
  assert.equal(windowFromModelEntry('claude-opus-5[1m]'), 1000000);
});

test('windowFromModelEntry returns the default window without a marker', () => {
  assert.equal(windowFromModelEntry('opus'), 200000);
  assert.equal(windowFromModelEntry('claude-sonnet-5'), 200000);
});

test('windowFromModelEntry returns null when nothing is entered', () => {
  assert.equal(windowFromModelEntry(null), null);
  assert.equal(windowFromModelEntry(''), null);
});

test('resolveContext computes percent against the window', () => {
  const result = resolveContext({ tokens: 120297, modelEntry: 'opus[1m]' });
  assert.equal(result.contextWindow, 1000000);
  // Matches what the pane itself shows ("Context 12%") - hence pinned to one
  // decimal place.
  assert.equal(Math.round(result.percent * 10) / 10, 12.0);
});

// Above 200k tokens it can no longer be a 200K window - then the window size
// is settled, even without an entry in settings.json.
test('resolveContext recognizes the 1M window from the token count', () => {
  const result = resolveContext({ tokens: 350000, modelEntry: null });
  assert.equal(result.contextWindow, 1000000);
});

// Better the bare token count than a made-up percentage: at 50k tokens with
// an unknown model, it would be 25% or 5%, depending on the window.
test('resolveContext leaves out the percentage when the window is unclear', () => {
  const result = resolveContext({ tokens: 50000, modelEntry: null });
  assert.equal(result.tokens, 50000);
  assert.equal(result.percent, null);
  assert.equal(result.contextWindow, null);
});

test('resolveContext copes with a missing token count', () => {
  assert.deepEqual(resolveContext({ tokens: null, modelEntry: 'opus[1m]' }), {
    tokens: null,
    percent: null,
    contextWindow: 1000000,
  });
});

// Claude Code stores transcripts under ~/.claude/projects/<encoded-path>/.
// Claudux knows the project path, but the encoding is undocumented - so the
// file gets searched for instead of its path rebuilt.
test('findTranscriptPath finds the JSONL across all project directories', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  const project = path.join(claudeDir, 'projects', '-srv-project');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'abc-123.jsonl');
  fs.writeFileSync(file, '');
  assert.equal(findTranscriptPath(claudeDir, 'abc-123'), file);
});

test('findTranscriptPath returns null when the session does not exist', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  assert.equal(findTranscriptPath(claudeDir, 'does-not-exist'), null);
});

// A session ID turns into a file name here. A value like "../../etc/passwd"
// must never be able to lead out of the projects directory (same check as in
// sessionTokenFile.js).
test('findTranscriptPath rejects implausible session IDs', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  assert.equal(findTranscriptPath(claudeDir, '../../etc/passwd'), null);
});

test('findTranscriptPath copes without a projects directory', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  assert.equal(findTranscriptPath(claudeDir, 'abc-123'), null);
});

// After a /clear, Claude Code assigns a NEW session ID and writes to a NEW
// JSONL, while the tmux session keeps its name (see
// src/lib/sessionRegistry.js). Both files then sit side by side - the
// older one belongs to the conversation from before the /clear and would
// show a long-outdated context state.
test('chooseTranscript picks the most recently written among several IDs', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  const project = path.join(claudeDir, 'projects', '-srv-project');
  fs.mkdirSync(project, { recursive: true });
  const older = path.join(project, 'before-clear.jsonl');
  const newer = path.join(project, 'after-clear.jsonl');
  fs.writeFileSync(older, '');
  fs.writeFileSync(newer, '');
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(9000), new Date(9000));
  assert.equal(chooseTranscript(claudeDir, ['before-clear', 'after-clear']), newer);
  // The order of the candidates must not change anything - only the file counts.
  assert.equal(chooseTranscript(claudeDir, ['after-clear', 'before-clear']), newer);
});

test('chooseTranscript returns null when none of the IDs has a file', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tr-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  assert.equal(chooseTranscript(claudeDir, ['a', 'b']), null);
});

// ---------- Reading only the tail ----------
//
// The context number sits in the LAST assistant reply, but the transcripts
// here run to several megabytes - reading all of it to use its final line
// blocks the event loop for everyone else.

test('readTranscriptTail reads only the end of a large file, not all of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tail-'));
  const filePath = path.join(dir, 'big.jsonl');
  const first = line({ type: 'assistant', marker: 'FIRST-LINE', message: {} });
  const filler = Array.from({ length: 500 }, (_, i) => line({ type: 'user', i })).join('');
  const last = line({ type: 'assistant', marker: 'LAST-LINE', message: {} });
  fs.writeFileSync(filePath, first + filler + last);

  const tail = readTranscriptTail(filePath, 1024);

  assert.ok(tail.length <= 1024, `read ${tail.length} bytes, expected at most 1024`);
  assert.match(tail, /LAST-LINE/);
  assert.doesNotMatch(tail, /FIRST-LINE/);
});

// A chunk starts mid-line almost every time. That fragment has to go, or
// the first JSON.parse of the caller trips over it.
test('readTranscriptTail drops the truncated first line of the chunk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tail-'));
  const filePath = path.join(dir, 'big.jsonl');
  const filler = Array.from({ length: 500 }, (_, i) => line({ type: 'user', i })).join('');
  fs.writeFileSync(filePath, filler);

  const tail = readTranscriptTail(filePath, 1024);

  for (const l of tail.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(l), `unparsable line in tail: ${l}`);
  }
});

test('readTranscriptTail returns a small file whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-tail-'));
  const filePath = path.join(dir, 'small.jsonl');
  fs.writeFileSync(filePath, line({ type: 'assistant', marker: 'ONLY-LINE', message: {} }));

  assert.match(readTranscriptTail(filePath, 1024), /ONLY-LINE/);
});

// The tail is not always enough. `contextFromTranscript` skips sidechain
// lines, and a long subagent run writes thousands of them - the last entry
// of the MAIN session then lies before the chunk. Reading the tail alone
// would report "no context" for exactly the sessions that worked hardest.
test('contextForSession falls back to the full file when the tail holds only sidechain lines', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-fb-'));
  const projectDir = path.join(claudeDir, 'projects', '-srv-x');
  fs.mkdirSync(projectDir, { recursive: true });

  const real = assistantWith({ input_tokens: 1000, cache_read_input_tokens: 500 });
  // Enough sidechain lines to push the real entry out of the 64 kB chunk.
  const sidechain = assistantWith({ input_tokens: 7 }, { isSidechain: true }).repeat(2000);
  fs.writeFileSync(path.join(projectDir, 'sess.jsonl'), real + sidechain);

  const result = contextForSession(claudeDir, ['sess'], 'opus');

  assert.equal(result.tokens, 1500);
});

// The counterpart to the fallback test: proof that the fast path actually
// carries the result. Without this, readTranscriptTail could quietly return
// nothing usable, the fallback would rescue every call, and the whole
// optimization would be inert with a green suite.
test('contextForSession takes its numbers from the tail of a large file', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-fast-'));
  const projectDir = path.join(claudeDir, 'projects', '-srv-x');
  fs.mkdirSync(projectDir, { recursive: true });

  const filler = assistantWith({ input_tokens: 1 }).repeat(2000);
  const last = assistantWith({ input_tokens: 1000, cache_creation_input_tokens: 234 });
  fs.writeFileSync(path.join(projectDir, 'sess.jsonl'), filler + last);

  assert.equal(contextForSession(claudeDir, ['sess'], 'opus').tokens, 1234);
});

// A single line longer than the chunk leaves nothing parsable behind after
// the fragment is dropped - the same fallback catches it.
test('contextForSession copes with a last line longer than the chunk', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-long-'));
  const projectDir = path.join(claudeDir, 'projects', '-srv-x');
  fs.mkdirSync(projectDir, { recursive: true });

  const real = assistantWith({ input_tokens: 800 });
  const huge = line({ type: 'user', message: { content: 'x'.repeat(80 * 1024) } });
  fs.writeFileSync(path.join(projectDir, 'sess.jsonl'), real + huge);

  assert.equal(contextForSession(claudeDir, ['sess'], 'opus').tokens, 800);
});
