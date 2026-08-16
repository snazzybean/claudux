// test/accountStore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAccounts, addAccount, updateAccount, removeAccount, getTokenById, getAccountById, accountIdForToken } from '../src/lib/accountStore.js';

test('listAccounts returns an empty array when the file is missing', () => {
  const secretPath = path.join(os.tmpdir(), `claudux-acc-${Date.now()}.json`);
  assert.deepEqual(listAccounts(secretPath), []);
});

test('addAccount saves with chmod 600, getTokenById reads it back, listAccounts never shows the token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');

  const created = addAccount(secretPath, 'work', 'sk-secret-123');

  const stat = fs.statSync(secretPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(getTokenById(secretPath, created.id), 'sk-secret-123');
  assert.deepEqual(listAccounts(secretPath).map((a) => a.name), ['work']);

  const rawFileForNameCheck = fs.readFileSync(secretPath, 'utf8');
  assert.ok(rawFileForNameCheck.includes('work'));
});

test('addAccount corrects the mode of an already-existing file with overly lax permissions to 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(secretPath, '{}', { mode: 0o644 });
  assert.equal(fs.statSync(secretPath).mode & 0o777, 0o644);

  addAccount(secretPath, 'work', 'sk-secret-123');

  assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
});

// Valid JSON that isn't an object (null, array, number) must not land
// unchecked in listAccounts/addAccount - Object.keys(null) throws. Same
// guard as in sessionMeta.js::readAll.
test('listAccounts returns an empty array when accounts.json is a JSON array instead of an object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(secretPath, '[]');

  assert.deepEqual(listAccounts(secretPath), []);
});

test('listAccounts returns an empty array when accounts.json is "null"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(secretPath, 'null');

  assert.deepEqual(listAccounts(secretPath), []);
});

test('listAccounts returns an empty array when accounts.json is a number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(secretPath, '42');

  assert.deepEqual(listAccounts(secretPath), []);
});

test('addAccount creates a missing target directory with chmod 700, not the default umask', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const nestedDir = path.join(parent, 'nested', 'accounts-dir');
  const secretPath = path.join(nestedDir, 'accounts.json');

  addAccount(secretPath, 'work', 'sk-secret-123');

  assert.equal(fs.statSync(nestedDir).mode & 0o777, 0o700);
});

// Files in the legacy { "<name>": "<token>" } shape must keep working
// without a migration script.
test('listAccounts/getTokenById keep working for accounts in the old format (auto-migration on read)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(secretPath, JSON.stringify({ Work: 'sk-old-123' }), { mode: 0o600 });

  const accounts = listAccounts(secretPath);
  assert.deepEqual(accounts.map((a) => a.name), ['Work']);
  assert.equal(getTokenById(secretPath, accounts[0].id), 'sk-old-123');
});

test('an old string entry self-heals into the new object format on first read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(secretPath, JSON.stringify({ Work: 'sk-old-123' }), { mode: 0o600 });

  listAccounts(secretPath); // triggers the migration

  const onDisk = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  const [id, entry] = Object.entries(onDisk)[0];
  assert.equal(typeof id, 'string');
  assert.notEqual(id, 'Work');
  assert.deepEqual(entry, { name: 'Work', abbreviation: null, token: 'sk-old-123' });
});

test('the id assigned by migration stays stable across multiple reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(secretPath, JSON.stringify({ Work: 'sk-old-123' }), { mode: 0o600 });

  const [firstId] = listAccounts(secretPath).map((a) => a.id);
  const [secondId] = listAccounts(secretPath).map((a) => a.id);

  assert.equal(firstId, secondId);
});

test('listAccounts returns {id, name, abbreviation}, never the token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  addAccount(secretPath, 'Work', 'sk-secret-123', 'AR');

  const accounts = listAccounts(secretPath);

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, 'Work');
  assert.equal(accounts[0].abbreviation, 'AR');
  assert.ok(accounts[0].id);
  assert.equal(accounts[0].token, undefined);
});

test('addAccount without abbreviation returns abbreviation: null instead of undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  addAccount(secretPath, 'Work', 'sk-secret-123');

  assert.equal(listAccounts(secretPath)[0].abbreviation, null);
});

test('addAccount truncates an overly long abbreviation to 2 characters server-side', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  addAccount(secretPath, 'Work', 'sk-secret-123', 'ARBITRARY');

  assert.equal(listAccounts(secretPath)[0].abbreviation, 'AR');
});

test('updateAccount changes name and abbreviation, token stays untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const created = addAccount(secretPath, 'Office', 'sk-secret-123', 'AR');

  updateAccount(secretPath, created.id, { name: 'Work', abbreviation: 'WK' });

  assert.equal(getTokenById(secretPath, created.id), 'sk-secret-123');
  assert.deepEqual(listAccounts(secretPath), [{ id: created.id, name: 'Work', abbreviation: 'WK' }]);
});

