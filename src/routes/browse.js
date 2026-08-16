// Directory browser for "+ Add folder", so the path doesn't have to be
// typed in blind. Deliberately restricted to config.browseRoot: POST
// /api/projects accepts any path, but a browse endpoint actively invites
// clicking around and shouldn't make /etc or /root browsable while doing
// so.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function browseRouter(config = {}) {
  const router = express.Router();
  // Falls back to the home directory, never to "/", which would make the
  // whole machine browsable. os.homedir() rather than process.env.HOME for
  // the reason given in config.js. Resolved once, because the check below
  // compares against realpath output: an unresolved root behind a symlink
  // would match nothing and turn every request into a 400. Keeps the
  // unresolved value when the directory doesn't exist - the per-request
  // realpathSync then produces the 400 that says so.
  const configuredRoot = config.browseRoot || os.homedir();
  let browseRoot;
  try {
    browseRoot = fs.realpathSync(configuredRoot);
  } catch {
    browseRoot = configuredRoot;
  }

  // Resolves symlinks (fs.realpathSync), so a symlink inside browseRoot
  // that points outside can't bypass the root check.
  function resolveWithinRoot(requestedPath) {
    const resolved = fs.realpathSync(path.resolve(requestedPath));
    const isRoot = resolved === browseRoot;
    const isInsideRoot = resolved.startsWith(browseRoot + path.sep);
    if (!isRoot && !isInsideRoot) return null;
    return resolved;
  }

  router.get('/', (req, res) => {
    const requested = typeof req.query.path === 'string' ? req.query.path : browseRoot;
    let resolved;
    try {
      resolved = resolveWithinRoot(requested);
    } catch {
      return res.status(400).json({ error: 'Path does not exist or is not readable' });
    }
    if (resolved === null) {
      return res.status(400).json({ error: `Only paths under ${browseRoot} are allowed` });
    }

    let entries;
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err) {
      return res.status(400).json({ error: `Could not read directory: ${err.message}` });
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    // null = root reached, "one level up" wouldn't make sense anymore
    // (the goal is "stay within browseRoot", not being able to leave it
    // itself).
    const parent = resolved === browseRoot ? null : path.dirname(resolved);

    res.json({ path: resolved, parent, dirs });
  });

  return router;
}
