// Hands a secret to a new session without writing it into a command line:
// /proc/<pid>/cmdline is world-readable, a value in argv would be visible to
// every local account via `ps aux` - and tmux keeps the whole start command
// for the life of the pane on top of that. The process environment
// (/proc/<pid>/environ), by contrast, is readable only by the owner.
//
// So the value lands in a file with mode 0600; scripts/claude-session.sh
// reads it, exports it, and deletes it immediately. Only the path appears in
// the command line.
//
// Two values take this route, each with its own directory and suffix so one
// kind of leftover can never be read as the other: the account token, and
// the per-session secret the PermissionRequest hook proves itself with.
//
// The files are short-lived - they exist only between the server writing
// them and the session starting. For the cases where the wrapper never gets
// to run, there are the remove and cleanup functions below.
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_DIR = 'session-tokens';
const SECRET_DIR = 'session-secrets';

// Same character set as tmuxManager.isValidSlug, checked again here rather
// than trusting the caller: the session ID becomes a filename, and a
// "../../etc/passwd" must never end up outside the directory.
const SLUG_RE = /^[a-zA-Z0-9-]{1,80}$/;

// path.resolve instead of path.join - the path MUST be absolute. `dataDir`
// defaults to a relative value, and the wrapper script resolves the path
// relative to ITS OWN working directory. That's the project path
// (`tmux new-session -c`), not the server's directory: the script wouldn't
// find the file, and for the token it would abort and leave the file behind
// with a valid token still in it.
function handoffDir(dataDir, dirName) {
  return path.resolve(dataDir, dirName);
}

function handoffPath(dataDir, dirName, suffix, sessionId) {
  if (typeof sessionId !== 'string' || !SLUG_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId for ${suffix} file: ${sessionId}`);
  }
  return path.join(handoffDir(dataDir, dirName), `${sessionId}.${suffix}`);
}

function writeHandoff(dataDir, dirName, suffix, sessionId, value) {
  const filePath = handoffPath(dataDir, dirName, suffix, sessionId);
  // Set mode explicitly - with the default umask the directory would end up
  // 0755, and while other local accounts couldn't read a value, they could
  // still list which sessions are running.
  fs.mkdirSync(handoffDir(dataDir, dirName), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  // writeFileSync doesn't re-apply the mode to an already-existing file.
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

// Best effort: the normal case is that the wrapper script has already
// deleted the file. An error here must not propagate, or it would make an
// otherwise successfully started session look like a failure.
function removeHandoff(dataDir, dirName, suffix, sessionId) {
  try {
    fs.rmSync(handoffPath(dataDir, dirName, suffix, sessionId), { force: true });
  } catch {
    // Invalid ID or the file's already gone - neither is a reason to abort.
  }
}

// Call this on service startup: after a restart, no waiting session can
// still reach an old file, so anything left over is just a remnant on disk.
function cleanupHandoff(dataDir, dirName) {
  try {
    for (const entry of fs.readdirSync(handoffDir(dataDir, dirName))) {
      try {
        fs.rmSync(path.join(handoffDir(dataDir, dirName), entry), { force: true });
      } catch {
        // One undeletable file must not leave the remaining ones on disk.
      }
    }
  } catch {
    // Directory doesn't exist yet - nothing to clean up.
  }
}

export function writeSessionTokenFile(dataDir, sessionId, token) {
  return writeHandoff(dataDir, TOKEN_DIR, 'token', sessionId, token);
}

export function removeSessionTokenFile(dataDir, sessionId) {
  removeHandoff(dataDir, TOKEN_DIR, 'token', sessionId);
}

export function cleanupSessionTokenFiles(dataDir) {
  cleanupHandoff(dataDir, TOKEN_DIR);
}

// The hook's secret, and unlike the token it IS the credential rather than a
// path to one - which is exactly why it must not travel as one. It is good
// for nothing but POST /api/permission/<this session>, and that route sits in
// front of the access gate by design, so anything that can read it can draw
// a title and a plan over a real box's buttons.
export function writeSessionSecretFile(dataDir, sessionId, secret) {
  return writeHandoff(dataDir, SECRET_DIR, 'secret', sessionId, secret);
}

export function removeSessionSecretFile(dataDir, sessionId) {
  removeHandoff(dataDir, SECRET_DIR, 'secret', sessionId);
}

export function cleanupSessionSecretFiles(dataDir) {
  cleanupHandoff(dataDir, SECRET_DIR);
}
