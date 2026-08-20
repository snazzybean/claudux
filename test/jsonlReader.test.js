import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAppendedLines } from '../src/lib/jsonlReader.js';

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-jr-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, contents);
  return file;
}

test('readAppendedLines returns every complete line and the offset after it', () => {
  const file = tmpFile('a\nb\n');
  const { text, offset } = readAppendedLines(file, 0);
  assert.equal(text, 'a\nb\n');
  assert.equal(offset, 4);
});

test('readAppendedLines returns only what was added since the offset', () => {
  const file = tmpFile('a\n');
  const first = readAppendedLines(file, 0);
  fs.appendFileSync(file, 'b\n');
  const second = readAppendedLines(file, first.offset);
  assert.equal(second.text, 'b\n');
});

// These files are read while Claude Code writes them, so the last line is
// regularly incomplete. Consuming it would move the offset past a line that
// was never parsed.
test('readAppendedLines leaves a trailing partial line for the next call', () => {
  const file = tmpFile('a\nbb');
  const first = readAppendedLines(file, 0);
  assert.equal(first.text, 'a\n');
  assert.equal(first.offset, 2);
  fs.appendFileSync(file, 'b\n');
  assert.equal(readAppendedLines(file, first.offset).text, 'bbb\n');
});

test('readAppendedLines reads nothing new when the file has not grown', () => {
  const file = tmpFile('a\n');
  assert.deepEqual(readAppendedLines(file, 2), { text: '', offset: 2 });
});

// A shorter file under the same path is a different file - after a /clear
// the path can point at a fresh, small transcript.
test('readAppendedLines restarts when the file is shorter than the offset', () => {
  const file = tmpFile('a\n');
  const { text, offset } = readAppendedLines(file, 4096);
  assert.equal(text, 'a\n');
  assert.equal(offset, 2);
});

// A single tool_result line can exceed the chunk size on its own.
test('readAppendedLines returns a line longer than one chunk', () => {
  const long = `${'x'.repeat(3 * 1024 * 1024)}\n`;
  const file = tmpFile(long);
  assert.equal(readAppendedLines(file, 0).text, long);
});

// A chunk boundary lands inside a multi-byte character often enough, and
// decoding the halves separately would corrupt that line.
test('readAppendedLines keeps a multi-byte character whole across a chunk boundary', () => {
  const pad = 'x'.repeat(1024 * 1024 - 1);
  const file = tmpFile(`${pad}ä\n`);
  assert.equal(readAppendedLines(file, 0).text, `${pad}ä\n`);
});
