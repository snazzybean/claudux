import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeFile, languageFor, MAX_VIEW_BYTES } from '../src/lib/fileType.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-type-'));
}

function write(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('describeFile recognizes Markdown by its extension', () => {
  const dir = tmpDir();
  const filePath = write(dir, 'README.md', '# Title');

  const info = describeFile(filePath, fs.statSync(filePath));

  assert.equal(info.type, 'markdown');
  assert.equal(info.editable, true);
});

test('describeFile recognizes source code by its extension and returns the language', () => {
  const dir = tmpDir();
  const filePath = write(dir, 'app.js', 'const a = 1;');

  const info = describeFile(filePath, fs.statSync(filePath));

  assert.equal(info.type, 'text');
  assert.equal(info.language, 'javascript');
  assert.equal(info.editable, true);
});

test('describeFile recognizes images and returns their content type', () => {
  const dir = tmpDir();
  const png = write(dir, 'image.png', 'not really a png');
  const svg = write(dir, 'logo.svg', '<svg/>');

  assert.equal(describeFile(png, fs.statSync(png)).type, 'image');
  assert.equal(describeFile(png, fs.statSync(png)).contentType, 'image/png');
  assert.equal(describeFile(svg, fs.statSync(svg)).type, 'image');
  assert.equal(describeFile(svg, fs.statSync(svg)).contentType, 'image/svg+xml');
  assert.equal(describeFile(png, fs.statSync(png)).editable, false);
});

test('describeFile treats a file without an extension and without a NUL byte as text', () => {
  const dir = tmpDir();
  const filePath = write(dir, 'Makefile', 'all:\n\techo hello\n');

  const info = describeFile(filePath, fs.statSync(filePath));

  assert.equal(info.type, 'text');
});

test('describeFile treats a file with a NUL byte as binary', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'data.bin');
  fs.writeFileSync(filePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));

  const info = describeFile(filePath, fs.statSync(filePath));

  assert.equal(info.type, 'binary');
  assert.equal(info.editable, false);
  assert.equal(info.contentType, 'application/octet-stream');
});

test('describeFile treats dotfiles like .gitignore as text', () => {
  const dir = tmpDir();
  const filePath = write(dir, '.gitignore', 'node_modules\n');

  assert.equal(describeFile(filePath, fs.statSync(filePath)).type, 'text');
});

test('describeFile marks text files over the limit as not editable', () => {
  const dir = tmpDir();
  const filePath = write(dir, 'large.txt', 'x'.repeat(16));
  const stats = fs.statSync(filePath);
  // Fake the size instead of writing 1 MB - the limit is what's under
  // test, not the filesystem.
  const info = describeFile(filePath, { ...stats, size: MAX_VIEW_BYTES + 1, mtimeMs: stats.mtimeMs });

  assert.equal(info.type, 'text');
  assert.equal(info.editable, false);
  assert.equal(info.tooLarge, true);
});

test('describeFile returns size and modification time', () => {
  const dir = tmpDir();
  const filePath = write(dir, 'a.txt', 'hello');
  const stats = fs.statSync(filePath);

  const info = describeFile(filePath, stats);

  assert.equal(info.size, 5);
  assert.equal(info.modified, Math.floor(stats.mtimeMs));
});

test('languageFor knows common extensions and stays silent for unknown ones', () => {
  assert.equal(languageFor('a.ts'), 'typescript');
  assert.equal(languageFor('styles.css'), 'css');
  assert.equal(languageFor('start.sh'), 'bash');
  assert.equal(languageFor('data.json'), 'json');
  assert.equal(languageFor('Makefile'), null);
});
