// Safe argv construction for tmux commands. A shell string is NEVER
// assembled (no `exec`, no template-literal command line) - every call goes
// through `spawn('tmux', argsArray)`. This rules out shell injection via
// sessionId/projectPath.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUtf8LocaleEnv } from './locale.js';

// Every `spawn('tmux', ...)` call in this file goes through this, so the
// locale picked by locale.js reaches tmux regardless of the entry point -
// text passed through tmux (capture-pane, send-keys, show-buffer) would
// otherwise silently fall back to the Node process's own locale.
function tmuxEnv() {
  return { ...process.env, ...getUtf8LocaleEnv() };
}

// sessionIds are UUIDs, login sessions are named `login-<hex>` - both use
// the same character set. Anything outside [a-zA-Z0-9-] is rejected.
const SLUG_RE = /^[a-zA-Z0-9-]{1,80}$/;

export function isValidSlug(id) {
  return typeof id === 'string' && SLUG_RE.test(id);
}

// tmux falls back to PREFIX matching when no session carries the exact
// name, so a bare `-t abc` reaches `abc-def` - for a capture, a keystroke
// and a kill alike. `=` pins the target to an exact match. A window or pane
// target needs the trailing `:` for tmux to accept the `=`; the same rule
// is spelled out in src/ttyd/attach.sh, which cannot import from here.
//
// Two helpers rather than one, because the distinction is the part that is
// easy to get wrong: `session` for anything session-scoped, `pane` for
// everything addressing a window or a pane inside it.
export const tmuxTarget = {
  session: (name) => `=${name}`,
  pane: (name) => `=${name}:`,
};

// Not covered by the argv rule above: `new-session -c` takes an OPTION
// value, and tmux format-expands those - a `#(…)` in the path runs a shell
// command as the service user, without any shell string ever being built.
// Absolute as well, because a relative path resolves against the service's
// working directory, which systemd doesn't guarantee.
export function isSafeProjectPath(projectPath) {
  return typeof projectPath === 'string'
    && path.isAbsolute(projectPath)
    && !projectPath.includes('#');
}

// Path to the wrapper script, resolved relative to this module (not via
// process.cwd()): the service is started by systemd, whose working
// directory isn't guaranteed to be the repo.
export const SESSION_WRAPPER_PATH = fileURLToPath(new URL('../../scripts/claude-session.sh', import.meta.url));

