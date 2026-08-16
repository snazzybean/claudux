// test/authStatus.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAuthProblem } from '../src/lib/authStatus.js';

// When the login expires, the session stays put with a message that
// exists only in the tmux pane: no exit code, no process termination,
// nothing else Claudux could otherwise detect it by.
test('recognizes the expiry message actually seen in production', () => {
  const pane = [
    '❯ do something',
    '',
    'Please run /login · API Error: 401 OAuth access token has expired',
    '',
  ].join('\n');

  assert.equal(detectAuthProblem(pane)?.kind, 'expired');
});

// Second wording for the same state. Deliberately checked in addition to
// the variant above: the message has changed between CLI versions before,
// both need to be caught.
test('recognizes the documented wording "Login expired"', () => {
  assert.equal(detectAuthProblem('Login expired · Please run /login')?.kind, 'expired');
});

// The state a WRONGLY stored account token produces - different from
// "expired". Must stay distinguishable, because the sensible reaction is
// different: fix the token instead of renewing it.
test('distinguishes an invalid token from an expired one', () => {
  const pane = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';

  assert.equal(detectAuthProblem(pane)?.kind, 'invalid');
});

// Claude Code warns a few days before expiry. That's explicitly NOT an
// error - treating it as a failure would report a broken session for days
// while it keeps running fine. Still valuable: the only chance to act
// before expiry instead of after.
test('reports the advance warning as its own, non-blocking state', () => {
  const pane = 'Your login expires in 3 days · run /login to renew';

  assert.equal(detectAuthProblem(pane)?.kind, 'expiring');
});

test('returns null for an unremarkable pane', () => {
  const pane = ['❯ /status', 'Login: user@example.com', 'all good'].join('\n');

  assert.equal(detectAuthProblem(pane), null);
});

// tmux' capture-pane wraps at the edge of the terminal width - a message
// therefore regularly does NOT sit on a single line. Without whitespace
// normalization, detection would fail exactly when it's needed: in a
// narrow terminal on a phone.
test('recognizes a message wrapped across two lines', () => {
  const pane = 'Please run /login · API Error: 401 OAuth access\ntoken has expired';

  assert.equal(detectAuthProblem(pane)?.kind, 'expired');
});

// Detection hinges on the wording of the CLI output, i.e. no stable
// contract. A hit therefore needs to include the matched spot, so that a
// future wording change stays traceable to what detection latched onto -
// instead of just "something auth-related".
test('returns the matched text, not just the kind', () => {
  const match = detectAuthProblem('Login expired · Please run /login');

  assert.ok(match.matched.length > 0);
  assert.ok('Login expired · Please run /login'.toLowerCase().includes(match.matched.toLowerCase()));
});
