// Directory browser for "+ Add folder", so the path doesn't have to be
// typed in blind. Mirrors POST /api/projects, which already accepts any
// absolute path: fencing the browse endpoint into a smaller area would
// only make clicking around less useful than typing, not safer.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function browseRouter({ startDirFn = () => os.homedir() } = {}) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const requested = typeof req.query.path === 'string' ? req.query.path : startDirFn();
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(requested));
    } catch {
      return res.status(400).json({ error: 'Path does not exist or is not readable' });
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
    // null only at the filesystem root - everywhere else there is a parent
    // to step up into, unlike the old fixed-root design that stopped there.
    const parent = resolved === path.parse(resolved).root ? null : path.dirname(resolved);

    res.json({ path: resolved, parent, dirs });
  });

  return router;
}
