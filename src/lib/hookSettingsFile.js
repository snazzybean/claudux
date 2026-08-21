// One settings file per session, holding the PermissionRequest hook that
// buildHookSettings() describes. It travels to `claude` in --settings, which
// makes it a start option rather than configuration.
//
// 0600 in a 0700 directory - the file names the route that accepts this
// session's dialogs, and no other local account has business in it.
//
// Every start and every resume writes the file again (see prepareHook in
// routes/sessions.js), so no session ever depends on a file older than its
// own start. That is what makes removing them possible at all: when a
// session is ended by hand, and as a sweep at service startup.
import fs from 'node:fs';
import path from 'node:path';

const DIR_NAME = 'hook-settings';

// How long a file is treated as possibly-not-yet-read by the sweep below.
// Wide on purpose: the interval it has to cover is a session start, and
// being generous costs one small file that the next sweep collects, while
// being tight costs a session its hook with nothing to show for it.
const START_GRACE_MS = 60_000;

// Same character set as tmuxManager.isValidSlug, checked again here rather
// than trusting the caller: the session ID becomes a filename, and a
// "../../etc/passwd" must never end up outside the directory.
const SLUG_RE = /^[a-zA-Z0-9-]{1,80}$/;

// path.resolve instead of path.join - the path MUST be absolute. It travels
// to tmux as an argv element and `claude` resolves it against ITS OWN
// working directory, which is the project path (`tmux new-session -c`), not
// the server's. With a relative DATA_DIR, `claude` would find no settings
// file and start without the hook - the session's permission dialogs would
// then never reach Claudux.
function settingsDir(dataDir) {
  return path.resolve(dataDir, DIR_NAME);
}

function settingsPath(dataDir, sessionId) {
  if (typeof sessionId !== 'string' || !SLUG_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId for hook settings file: ${sessionId}`);
  }
  return path.join(settingsDir(dataDir), `${sessionId}.json`);
}

export function writeHookSettingsFile(dataDir, sessionId, settings) {
  const filePath = settingsPath(dataDir, sessionId);
  const dir = settingsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode does nothing to a directory that already exists, and
  // writeFileSync's does nothing to a file that already exists.
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(filePath, JSON.stringify(settings), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

// Best effort: the caller is a route that has just ended a session, and an
// unlink error there must not turn a successful end into a failure.
export function removeHookSettingsFile(dataDir, sessionId) {
  try {
    fs.rmSync(settingsPath(dataDir, sessionId), { force: true });
  } catch {
    // Invalid ID or the file's already gone - neither is a reason to abort.
  }
}

// Call this on service startup: every session started from here on gets a
// fresh file, and the sessions that outlive a restart of this service got
// theirs at their own start.
//
// Except for the one that was starting AS the service restarted: the file is
// written a moment before `claude` gets to read it, and a restart in between
// would take it away unnoticed - that session would then run its whole life
// without the hook, with its permission dialogs appearing in the terminal
// only. Hence the grace period, keyed on the file's own mtime: nothing else
// here can tell a file that has been read from one that is about to be.
export function cleanupHookSettingsFiles(dataDir) {
  const dir = settingsDir(dataDir);
  const cutoff = Date.now() - START_GRACE_MS;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const filePath = path.join(dir, entry);
      try {
        if (fs.statSync(filePath).mtimeMs > cutoff) continue;
        fs.rmSync(filePath, { force: true });
      } catch {
        // One unreadable or undeletable file must not leave the rest behind.
      }
    }
  } catch {
    // Directory doesn't exist yet - nothing to clean up.
  }
}
