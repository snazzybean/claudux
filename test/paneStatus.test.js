import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPaneStatus, readPaneMode } from '../src/lib/paneStatus.js';

// Every line below is verbatim from a real `tmux capture-pane` put through
// sanitizePaneText - four sessions on this host plus the captures in the
// measurement notes. The glyph varies across them, which is why it is not
// what the patterns key on.
const RUNNING = [
  ['* Perusing… (13s · ↓ 511 tokens)', 'Perusing… (13s · ↓ 511 tokens)'],
  ['✢ Frolicking… (13s · ↓ 433 tokens)', 'Frolicking… (13s · ↓ 433 tokens)'],
  ['✽ Beaming… (1m 4s · ↓ 3.5k tokens)', 'Beaming… (1m 4s · ↓ 3.5k tokens)'],
  ['✽ Forging… (10s · ↓ 343 tokens)', 'Forging… (10s · ↓ 343 tokens)'],
];
const DONE = [
  ['✻ Baked for 7m 19s', 'Baked for 7m 19s'],
  ['✻ Cogitated for 58s', 'Cogitated for 58s'],
  ['✻ Cooked for 3m 0s', 'Cooked for 3m 0s'],
  ['✻ Churned for 2m 48s', 'Churned for 2m 48s'],
  ['✻ Crunched for 7s', 'Crunched for 7s'],
];

test('readPaneStatus reads a turn in flight, and drops the glyph', () => {
  for (const [line, expected] of RUNNING) {
    assert.deepEqual(readPaneStatus(`some output\n\n${line}\n\n❯\n`), { text: expected, working: true });
  }
});

test('readPaneStatus reads a finished turn as not working', () => {
  for (const [line, expected] of DONE) {
    assert.deepEqual(readPaneStatus(`some output\n\n${line}\n\n❯\n`), { text: expected, working: false });
  }
});

// The line sits at the bottom of the pane, and everything above it is
// conversation - which can carry an older one of these verbatim, quoted.
test('readPaneStatus takes the last line, not the first', () => {
  const pane = '✻ Cogitated for 4s\nsomething happened\n✽ Beaming… (2s · ↓ 10 tokens)\n\n❯\n';
  assert.deepEqual(readPaneStatus(pane), { text: 'Beaming… (2s · ↓ 10 tokens)', working: true });
});

// Without the glyph there is no line. An assistant's own prose is full of
// capitalised words, and "Cooked for 3m 0s" as a sentence is not a status.
test('readPaneStatus needs the glyph, so ordinary prose is not a status', () => {
  assert.equal(readPaneStatus('Cooked for 3m 0s\n\n❯\n'), null);
  assert.equal(readPaneStatus('Beaming… (1m 4s)\n\n❯\n'), null);
});

test('readPaneStatus says nothing rather than guessing on an idle pane', () => {
  assert.equal(readPaneStatus('❯\n▰▱▱ Context 4%\n⏵⏵ auto mode on'), null);
  assert.equal(readPaneStatus(''), null);
  assert.equal(readPaneStatus(null), null);
});

// The mode lines are verbatim too. The default mode has none at all - the A1
// capture in paneDialog.test.js was taken with `permission_mode: default` and
// carries no such line anywhere.
test('readPaneMode reads the mode off the status bar', () => {
  const bar = (line) => `some output\n\n❯ \n▰▰▱ Context 21%\n${line}`;
  assert.equal(readPaneMode(bar('⏵⏵ auto mode on (shift+tab to cycle) · ← for agents')), 'auto');
  assert.equal(readPaneMode(bar('⏵⏵ accept edits on (shift+tab to cycle) · ← for agents')), 'accept edits');
  assert.equal(readPaneMode(bar('⏸ plan mode on (shift+tab to cycle)')), 'plan');
});

// The one line that would fool a looser pattern: it names the modes and the
// keys without any of them being on.
test('readPaneMode is not fooled by the tip that names the same keys', () => {
  const pane = 'output\n⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode\n\n❯ \n';
  assert.equal(readPaneMode(pane), 'manual');
});

test('readPaneMode calls the mode with no line of its own manual', () => {
  assert.equal(readPaneMode('output\n\n❯ \n▰▰▱ Context 21%'), 'manual');
});

test('readPaneMode says nothing for a pane with nothing on it', () => {
  assert.equal(readPaneMode(''), null);
  assert.equal(readPaneMode(null), null);
});
