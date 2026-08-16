// Save from the file view: atomic and never silently overwriting someone
// else's changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Carries the current state along: the UI can then offer either discarding
// its own version or saving again with the new modification time.
export class WriteConflict extends Error {
  constructor(modified, raw) {
    super('The file was changed in the meantime');
    this.status = 409;
    this.modified = modified;
    this.raw = raw;
  }
}

export function saveFile(absolutePath, content, expectedModified) {
  const stats = fs.statSync(absolutePath);
  const modified = Math.floor(stats.mtimeMs);
  if (modified !== expectedModified) {
    throw new WriteConflict(modified, fs.readFileSync(absolutePath, 'utf8'));
  }

  // Side file in the SAME directory: rename is only atomic within a single
  // filesystem, a detour via /tmp would not be. The name starts with a dot
  // so a concurrent listing doesn't show it as a project file.
  const sidePath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.claudux-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(sidePath, content, { mode: stats.mode & 0o777 });
    // writeFileSync only sets the mode on creation and respects the umask
    // while doing so - only chmod actually matches the original file's
    // permissions (0600 would otherwise stay 0600 only by chance).
    fs.chmodSync(sidePath, stats.mode & 0o777);
    try {
      fs.chownSync(sidePath, stats.uid, stats.gid);
    } catch {
      // Without the necessary rights, the owner stays the service's own.
      // No reason to let the save fail over that.
    }
    fs.renameSync(sidePath, absolutePath);
  } catch (err) {
    fs.rmSync(sidePath, { force: true });
    throw err;
  }

  return { modified: Math.floor(fs.statSync(absolutePath).mtimeMs) };
}
