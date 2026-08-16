// test/loginScreen.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLoginScreen, joinWrappedLines } from '../src/lib/loginScreen.js';
import { LOGIN_DONE_MARKER } from '../src/lib/tmuxManager.js';

const URL_LINE =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code';

// Composed instead of a single literal: secret scanners flag any line with
// "sk-ant-" and 20 following characters, test files included. A made-up
// value must not train anyone to wave that warning through.
const TOKEN_PREFIX = 'sk-ant-' + 'oat01-';

test('reports starting as long as nothing recognizable is on the screen', () => {
  assert.equal(readLoginScreen('Welcome to Claude Code v2.1.226\n\n', 80).phase, 'starting');
});

// This is what the screen really looks like - the code prompt sits right
// below the URL from the start, not only after it. That's exactly why there
// is no "code" phase: it would kick in immediately and cover up the URL the
// user needs at that moment.
test('reports url even though the code prompt already sits right next to it', () => {
  const screen = [
    " Browser didn't open? Use the url below to sign in (c to copy)",
    '',
    URL_LINE,
    '',
    '',
    ' Paste code here if prompted >',
  ].join('\n');

  const result = readLoginScreen(screen, 200);
  assert.equal(result.phase, 'url');
  assert.equal(result.url, URL_LINE);
});

// Order of the check: the code prompt stays on screen after the token is
// printed. If it were checked first, detection would still report 'code' at
// that point and the assistant would get stuck.
test('reports token even while the URL and code prompt are still on screen', () => {
  const token = `${TOKEN_PREFIX}AAAABBBBCCCCDDDD_eeee-ffff`;
  const screen = [
    URL_LINE,
    ' Paste code here if prompted > abc#def',
    '',
    token,
    '',
    LOGIN_DONE_MARKER,
  ].join('\n');

  const result = readLoginScreen(screen, 200);
  assert.equal(result.phase, 'token');
  assert.equal(result.token, token);
});

// The actual reason for joinWrappedLines: a token of roughly a hundred
// characters doesn't fit on one line in a narrow terminal. capture-pane -J
// doesn't rejoin it, because Claude Code wraps without setting the wrap flag.
test('reassembles a token wrapped across two lines', () => {
  const partA = TOKEN_PREFIX + 'A'.repeat(27);
  assert.equal(partA.length, 40);
  const partB = 'BBBBCCCC';
  const screen = [partA, partB, ''].join('\n');

  const result = readLoginScreen(screen, 40);
  assert.equal(result.phase, 'token');
  assert.equal(result.token, partA + partB);
});

test('joins across three lines too, without appending the next one', () => {
  const raw = ['AAAA', 'BBBB', 'CC', 'DDDD'].join('\n');

  assert.equal(joinWrappedLines(raw, 4), 'AAAABBBBCC\nDDDD');
});

// Measured against the RAW line: if the already-joined line were the
// yardstick, it would always read as too long and pull in every following
// line.
test('only appends after a full line if a line follows immediately', () => {
  assert.equal(joinWrappedLines('AAAA', 4), 'AAAA');
});

// Without a usable width, the text stays untouched: better a token the user
// recognizes as broken in the field than one we reassemble from wrongly
// joined lines.
test('leaves the text untouched when the width is unusable', () => {
  assert.equal(joinWrappedLines('AAAA\nBBBB', 0), 'AAAA\nBBBB');
});

// Comfortably past MIN_TOKEN_LENGTH without pinning down a real token's
// exact length.
const LONG_BODY = 'A'.repeat(60);

// `complete` requires marker, plausible length and the wrap check; each
// test below isolates one of the three.

test('a token with text after it counts as complete', () => {
  const screen = [
    `${TOKEN_PREFIX}${LONG_BODY}`,
    '',
    LOGIN_DONE_MARKER,
  ].join('\n');

  assert.equal(readLoginScreen(screen, 200).complete, true);
});

test('a token whose line does not reach the edge counts as complete', () => {
  const screen = [`${TOKEN_PREFIX}${LONG_BODY}`, '', LOGIN_DONE_MARKER].join('\n'); // 73 characters at width 200

  assert.equal(readLoginScreen(screen, 200).complete, true);
});

// The dangerous case: the last line is completely full, so there could be a
// continuation that capture-pane no longer saw. Marker present regardless -
// the shell command prints it once setup-token exits no matter how the
// token itself wrapped, so this isolates isComplete()'s own judgment.
test('a token whose line ends exactly at the pane width counts as uncertain', () => {
  const line = TOKEN_PREFIX + 'A'.repeat(80 - TOKEN_PREFIX.length); // exactly 80
  // The blank line matters here, same as production's `printf "\n<marker>\n"`:
  // without it, joinWrappedLines() sees the marker as a continuation of the
  // "full" token line above (prevWasFull) and merges the two, which throws
  // off isComplete()'s own line-length arithmetic further down.
  const screen = [line, '', LOGIN_DONE_MARKER].join('\n');

  const result = readLoginScreen(screen, 80);

  assert.equal(result.phase, 'token');
  assert.equal(result.complete, false);
});

// Even after reassembling across several lines, the yardstick stays the
// same: if the joined line ends on a multiple of the width, the last raw
// line was full.
test('a token spanning two full lines counts as uncertain', () => {
  const body = ['A'.repeat(80), 'B'.repeat(80)].join('\n');
  const withPrefix = TOKEN_PREFIX + body.slice(TOKEN_PREFIX.length);
  const screen = [withPrefix, '', LOGIN_DONE_MARKER].join('\n'); // blank line, see the test above

  assert.equal(readLoginScreen(screen, 80).complete, false);
});

test('without a usable width, a token counts as complete', () => {
  const screen = [`${TOKEN_PREFIX}${LONG_BODY}`, '', LOGIN_DONE_MARKER].join('\n');

  assert.equal(readLoginScreen(screen, 0).complete, true);
});

// A match below MIN_TOKEN_LENGTH is incomplete even with the marker
// present and no width boundary in sight.
test('a suspiciously short match counts as incomplete even with the marker present', () => {
  const screen = [
    `${TOKEN_PREFIX}AAAABBBB`,
    '',
    LOGIN_DONE_MARKER,
  ].join('\n');

  const result = readLoginScreen(screen, 200);
  assert.equal(result.phase, 'token');
  assert.equal(result.complete, false);
});

// Without the marker the capture may be unfinished, so no width arithmetic
// may call it complete.
test('a token without the marker counts as incomplete no matter how it looks otherwise', () => {
  const screen = [
    `${TOKEN_PREFIX}${LONG_BODY}`,
    '>>> Highlight the token above <<<', // NOT the real marker
  ].join('\n');

  const result = readLoginScreen(screen, 200);
  assert.equal(result.phase, 'token');
  assert.equal(result.complete, false);
});
