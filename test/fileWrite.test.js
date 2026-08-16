import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveFile, WriteConflict } from '../src/lib/fileWrite.js';

function fixture(content = 'old\n', mode = 0o644) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-write-'));
  const filePath = path.join(dir, 'file.txt');
  fs.writeFileSync(filePath, content, { mode });
  return { dir, filePath, modified: Math.floor(fs.statSync(filePath).mtimeMs) };
}

test('saveFile writes the new content and returns the new modification time', () => {
  const { filePath, modified } = fixture();

  const result = saveFile(filePath, 'new\n', modified);

  assert.equal(fs.readFileSync(filePath, 'utf8'), 'new\n');
  assert.equal(result.modified, Math.floor(fs.statSync(filePath).mtimeMs));
});

test('saveFile throws a conflict when the file changed in the meantime', () => {
  const { filePath, modified } = fixture();

  assert.throws(
    () => saveFile(filePath, 'mine\n', modified - 5000),
    (err) => err instanceof WriteConflict
      && err.status === 409
      && err.raw === 'old\n'
      && err.modified === modified,
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'old\n'); // nothing overwritten
});

test('saveFile overwrites on the second attempt with the new modification time', () => {
  const { filePath } = fixture();
  const current = Math.floor(fs.statSync(filePath).mtimeMs);

  saveFile(filePath, 'anyway\n', current);

  assert.equal(fs.readFileSync(filePath, 'utf8'), 'anyway\n');
});

test('saveFile keeps the original file\'s permissions', () => {
  const { filePath, modified } = fixture('secret\n', 0o600);

  saveFile(filePath, 'still secret\n', modified);

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('saveFile leaves no side file behind', () => {
  const { dir, filePath, modified } = fixture();

  saveFile(filePath, 'new\n', modified);

  assert.deepEqual(fs.readdirSync(dir), ['file.txt']);
});

test('saveFile cleans up the side file even after a conflict', () => {
  const { dir, filePath, modified } = fixture();

  assert.throws(() => saveFile(filePath, 'mine\n', modified - 5000));

  assert.deepEqual(fs.readdirSync(dir), ['file.txt']);
});

test('saveFile replaces the file via rename instead of emptying it in place', () => {
  const { filePath, modified } = fixture();
  const before = fs.statSync(filePath).ino;

  saveFile(filePath, 'new\n', modified);

  // A new inode is allocated: a process reading concurrently thus sees
  // either the old or the new file, never one that's half written.
  assert.notEqual(fs.statSync(filePath).ino, before);
});
