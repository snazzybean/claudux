import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublicPath, sessionTokenFromCookie, isSessionExpired, wantsHtml,
} from '../src/lib/accessGuard.js';

const DAY = 24 * 60 * 60 * 1000;

test('the stylesheet, the manifest, the favicon and the icons stay reachable', () => {
  assert.equal(isPublicPath('/styles.css'), true);
  assert.equal(isPublicPath('/manifest.json'), true);
  assert.equal(isPublicPath('/favicon.ico'), true);
  assert.equal(isPublicPath('/icons/icon-192.png'), true);
});

// The login page has no path of its own - the gate serves it under the
// requested url. Everything else is behind the session.
test('everything else is not public, the login page included', () => {
  for (const p of ['/', '/index.html', '/login.html', '/app.js', '/js/terminal.js',
    '/api/sessions', '/ttyd/ws', '/sw.js']) {
    assert.equal(isPublicPath(p), false, p);
  }
});

// A path that merely starts like an allowed one must not slip through.
test('a prefix of an allowed path is not allowed', () => {
  assert.equal(isPublicPath('/styles.css.map'), false);
  assert.equal(isPublicPath('/icons-secret/x'), false);
  assert.equal(isPublicPath('/manifest.json.bak'), false);
});

test('the icons directory is allowed but does not escape upwards', () => {
  assert.equal(isPublicPath('/icons/'), true);
  assert.equal(isPublicPath('/icons/../app.js'), false);
});

test('the session token is picked out of a cookie header with several cookies', () => {
  assert.equal(sessionTokenFromCookie('claudux_session=abc'), 'abc');
  assert.equal(sessionTokenFromCookie('a=1; claudux_session=abc; b=2'), 'abc');
  assert.equal(sessionTokenFromCookie(' claudux_session = abc '), 'abc');
});

test('a missing or foreign cookie yields null', () => {
  assert.equal(sessionTokenFromCookie(''), null);
  assert.equal(sessionTokenFromCookie(undefined), null);
  assert.equal(sessionTokenFromCookie('other=abc'), null);
  assert.equal(sessionTokenFromCookie('claudux_session='), null);
  // A cookie whose name merely ends in the wanted one is a different cookie.
  assert.equal(sessionTokenFromCookie('xclaudux_session=abc'), null);
});

test('a session expires exactly one lifetime after it was created', () => {
  const created = 1_000_000;
  assert.equal(isSessionExpired(created, 7, created + 7 * DAY - 1), false);
  assert.equal(isSessionExpired(created, 7, created + 7 * DAY + 1), true);
  assert.equal(isSessionExpired(created, 365, created + 100 * DAY), false);
});

test('a lifetime of null never expires', () => {
  assert.equal(isSessionExpired(1000, null, 1000 + 4000 * DAY), false);
});

test('html navigations are told apart from fetch calls', () => {
  assert.equal(wantsHtml('text/html,application/xhtml+xml'), true);
  assert.equal(wantsHtml('*/*'), false);
  assert.equal(wantsHtml('application/json'), false);
  assert.equal(wantsHtml(undefined), false);
});
