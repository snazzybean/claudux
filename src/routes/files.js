// Files tab: HTTP only. Validate parameters, call the module, respond -
// the logic lives in src/lib/file*.js.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, forbiddenPaths, FilePathError } from '../lib/filePath.js';
import { describeFile, MAX_VIEW_BYTES } from '../lib/fileType.js';
import { renderMarkdown, renderCode } from '../lib/fileRender.js';
import { saveFile, WriteConflict } from '../lib/fileWrite.js';

// Unusably long on a phone and never what you're looking for. Dot files
// like .env or .gitignore show up though - looking them up is a real
// reason to open the tab.
const HIDDEN_FOLDERS = new Set(['.git', 'node_modules']);

function errorResponse(res, err) {
  if (err instanceof FilePathError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return res.status(400).json({ error: 'No access to this file' });
  }
  if (err.code === 'ENOENT') {
    return res.status(404).json({ error: 'File or directory not found' });
  }
  return res.status(400).json({ error: err.message });
}

function relPathFrom(req) {
  const raw = req.query.path;
  return typeof raw === 'string' ? raw : '';
}

function listDirectory(config, absolute, root) {
  const hidden = new Set(forbiddenPaths(config));
  const entries = [];
  for (const dirent of fs.readdirSync(absolute, { withFileTypes: true })) {
    const childPath = path.join(absolute, dirent.name);
    if (hidden.has(childPath)) continue;
    let stats;
    try {
      stats = fs.statSync(childPath);
    } catch {
      continue; // dead symlink - nothing that could be opened
    }
    if (stats.isDirectory()) {
      if (HIDDEN_FOLDERS.has(dirent.name)) continue;
      entries.push({
        name: dirent.name,
        type: 'folder',
        size: null,
        modified: Math.floor(stats.mtimeMs),
      });
      continue;
    }
    if (!stats.isFile()) continue; // sockets, device files: nothing to view
    const info = describeFile(childPath, stats);
    entries.push({
      name: dirent.name,
      type: info.type,
      size: info.size,
      modified: info.modified,
    });
  }
  // Folders first, then files, each alphabetically.
  entries.sort((a, b) => {
    if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries, isRoot: absolute === root };
}

export function filesRouter(config) {
  const router = express.Router();
  // Own parser instead of the global one: express.json()'s default limit is
  // 100 kB and would reject a 900 kB text file with 413 before the route
  // even runs - even though it stays under the view limit.
  const jsonParser = express.json({ limit: MAX_VIEW_BYTES + 64 * 1024 });

  router.get('/', (req, res) => {
    try {
      const { absolute, root, rel } = resolveProjectPath(config, req.query.project, relPathFrom(req));
      if (!fs.statSync(absolute).isDirectory()) {
        return res.status(400).json({ error: 'Not a directory' });
      }
      const { entries, isRoot } = listDirectory(config, absolute, root);
      const parent = isRoot ? null : path.posix.dirname(rel).replace(/^\.$/, '');
      res.json({ path: rel, parent, entries });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  router.get('/view', (req, res) => {
    try {
      const { absolute, rel } = resolveProjectPath(config, req.query.project, relPathFrom(req));
      const stats = fs.statSync(absolute);
      if (stats.isDirectory()) return res.status(400).json({ error: 'Not a file path' });
      const info = describeFile(absolute, stats);

      const response = {
        name: path.basename(absolute),
        path: rel,
        type: info.type,
        size: info.size,
        modified: info.modified,
        editable: info.editable,
        tooLarge: info.tooLarge,
        html: null,
        raw: null,
      };
      if (info.type !== 'image' && info.type !== 'binary' && !info.tooLarge) {
        response.raw = fs.readFileSync(absolute, 'utf8');
        const directoryRel = path.posix.dirname(rel).replace(/^\.$/, '');
        response.html = info.type === 'markdown'
          ? renderMarkdown(response.raw, { projectId: req.query.project, directoryRel })
          : renderCode(response.raw, { language: info.language });
      }
      res.json(response);
    } catch (err) {
      errorResponse(res, err);
    }
  });

  router.get('/raw', (req, res) => {
    try {
      const { absolute } = resolveProjectPath(config, req.query.project, relPathFrom(req));
      const stats = fs.statSync(absolute);
      if (!stats.isFile()) return res.status(400).json({ error: 'Not a file path' });
      const info = describeFile(absolute, stats);
      const name = path.basename(absolute);

      res.setHeader('Content-Type', info.contentType);
      // An SVG runs in the same origin as the interface; called directly it
      // could execute script. In an <img> the sandbox changes nothing,
      // here it closes off the direct call.
      if (info.contentType === 'image/svg+xml') {
        res.setHeader('Content-Security-Policy', 'sandbox');
      }
      if (req.query.download) {
        const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
      }
      // Streamed instead of read: images and downloads bypass the view
      // limit and must not load into memory.
      const stream = fs.createReadStream(absolute);
      stream.on('error', (streamErr) => {
        if (!res.headersSent) return errorResponse(res, streamErr);
        res.destroy();
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (err) {
      errorResponse(res, err);
    }
  });

  router.put('/', jsonParser, (req, res) => {
    try {
      const { content, expectedModified } = req.body ?? {};
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content missing' });
      }
      if (!Number.isFinite(expectedModified)) {
        return res.status(400).json({ error: 'expectedModified missing' });
      }
      const { absolute } = resolveProjectPath(config, req.query.project, relPathFrom(req));
      const stats = fs.statSync(absolute);
      if (!stats.isFile()) return res.status(400).json({ error: 'Not a file path' });
      const info = describeFile(absolute, stats);
      if (!info.editable) {
        return res.status(400).json({
          error: info.tooLarge
            ? `Too large to edit (over ${Math.round(MAX_VIEW_BYTES / 1024)} kB)`
            : 'This file cannot be edited',
        });
      }
      if (Buffer.byteLength(content) > MAX_VIEW_BYTES) {
        return res.status(400).json({ error: 'The new content exceeds the limit' });
      }
      res.json(saveFile(absolute, content, expectedModified));
    } catch (err) {
      if (err instanceof WriteConflict) {
        return res.status(409).json({ error: err.message, modified: err.modified, raw: err.raw });
      }
      errorResponse(res, err);
    }
  });

  return router;
}
