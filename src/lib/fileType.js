// The type of a file and what follows from it: whether it gets rendered,
// shown as an image, or only offered for download, and whether it may be
// edited.
import fs from 'node:fs';
import path from 'node:path';

// From here on nothing gets rendered and nothing gets edited. The view says
// so and offers a download instead; images and downloads bypass this limit
// entirely, they get streamed instead of read into memory.
export const MAX_VIEW_BYTES = 1024 * 1024;

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

// Extension -> language for highlight.js. Deliberately a table instead of
// highlightAuto: guessing is expensive and often wrong for short files (see
// fileRender.js, where it's only the fallback).
const LANGUAGES = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.php': 'php',
  '.sql': 'sql',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.conf': 'ini',
  '.env': 'bash',
  '.diff': 'diff',
  '.patch': 'diff',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.dockerfile': 'dockerfile',
  '.service': 'ini',
};

// Extensions without their own language that are nevertheless reliably
// text.
const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.csv', '.tsv', '.gitignore', '.gitattributes', '.gitmodules',
  '.editorconfig', '.npmrc', '.nvmrc', '.lock', '.example', '.sample', '.rules',
  '.cfg', '.properties', '.jsonl', '.map',
]);

// Files without an extension whose name alone reveals the type.
const TEXT_NAMES = new Set([
  'Makefile', 'Dockerfile', 'LICENSE', 'CHANGELOG', 'AUTHORS', 'NOTICE',
  'Procfile', 'Gemfile', 'Rakefile', 'CODEOWNERS',
]);

export function languageFor(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension) return LANGUAGES[extension] ?? null;
  if (name === 'Dockerfile') return 'dockerfile';
  return null;
}

// Fallback for anything that extension and name don't reveal: a NUL byte in
// the file's head is the most reliable sign of "binary" - valid UTF-8 text
// never contains one. Deliberately only the start: the decision must not
// cost the size of a large file to make.
const HEAD_BYTES = 8192;

function looksLikeText(absolutePath) {
  let fd;
  try {
    fd = fs.openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).indexOf(0) === -1;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function determineType(absolutePath) {
  const name = path.basename(absolutePath);
  const extension = path.extname(name).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (IMAGE_TYPES[extension]) return 'image';
  if (LANGUAGES[extension] || TEXT_EXTENSIONS.has(extension)) return 'text';
  // Dotfiles like `.gitignore` have, from path.extname's point of view,
  // only an extension and no name - without this branch .env would fall
  // through into the heuristic.
  if (!extension && (TEXT_NAMES.has(name) || name.startsWith('.'))) return 'text';
  return looksLikeText(absolutePath) ? 'text' : 'binary';
}

// stats is passed in rather than fetched here: the callers already have it
// anyway (directory listing, file view) and would otherwise have to ask the
// filesystem for it a second time.
export function describeFile(absolutePath, stats) {
  const type = determineType(absolutePath);
  const size = stats.size;
  const tooLarge = size > MAX_VIEW_BYTES;
  const extension = path.extname(absolutePath).toLowerCase();
  return {
    type,
    size,
    modified: Math.floor(stats.mtimeMs),
    tooLarge,
    editable: (type === 'markdown' || type === 'text') && !tooLarge,
    language: languageFor(path.basename(absolutePath)),
    contentType:
      IMAGE_TYPES[extension]
      ?? (type === 'binary' ? 'application/octet-stream' : 'text/plain; charset=utf-8'),
  };
}
