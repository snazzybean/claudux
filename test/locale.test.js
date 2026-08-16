import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUtf8Locale, getUtf8LocaleEnv } from '../src/lib/locale.js';

test('pickUtf8Locale takes C.utf8 on Linux when present', () => {
  const result = pickUtf8Locale({ platform: 'linux', availableLocales: ['C', 'C.utf8', 'POSIX'] });
  assert.deepEqual(result, { LC_ALL: 'C.utf8' });
});

test('pickUtf8Locale takes en_US.UTF-8 on macOS when present', () => {
  const result = pickUtf8Locale({ platform: 'darwin', availableLocales: ['C', 'en_US.UTF-8', 'de_DE.UTF-8'] });
  assert.deepEqual(result, { LC_ALL: 'en_US.UTF-8' });
});

test('pickUtf8Locale falls back to the first available UTF-8 locale when the preferred one is missing', () => {
  const result = pickUtf8Locale({ platform: 'darwin', availableLocales: ['C', 'de_DE.UTF-8', 'fr_FR.UTF-8'] });
  assert.deepEqual(result, { LC_ALL: 'de_DE.UTF-8' });
});

test('pickUtf8Locale falls back to LC_CTYPE=UTF-8 when no UTF-8 locale exists at all', () => {
  const result = pickUtf8Locale({ platform: 'darwin', availableLocales: ['C', 'POSIX'] });
  assert.deepEqual(result, { LC_CTYPE: 'UTF-8' });
});

test('pickUtf8Locale on Linux without C.utf8 uses the same fallback as macOS', () => {
  const result = pickUtf8Locale({ platform: 'linux', availableLocales: ['C', 'en_US.utf8'] });
  assert.deepEqual(result, { LC_ALL: 'en_US.utf8' });
});

test('pickUtf8Locale also recognizes hyphenated macOS-style UTF-8 locales', () => {
  const result = pickUtf8Locale({ platform: 'linux', availableLocales: ['C', 'en_US.UTF-8'] });
  assert.deepEqual(result, { LC_ALL: 'en_US.UTF-8' });
});

test('getUtf8LocaleEnv returns a usable locale on the real host', () => {
  const env = getUtf8LocaleEnv();
  assert.ok(env.LC_ALL || env.LC_CTYPE);
});
