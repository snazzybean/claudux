// The PermissionRequest hook a session starts with: what it says, and the
// one file per session that carries it. It travels to `claude` in
// --settings, which makes it a start option rather than configuration.
//
// Both halves live here because they are one fact. The builder used to sit
// in tmuxManager.js, which builds tmux arguments and has nothing to do with
// what is inside this file.
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
import { listTmuxSessions, aliveSessionNames } from './tmuxManager.js';

const DIR_NAME = 'hook-settings';

// A corpse is not a session: with remain-on-exit a crashed one stays listed,
// and its file really is a leftover.
const liveSessionNames = async () => aliveSessionNames(await listTmuxSessions());

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

// The hook that tells Claudux a session is asking something. A START
// OPTION rather than configuration: it travels in --settings on the command
// line, so nothing in ~/.claude is touched and nobody has to configure
// anything - and hooks given this way add to whatever hooks already exist
// instead of replacing them.
export function buildHookSettings(port, sessionId) {
  return {
    hooks: {
      PermissionRequest: [
        {
          hooks: [
            {
              type: 'http',
              url: `http://127.0.0.1:${port}/api/permission/${sessionId}`,
              // The secret comes from the environment, not from this
              // file: a literal here would put it on disk for as long as
              // the session lives, where the file it does travel in is
              // unlinked by the wrapper the moment it has been read.
              headers: { 'x-claudux-session-secret': '$CLAUDUX_SESSION_SECRET' },
              allowedEnvVars: ['CLAUDUX_SESSION_SECRET'],
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
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
// fresh file, and what is left over belongs to a session that is over.
//
// Two conditions, and each covers a case the other cannot see. The deploy
// step is a restart, and `KillMode=process` leaves every `claude` running -
// so a file whose session is still alive is not a leftover at all, whether
// or not `claude` ever reads it again after its start. That is what the name
// check is for, and it is the common case rather than the exotic one.
//
// The mtime grace covers the one moment the name check cannot: the file is
// written a moment BEFORE the spawn, so a session starting as the service
// restarts has a file and no tmux session yet. Losing it would leave that
// session running its whole life without the hook, its permission dialogs
// appearing in the terminal only, and nothing saying so.
export async function cleanupHookSettingsFiles(dataDir, { liveNamesFn = liveSessionNames } = {}) {
  const dir = settingsDir(dataDir);
  const cutoff = Date.now() - START_GRACE_MS;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // Directory doesn't exist yet - nothing to clean up.
  }
  const live = new Set(await liveNamesFn());
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      if (live.has(path.basename(entry, '.json'))) continue;
      if (fs.statSync(filePath).mtimeMs > cutoff) continue;
      fs.rmSync(filePath, { force: true });
    } catch {
      // One unreadable or undeletable file must not leave the rest behind.
    }
  }
}
