// test/settingsGuard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNoGlobalAuthOverride } from '../scripts/check-settings-guard.js';

test('checkNoGlobalAuthOverride is ok when no env block exists', () => {
  const result = checkNoGlobalAuthOverride(JSON.stringify({ hooks: {} }));
  assert.equal(result.ok, true);
});

test('checkNoGlobalAuthOverride flags ANTHROPIC_API_KEY in the env block', () => {
  const result = checkNoGlobalAuthOverride(JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /ANTHROPIC_API_KEY/);
});

test('checkNoGlobalAuthOverride flags ANTHROPIC_AUTH_TOKEN in the env block', () => {
  const result = checkNoGlobalAuthOverride(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }));
  assert.equal(result.ok, false);
});

// CLAUDE_CODE_OAUTH_TOKEN belongs on the denylist: a global override of
// exactly this key overwrites the per-session token and silently undermines
// account separation.
test('checkNoGlobalAuthOverride flags CLAUDE_CODE_OAUTH_TOKEN in the env block', () => {
  const result = checkNoGlobalAuthOverride(JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /CLAUDE_CODE_OAUTH_TOKEN/);
});

// apiKeyHelper is not an env override but a top-level key - a
// script stored there can redirect the auth path just as silently.
test('checkNoGlobalAuthOverride flags apiKeyHelper as a top-level key', () => {
  const result = checkNoGlobalAuthOverride(JSON.stringify({ apiKeyHelper: '/usr/local/bin/my-helper.sh' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /apiKeyHelper/);
});

test('checkNoGlobalAuthOverride flags the key even with an empty string value (presence, not truthiness)', () => {
  const result = checkNoGlobalAuthOverride(JSON.stringify({ env: { ANTHROPIC_API_KEY: '' } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /ANTHROPIC_API_KEY/);
});

test('checkNoGlobalAuthOverride is ok when the env block contains other keys', () => {
  const result = checkNoGlobalAuthOverride(JSON.stringify({ env: { FOO: 'bar' } }));
  assert.equal(result.ok, true);
});

test('checkNoGlobalAuthOverride returns ok:false instead of throwing when settings.json is broken JSON', () => {
  const result = checkNoGlobalAuthOverride('{ "env": { broken');
  assert.equal(result.ok, false);
  assert.match(result.reason, /JSON/);
});
