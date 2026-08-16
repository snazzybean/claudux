// test/vapidKeys.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getVapidKeys } from '../src/lib/vapidKeys.js';

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-vapid-'));
  return path.join(dir, 'nested', 'vapid.json');
}

test('generates a usable keypair on first call', () => {
  const keys = getVapidKeys(tmpPath());
  const raw = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
  // The private key must match the public one, otherwise every push gets a
  // 403 and nothing here would have noticed.
  const jwk = crypto
    .createPublicKey(crypto.createPrivateKey(keys.privateKey))
    .export({ format: 'jwk' });
  const derived = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  assert.equal(derived.toString('base64url'), keys.publicKey);
});

test('returns the same keypair on the second call', () => {
  const file = tmpPath();
  assert.deepEqual(getVapidKeys(file), getVapidKeys(file));
});

test('stores the file 0600 and the directory 0700', () => {
  const file = tmpPath();
  getVapidKeys(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('broken JSON throws instead of silently minting a new keypair', () => {
  const file = tmpPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => getVapidKeys(file), /vapid/i);
});

test('a half-written file throws too', () => {
  const file = tmpPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ publicKey: 'only-this' }));
  assert.throws(() => getVapidKeys(file), /vapid/i);
});

test('the error never quotes the file content', () => {
  const file = tmpPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ privateKey: 'SECRET-MATERIAL-XYZ' }));
  assert.throws(
    () => getVapidKeys(file),
    (err) => !err.message.includes('SECRET-MATERIAL-XYZ'),
  );
});
