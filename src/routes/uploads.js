// Paste screenshots into the terminal via clipboard. xterm.js can't handle
// images from the clipboard - the paste listener in public/app.js uploads
// the image here instead and "types" the returned path as text into the
// terminal.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// /tmp instead of relative to the project folder: the absolute path works
// independent of the session's working directory, and no real project
// folder fills up with screenshot leftovers.
const UPLOAD_DIR = '/tmp/claudux-uploads';

// Fixed allowlist instead of a generic "image/*" passthrough for the file
// extension, so the saved file never gets an extension the client can
// choose freely.
const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// A shared /tmp path that this process does not own is the classic local
// attack: someone else creates it first, or makes it group-writable, and then
// reads what lands there. Checked on every write rather than once at startup,
// because the directory can be replaced in between.
function ensureUploadDir(dir) {
  // mode only applies when mkdir CREATES the directory - an existing one keeps
  // whatever bits it has, which is exactly the case worth checking.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(dir);
  // The owner leg is skipped where there are no uids: comparing against an
  // absent process.getuid() would reject every directory, including the one
  // just created here. The mode check holds on every platform.
  const foreignOwner = typeof process.getuid === 'function' && stats.uid !== process.getuid();
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0 || foreignOwner) {
    throw new Error(`Upload directory ${dir} is not private to this process`);
  }
}

// Call this on service startup: an upload only matters for the paste that
// follows it, so anything still lying around is a leftover.
export function cleanupUploads(dir = UPLOAD_DIR) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      try {
        fs.rmSync(path.join(dir, entry), { force: true, recursive: true });
      } catch {
        // One undeletable leftover must not stop the others.
      }
    }
  } catch {
    // Directory doesn't exist yet - nothing to clean up.
  }
}

export function uploadsRouter({ uploadDir = UPLOAD_DIR } = {}) {
  const router = express.Router();

  router.post(
    '/image',
    // Own raw-body parser instead of the global express.json() - the body
    // here is raw image binary. The limit guards against accidentally
    // huge uploads.
    express.raw({ type: 'image/*', limit: '10mb' }),
    (req, res) => {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
      const ext = ALLOWED_TYPES[contentType];
      if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          error: `Expected an image body (${Object.keys(ALLOWED_TYPES).join(', ')})`,
        });
      }
      try {
        ensureUploadDir(uploadDir);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      const filePath = path.join(uploadDir, `${crypto.randomUUID()}.${ext}`);
      fs.writeFileSync(filePath, req.body, { mode: 0o600 });
      res.status(201).json({ path: filePath });
    },
  );

  return router;
}
