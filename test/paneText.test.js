// test/paneText.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePaneText } from '../src/lib/paneText.js';

test('lines made only of line-drawing characters are dropped', () => {
  const input = 'top\n────────────\nbottom';

  assert.equal(sanitizePaneText(input), 'top\nbottom');
});

test('two-sided frames are stripped, the inner padding with them', () => {
  const input = '│ content │';

  assert.equal(sanitizePaneText(input), 'content');
});

test('a one-sided match is left untouched', () => {
  const input = '| a | b | c';

  assert.equal(sanitizePaneText(input), '| a | b | c');
});

test('a line with a vertical bar only at the start is left standing', () => {
  const input = '│ left only';

  assert.equal(sanitizePaneText(input), '│ left only');
});

test('exactly two leading spaces are dropped', () => {
  const input = '  answer text';

  assert.equal(sanitizePaneText(input), 'answer text');
});

test('deeper indentation keeps its relative structure', () => {
  const input = '  const a = 1;\n      const b = 2;';

  assert.equal(sanitizePaneText(input), 'const a = 1;\n    const b = 2;');
});

test('a single leading space is left standing', () => {
  const input = ' just one off';

  assert.equal(sanitizePaneText(input), ' just one off');
});

test('trailing whitespace is dropped', () => {
  const input = 'text with a margin   ';

  assert.equal(sanitizePaneText(input), 'text with a margin');
});

test('empty lines at the edges are dropped, inner ones stay', () => {
  const input = '\n\ntop\n\nbottom\n\n';

  assert.equal(sanitizePaneText(input), 'top\n\nbottom');
});

test('empty text stays empty', () => {
  assert.equal(sanitizePaneText(''), '');
});

test('text without any markup stays unchanged', () => {
  const input = 'one line\nanother one';

  assert.equal(sanitizePaneText(input), 'one line\nanother one');
});

test('everything works together on a realistic excerpt', () => {
  const input = [
    '',
    '  ● Let me take a look at that.',
    '',
    '  ────────────────',
    '  │ > Input │',
    '  Context 9% (173k)   ',
    '',
  ].join('\n');

  assert.equal(
    sanitizePaneText(input),
    ['● Let me take a look at that.', '', '> Input', 'Context 9% (173k)'].join('\n'),
  );
});
