// Hands the account token to a new session without writing it into a
// command line: /proc/<pid>/cmdline is world-readable, a token in argv
// would be visible to every local account via `ps aux`. The process
// environment (/proc/<pid>/environ), by contrast, is readable only by the
// owner.
//
// So the token lands in a file with mode 0600; scripts/claude-session.sh
// reads it, exports the value, and deletes it immediately. Only the path
// appears in the command line.
//
// The file is short-lived - it exists only between the server writing it
// and the session starting. For the cases where the wrapper never gets to
// run, there's removeSessionTokenFile() and cleanupSessionTokenFiles().
import fs from 'node:fs';
import path from 'node:path';

const DIR_NAME = 'session-tokens';

// Same character set as tmuxManager.isValidSlug, checked again here rather
// than trusting the caller: the session ID becomes a filename, and a
// "../../etc/passwd" must never end up outside the directory.
const SLUG_RE = /^[a-zA-Z0-9-]{1,80}$/;

// path.resolve instead of path.join - the path MUST be absolute. `dataDir`
// defaults to a relative value, and the wrapper script resolves the path
// relative to ITS OWN working directory. That's the project path
// (`tmux new-session -c`), not the server's directory: the script wouldn't
// find the token file, would abort, and the file would be left behind with
// a valid token still in it.
function tokenDir(dataDir) {
  return path.resolve(dataDir, DIR_NAME);
}

function tokenPath(dataDir, sessionId) {
  if (typeof sessionId !== 'string' || !SLUG_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId for token file: ${sessionId}`);
  }
  return path.join(tokenDir(dataDir), `${sessionId}.token`);
}

export function writeSessionTokenFile(dataDir, sessionId, token) {
  const filePath = tokenPath(dataDir, sessionId);
  // Set mode explicitly - with the default umask the directory would end up
  // 0755, and while other local accounts couldn't read a token, they could
  // still list which sessions are running.
  fs.mkdirSync(tokenDir(dataDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, token, { mode: 0o600 });
  // writeFileSync doesn't re-apply the mode to an already-existing file.
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

// Best effort: the normal case is that the wrapper script has already
// deleted the file. An error here must not propagate, or it would make an
// otherwise successfully started session look like a failure.
export function removeSessionTokenFile(dataDir, sessionId) {
  try {
    fs.rmSync(tokenPath(dataDir, sessionId), { force: true });
  } catch {
    // Invalid ID or the file's already gone - neither is a reason to abort.
  }
}

// Call this on service startup: after a restart, no waiting session can
// still reach an old file, so anything left over is just a token remnant on
// disk.
export function cleanupSessionTokenFiles(dataDir) {
  try {
    for (const entry of fs.readdirSync(tokenDir(dataDir))) {
      try {
        fs.rmSync(path.join(tokenDir(dataDir), entry), { force: true });
      } catch {
        // One undeletable file must not leave the remaining tokens on disk.
      }
    }
  } catch {
    // Directory doesn't exist yet - nothing to clean up.
  }
}