// The token reaches the session through a 0600 file whose path is in argv
// (see sessionTokenFile.js). A real wrapper script rather than a
// `sh -c "…"` string, so every value stays its own argv element.
export function buildNewSessionArgs({
  sessionId, projectPath, tokenFilePath, resume, hookSettingsPath, sessionSecretPath,
}) {
  if (!isValidSlug(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
  // Also checked in POST /api/projects, where it produces a 400 instead of
  // a failed session start. Kept here too: this is the function that hands
  // the value to tmux, and it must not depend on who called it.
  if (!isSafeProjectPath(projectPath)) {
    throw new Error(`Invalid projectPath: ${projectPath}`);
  }
  const args = [
    'new-session', '-d',
    '-s', sessionId,
    '-c', projectPath,
    SESSION_WRAPPER_PATH, tokenFilePath,
  ];
  // The hook's secret takes the same route as the token, down to the file:
  // what stands here is a PATH to a 0600 file, the wrapper reads it into the
  // environment and unlinks it before `claude` runs. The secret itself in
  // this slot would be world-readable for days - tmux keeps the whole start
  // command in `pane_start_command` for the life of the pane, and the tmux
  // server's own /proc/<pid>/cmdline keeps the argv of whichever session
  // started it. Derived from an installation key rather than drawn here, so
  // that a running session's hook survives a restart of this service (see
  // createPermissionStore).
  //
  // The slot is always emitted, `-` meaning "this session has none": the
  // wrapper reads it by position, and a conditional slot would have it shift
  // away claude's first option instead - with --session-id that leaves the
  // session out of the sidebar entirely (see below).
  args.push(sessionSecretPath || '-');
  if (hookSettingsPath) args.push('--settings', hookSettingsPath);
  if (resume) {
    args.push('--resume', sessionId);
  } else {
    // --session-id gives Claude Code the ID instead of letting it invent
    // its own. Without this, two separate numbering schemes run side by
    // side: Claudux names the tmux session after this UUID, Claude Code
    // writes its JSONL history under one of its own. The sidebar lists the
    // history, `live` resolves via the tmux name - the two never meet, and
    // a new session doesn't show up in the list at all.
    args.push('--session-id', sessionId);
  }
  return args;
}

// Printed by THIS shell command, not by `claude setup-token` itself - and
// only once it has already exited. Every other signal loginScreen.js reads
// is CLI wording that could drift with a future release; this one can't,
// which is why it's the authoritative "the output is actually finished"
// check there, ahead of any text-shape heuristic.
export const LOGIN_DONE_MARKER = '>>> Select the token above and copy it, then Enter to close <<<';

// Wide and tall enough that a ~100-character OAuth token never wraps - a
// wrapped token can pass loginScreen.js's completeness check as complete.
// Not wider: a window wider than the attached client is clipped, not
// scrolled.
export const LOGIN_WINDOW_COLS = 140;
export const LOGIN_WINDOW_ROWS = 50;

// Argv for the ephemeral login session (POST /api/accounts/login-session).
//
// The trailing `read` keeps the session open until the token is copied:
// tmux ends a session as soon as its command finishes - a bare
// `claude setup-token` would only flash the token briefly. Chained with `;`
// instead of `&&`, so an error message from setup-token stays on screen;
// with `&&` the session would close exactly when there's something to read.
//
// Hint text in ASCII, because the tmux environment runs under the `C`
// locale.
export function buildLoginSessionArgs(sessionName) {
  if (!isValidSlug(sessionName)) {
    throw new Error(`Invalid session name: ${sessionName}`);
  }
  const command =
    'claude setup-token; ' +
    `printf "\\n${LOGIN_DONE_MARKER}\\n"; ` +
    'read _';
  return [
    'new-session', '-d',
    '-s', sessionName,
    '-x', String(LOGIN_WINDOW_COLS), '-y', String(LOGIN_WINDOW_ROWS),
    'sh', '-c', command,
  ];
}

// -x/-y on `new-session` only set the INITIAL size - tmux's default
// window-size mode (`latest`) would still resize the window to match
// whatever client attaches later ("Show terminal"), undoing the point of
// fixing it. `manual` opts this window out permanently.
export function pinLoginWindowSize(name) {
  return new Promise((resolve) => {
    if (!isValidSlug(name)) {
      resolve();
      return;
    }
    const proc = spawn('tmux', ['set-window-option', '-t', tmuxTarget.pane(name), 'window-size', 'manual'], { env: tmuxEnv() });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

// Without this, tmux tears down the WHOLE session when `claude` dies, and
// every attached ttyd client runs into an unthrottled reconnect. A dead but
// listed pane is what the resume route needs to diagnose and replace it.
// Not global (`-g`): the same tmux server hosts foreign sessions.
export function setRemainOnExit(name) {
  return new Promise((resolve) => {
    if (!isValidSlug(name)) {
      resolve();
      return;
    }
    const proc = spawn('tmux', ['set-window-option', '-t', tmuxTarget.pane(name), 'remain-on-exit', 'on'], { env: tmuxEnv() });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

export function parseSessionList(rawOutput) {
  return rawOutput
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, activityEpoch, attached, createdEpoch, dead, deadStatus, deadSignal] = line.split('\t');
      // A SIGKILL leaves pane_dead_status empty and reports through
      // pane_dead_signal; an exit code does the reverse. Hence two fields,
      // and `null` rather than NaN for the one that stays empty.
      const num = (v) => (v === undefined || v === '' ? null : Number(v));
      return {
        name,
        activityEpoch: Number(activityEpoch),
        // #{session_attached} is the COUNT of attached clients, not a 0/1
        // flag: with phone and laptop attached at once, tmux returns "2". A
        // comparison against `=== '1'` would treat that as not attached -
        // risky for the idle reaper, which may only kill when nobody is
        // watching.
        attached: Number(attached) > 0,
        // Start time of the tmux session. It's the only clue for sessions
        // that don't have a JSONL file yet - Claude Code only creates that
        // on the first prompt. `null` instead of NaN when the field is
        // missing.
        createdEpoch: createdEpoch === undefined ? null : Number(createdEpoch),
        dead: dead === '1',
        deadStatus: num(deadStatus),
        deadSignal: num(deadSignal),
      };
    });
}

// The colon as field separator is a structural guarantee, not a
// coincidence: tmux already sanitizes it to "_" at session CREATION time,
// so no session name can ever contain one. In the -F format string,
// however, it stays unchanged.
//
// Control characters are ruled out too - tmux also rewrites tab and
// newline to "_" in the format, others to visible escape sequences. A
// comma is ruled out because `listTmuxSessions` sees the entire tmux
// server: foreign sessions aren't subject to SLUG_RE and may carry a comma
// in their name, whose name field would then swallow the following fields.
const FIELD_SEP = ':';
const TMUX_LIST_FORMAT = `#{session_name}${FIELD_SEP}#{session_activity}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_created}${FIELD_SEP}#{pane_dead}${FIELD_SEP}#{pane_dead_status}${FIELD_SEP}#{pane_dead_signal}`;

// Exported on its own so this step stays testable without a real tmux
// server.
export function normalizeTmuxListOutput(rawOutput) {
  return rawOutput
    .split('\n')
    .map((line) => line.split(FIELD_SEP).join('\t'))
    .join('\n');
}

export function listTmuxSessions() {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['list-sessions', '-F', TMUX_LIST_FORMAT], { env: tmuxEnv() });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    // "No tmux server running" ends with a non-zero exit code, but for the
    // caller that simply means "no sessions" - hence no reject.
    proc.on('close', () => resolve(parseSessionList(normalizeTmuxListOutput(out))));
    proc.on('error', () => resolve([]));
  });
}

// "Running" means the session exists AND its pane is alive. With
// remain-on-exit a crashed session stays listed, and everything that asks
// "is this running" would otherwise read a corpse as alive. The filter
// sits here, not inside listTmuxSessions, because some callers want only
// the alive names (this function) while others need the corpses too.
export function aliveSessionNames(sessions) {
  return sessions.filter((s) => !s.dead).map((s) => s.name);
}

// Was the death unwanted? Exit 0 means /exit or Ctrl+D - the user meant it.
export function isUnwantedDeath(session) {
  if (!session?.dead) return false;
  return session.deadSignal !== null || session.deadStatus !== 0;
}

// Exit code 0 = exists, anything else (incl. "no server running") =
// doesn't exist. No reject: "doesn't exist" is a normal state.
export function hasSession(name) {
  return new Promise((resolve) => {
    if (!isValidSlug(name)) {
      resolve(false);
      return;
    }
    const proc = spawn('tmux', ['has-session', '-t', tmuxTarget.session(name)], { env: tmuxEnv() });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// Waits until a session started via spawnTmux (fire-and-forget) actually
// exists. Without this, the route would respond with 201 immediately, the
// frontend would set the ttyd iframe src, and it would attach against a
// session that doesn't exist yet ("can't find session"). Polling instead of
// a fixed sleep, because startup time varies with host load. Returns even
// after the deadline passes (no reject) - a hard failure of the tmux binary
// is already logged by spawnTmux.
export async function waitForSession(name, { timeoutMs = 2000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await hasSession(name)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Hides tmux's own status bar - Claudux already shows the breadcrumb and
// account badge itself. A separate spawn call instead of a `;`-chain onto
// `new-session`, because tmux's argv grammar for the shell-command part is
// too poorly documented to rely on for security-relevant argv construction.
// Not global (`-g`): the same tmux server hosts foreign sessions this
// shouldn't affect.
export function disableStatusBar(name) {
  return new Promise((resolve) => {
    if (!isValidSlug(name)) {
      resolve();
      return;
    }
    // `status` is a session option, but set-option parses its `-t` as a
    // PANE target: the session form is answered with "no such session"
    // (verified against tmux 3.5a). Hence the pane form here.
    const proc = spawn('tmux', ['set-option', '-t', tmuxTarget.pane(name), 'status', 'off'], { env: tmuxEnv() });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

export function spawnTmux(args, { spawnFn = spawn } = {}) {
  const child = spawnFn('tmux', args, {
    stdio: 'ignore',
    detached: true,
    env: tmuxEnv(),
  });
  // Without this listener, Node throws an unhandled exception on an
  // 'error' event (missing tmux binary) and takes the Express server down
  // with it. `spawnTmux` is fire-and-forget, so only logging - whoever
  // needs to react to success uses the promise-based APIs.
  child.on('error', (err) => {
    console.error('spawnTmux: could not start tmux:', err.message);
  });
  child.unref();
}

export function killSession(name) {
  return new Promise((resolve, reject) => {
    if (!isValidSlug(name)) {
      reject(new Error(`Invalid session name: ${name}`));
      return;
    }
    const proc = spawn('tmux', ['kill-session', '-t', tmuxTarget.session(name)], { env: tmuxEnv() });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`kill-session failed (exit code ${code})`));
    });
    proc.on('error', (err) => reject(err));
  });
}

// Reads the visible content of a session's pane. Unlike showBuffer(), this
// is genuinely session-scoped: the exact target addresses one session,
// foreign ones on the same tmux server stay untouched.
//
// Needed because an expired login leaves neither an exit code nor a status
// file - the `claude` process keeps running, tmux reports the session as
// active, the only trace is the text in the pane (see authStatus.js).
//
// Only the VISIBLE area (no `-S -`/history): the auth message always ends
// up last in the pane, and the full history would be needlessly expensive
// on a call made at regular intervals.
export function capturePane(name) {
  return new Promise((resolve, reject) => {
    if (!isValidSlug(name)) {
      reject(new Error(`Invalid session name: ${name}`));
      return;
    }
    const proc = spawn('tmux', ['capture-pane', '-p', '-t', tmuxTarget.pane(name)], { env: tmuxEnv() });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    // A non-zero exit code practically always means "session ended in the
    // meantime". Empty string instead of reject, otherwise the auth check
    // would abort for a session that just closed.
    proc.on('close', (code) => resolve(code === 0 ? stdout : ''));
    proc.on('error', () => resolve(''));
  });
}

// The width belongs with the pane text: without it there's no way to tell
// which line wrapped and which one ended (see loginScreen.js).
export function paneWidth(name) {
  return new Promise((resolve, reject) => {
    if (!isValidSlug(name)) {
      reject(new Error(`Invalid session name: ${name}`));
      return;
    }
    const proc = spawn('tmux', ['display-message', '-p', '-t', tmuxTarget.pane(name), '#{pane_width}'], { env: tmuxEnv() });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    // 0 instead of reject for an ended session - same as capturePane
    // returning the empty string. The caller polls on a beat.
    proc.on('close', (code) => resolve(code === 0 ? Number.parseInt(stdout.trim(), 10) || 0 : 0));
    proc.on('error', () => resolve(0));
  });
}

// Sends text into a session, followed by Enter.
//
// `-l` writes the text literally instead of interpreting names like "Enter"
// or "C-c" as keys; `--` stops a leading dash from being read as an option.
// Enter follows as its own call, because under `-l` it wouldn't be a key at
// all.
export function sendKeys(name, text) {
  if (!isValidSlug(name)) return Promise.reject(new Error(`Invalid session name: ${name}`));
  const run = (args) =>
    new Promise((resolve, reject) => {
      const proc = spawn('tmux', args, { env: tmuxEnv() });
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tmux send-keys exit ${code}`))));
      proc.on('error', reject);
    });
  return run(['send-keys', '-t', tmuxTarget.pane(name), '-l', '--', text]).then(() =>
    run(['send-keys', '-t', tmuxTarget.pane(name), 'Enter']),
  );
}

// Reads the most recently set tmux buffer for the copy feature.
//
// Buffers are server-global, NOT per session - a session reference in the
// calling route would be misleading and is deliberately absent.
//
// Why server-side at all: Ctrl+C in the terminal already copies into the
// tmux buffer, but the last mile into the browser clipboard is normally
// taken over by the terminal emulator via OSC-52 - the ttyd version
// installed here predates the commit that teaches xterm OSC-52. The
// frontend writes the text read here via navigator.clipboard.writeText().
export function showBuffer({ spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn('tmux', ['show-buffer'], { env: tmuxEnv() });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `show-buffer failed (exit code ${code})`));
    });
    proc.on('error', (err) => reject(err));
  });
}
