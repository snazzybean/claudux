// Claude Code asks "Select login method" on a fresh HOME even when
// CLAUDE_CODE_OAUTH_TOKEN is already set and valid - the gate is
// hasCompletedOnboarding in $HOME/.claude.json, and a token alone doesn't
// satisfy it. Answering that question would start a SECOND login next to
// the account Claudux just handed the session. Pre-setting the flag before
// a session starts skips exactly that question, nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// A sibling of the `.claude` directory, not something inside it - and
// derived from the HOME the spawned `claude` process will actually run
// under, not from config.claudeHome. That setting is a Claudux-only knob
// (CLAUDE_HOME) for where THIS server reads Claude Code's data for its own
// purposes, and it can be redirected independently of the real HOME. The
// pane's `claude` process knows nothing about CLAUDE_HOME; it resolves its
// own HOME the same way os.homedir() does here (scripts/claude-session.sh
// backfills a missing HOME via `getent passwd`, the same POSIX lookup
// os.homedir() falls back to) - so the flag must follow that, or a
// redirected CLAUDE_HOME would silently point this at the wrong file.
export function onboardingFilePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude.json');
}

// Read, set the one flag, write back - never dropping a field we didn't
// set. Idempotent (a no-op, not even a write, once the flag is already
// true) and non-destructive: unparseable JSON is left exactly as found,
// because a file we can't parse is one we must not replace on the strength
// of a parse error.
//
// Never throws. A failure here must not block a session start - worst case
// the wizard shows up, which is exactly today's behaviour.
export function ensureOnboardingCompleted(homeDir = os.homedir()) {
  const filePath = onboardingFilePath(homeDir);
  try {
    let data = {};
    // Restrictive default for a file created fresh here - it goes on to
    // carry the user's own oauthAccount block and more.
    let mode = 0o600;

    if (fs.existsSync(filePath)) {
      mode = fs.statSync(filePath).mode & 0o777;
      const raw = fs.readFileSync(filePath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      // Valid JSON that isn't a plain object can't be merged into safely.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      if (parsed.hasCompletedOnboarding === true) return;
      data = parsed;
    }

    data.hasCompletedOnboarding = true;

    // Temp file in the SAME directory plus rename: atomic only within one
    // filesystem, so no detour via os.tmpdir(). Leading dot so a concurrent
    // listing doesn't pick it up as a real file.
    //
    // No locking against a concurrent writer, deliberately. Two Claudux
    // session starts can't race here - this call is synchronous end to end
    // in one non-clustered process, so they run one after another, not
    // interleaved. The narrower case this does NOT cover: a `claude`
    // process started outside Claudux under the same HOME (a manual CLI
    // session, or one already running from before this feature existed)
    // writing to this same file between our read and our rename - whatever
    // it wrote in that instant could be lost to our rename. That window
    // only exists once per HOME, while the flag is still unset: every call
    // after the first taps the early return above and never opens the file
    // for writing at all, so the exposure doesn't recur. Not worth locking
    // for a one-time, bounded loss.
    const tmpPath = path.join(homeDir, `.claude.json.claudux-${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode });
      // writeFileSync only applies `mode` on creation and respects the
      // umask while doing so - only chmod actually guarantees it.
      fs.chmodSync(tmpPath, mode);
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  } catch {
    // See the function comment: never blocks a session start.
  }
}