test('updateAccount truncates an overly long abbreviation to 2 characters server-side', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const created = addAccount(secretPath, 'Work', 'sk-secret-123');

  updateAccount(secretPath, created.id, { abbreviation: 'ARBITRARY' });

  assert.equal(listAccounts(secretPath)[0].abbreviation, 'AR');
});

test('updateAccount throws on an unknown id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');

  assert.throws(() => updateAccount(secretPath, 'unknown-id', { name: 'X' }));
});

// Token renewal: without this path, an account would have to be deleted and
// recreated, which changes its ID and would leave every session-meta.json
// reference to it dangling. Hence replacing instead of recreating.
test('updateAccount replaces the token when token is passed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const created = addAccount(secretPath, 'Work', 'sk-old-123', 'AR');

  updateAccount(secretPath, created.id, { token: 'sk-new-456' });

  assert.equal(getTokenById(secretPath, created.id), 'sk-new-456');
  assert.deepEqual(listAccounts(secretPath), [{ id: created.id, name: 'Work', abbreviation: 'AR' }]);
});

// Counter-check to the test above: a PATCH that only changes the name must
// NOT set the token to undefined - otherwise a rename would be a silent
// token loss that only surfaces hours later at expiry.
test('updateAccount without a token field leaves the existing token untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const created = addAccount(secretPath, 'Work', 'sk-old-123', 'AR');

  updateAccount(secretPath, created.id, { name: 'Work' });

  assert.equal(getTokenById(secretPath, created.id), 'sk-old-123');
});

test('removeAccount removes exactly one account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const work = addAccount(secretPath, 'Work', 'sk-ant-oat01-aaa');
  addAccount(secretPath, 'Private', 'sk-ant-oat01-bbb');

  removeAccount(secretPath, work.id);

  assert.deepEqual(listAccounts(secretPath).map((a) => a.name), ['Private']);
});

// The token has to go with it - it's the file's actual payload, and a value
// left behind would be a secret without an owner.
test('removeAccount takes the token with it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const work = addAccount(secretPath, 'Work', 'sk-ant-oat01-aaa');

  removeAccount(secretPath, work.id);

  assert.equal(getTokenById(secretPath, work.id), null);
  assert.ok(!fs.readFileSync(secretPath, 'utf8').includes('sk-ant-oat01-aaa'));
});

// Like updateAccount: the store reports an unknown ID instead of silently
// doing nothing - the route turns that into a 404.
test('removeAccount throws on an unknown ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  addAccount(secretPath, 'Work', 'sk-ant-oat01-aaa');

  assert.throws(() => removeAccount(secretPath, 'does-not-exist'), /not found/);
});

test('getTokenById reads the token back, getAccountById never carries it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const created = addAccount(secretPath, 'work', 'sk-secret-123', 'kw');

  assert.equal(getTokenById(secretPath, created.id), 'sk-secret-123');
  assert.deepEqual(getAccountById(secretPath, created.id), {
    id: created.id,
    name: 'work',
    abbreviation: 'kw',
  });
});

test('getTokenById and getAccountById return null for an unknown id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  addAccount(secretPath, 'work', 'sk-secret-123');

  assert.equal(getTokenById(secretPath, 'no-such-id'), null);
  assert.equal(getAccountById(secretPath, 'no-such-id'), null);
});

// "__proto__" as an id would hit the prototype instead of an own property
// and hand out an object that belongs to no account.
test('getAccountById does not resolve inherited properties', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  addAccount(secretPath, 'work', 'sk-secret-123');

  assert.equal(getAccountById(secretPath, '__proto__'), null);
  assert.equal(getAccountById(secretPath, 'constructor'), null);
  assert.equal(getTokenById(secretPath, '__proto__'), null);
});

test('accountIdForToken finds the id, and null when nothing matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const created = addAccount(secretPath, 'work', 'sk-secret-123');

  assert.equal(accountIdForToken(secretPath, 'sk-secret-123'), created.id);
  assert.equal(accountIdForToken(secretPath, 'sk-other'), null);
  assert.equal(accountIdForToken(secretPath, ''), null);
  assert.equal(accountIdForToken(secretPath, null), null);
});

// Two accounts may carry the same name - nothing forbids it. Resolving by
// id must not care.
test('getTokenById tells two accounts with the same name apart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-acc-'));
  const secretPath = path.join(dir, 'accounts.json');
  const first = addAccount(secretPath, 'work', 'sk-first');
  const second = addAccount(secretPath, 'work', 'sk-second');

  assert.equal(getTokenById(secretPath, first.id), 'sk-first');
  assert.equal(getTokenById(secretPath, second.id), 'sk-second');
});
