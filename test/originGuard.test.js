import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUpgradeOrigin } from '../src/lib/originGuard.js';

const PUBLIC = 'https://claudux.example.com';

test('a browser on the public url is allowed through a proxy that keeps Host', () => {
  assert.equal(isAllowedUpgradeOrigin({
    origin: 'https://claudux.example.com',
    host: 'claudux.example.com',
  }, PUBLIC), true);
});

// A proxy that rewrites Host to the backend address must not lock the
// terminal out - hence x-forwarded-host and the configured public url as
// further sources.
test('a proxy that rewrites Host is covered by x-forwarded-host and by publicBaseUrl', () => {
  assert.equal(isAllowedUpgradeOrigin({
    origin: 'https://claudux.example.com',
    host: '127.0.0.1:4001',
    'x-forwarded-host': 'claudux.example.com, proxy.internal',
  }, ''), true);

  assert.equal(isAllowedUpgradeOrigin({
    origin: 'https://claudux.example.com',
    host: '127.0.0.1:4001',
  }, PUBLIC), true);
});

test('a browser addressing the port directly is allowed', () => {
  assert.equal(isAllowedUpgradeOrigin({
    origin: 'http://192.0.2.10:4001',
    host: '192.0.2.10:4001',
  }, PUBLIC), true);
});

test('a foreign page is refused, port and scheme included', () => {
  for (const origin of [
    'https://evil.example',
    'http://claudux.example.com.evil.example',
    'http://192.0.2.10:4002',
    'null',
    'not a url',
  ]) {
    assert.equal(isAllowedUpgradeOrigin({
      origin,
      host: '192.0.2.10:4001',
    }, PUBLIC), false, `${origin} should be refused`);
  }
});

// Browsers always send Origin on an upgrade, so a request without one is a
// non-browser client - it reaches the unauthenticated API anyway and gains
// nothing from forging an upgrade. Node's own WebSocket sends none, so the
// test suite depends on this too.
test('a request without Origin passes', () => {
  assert.equal(isAllowedUpgradeOrigin({ host: '192.0.2.10:4001' }, PUBLIC), true);
  assert.equal(isAllowedUpgradeOrigin({}, ''), true);
});
