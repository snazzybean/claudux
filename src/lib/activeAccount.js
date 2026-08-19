// Determines which account a running session is ACTUALLY using - from the
// token in the process, not from the stored mapping.
//
// session-meta.json holds only what Claudux remembered at start time, and
// that can drift: the meta entry can end up attached to a different ID than
// the row in the list, and a stored token can be invalid, so the session
// silently runs under a different auth source. A wrong account display is
// worse than none once two subscriptions with separate rate limits are in
// play.
//
// The read itself is per platform (see readEnviron below) - only the
// owner can read either form, which is also what the token handoff in
// sessionTokenFile.js relies on. Token values are NEVER returned or logged
// here.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

// Linux's /proc/<pid>/environ is NUL-separated ("KEY=value\0KEY=value\0…") -
// exact, no ambiguity: the key must sit right at the start or right after a
// NUL. macOS has no procfs; `ps -Eww` is the platform's only user-space
// window into another process's environment, and it joins entries with
// plain spaces instead ("KEY=value KEY=value …", preceded by the command
// and its args), where a value containing a space (PATH entries do) would
// otherwise be mistaken for a key boundary.
//
// The two formats need different confidence, not a shared pattern: NUL
// presence in `raw` proves it's real environ data, so ONLY the exact match
// is tried there - a whitespace fallback would let a value that merely
// CONTAINS the key text (e.g. some earlier var's value quoting it) be
// mistaken for the real variable. Without any NUL, `raw` can only be the
// ps-style dump, where whitespace is the sole boundary there is.
const NUL_ANCHORED = new RegExp(`(?:^|\\0)${ENV_KEY}=([^\\0]*)`);
const WHITESPACE_ANCHORED = new RegExp(`(?:^|\\s)${ENV_KEY}=(\\S*)`);

export function tokenFromEnv(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.includes('\0')) {
    const match = raw.match(NUL_ANCHORED);
    return match ? match[1] : null;
  }
  const match = raw.match(WHITESPACE_ANCHORED);
  return match ? match[1] : null;
}

function readEnviron(pid) {
  if (os.platform() === 'darwin') {
    return execFileAsync('ps', ['-Eww', '-p', String(pid)]).then((r) => r.stdout);
  }
  return fs.readFile(`/proc/${pid}/environ`, 'utf8');
}

// A single `tmux list-panes -a` call for all sessions instead of one per
// row - this lookup runs on every load of the session list.
//
// The delimiter is the colon, for the same structural reason as in
// tmuxManager.js: tmux doesn't allow it in session names.
export function parsePaneList(raw) {
  const seen = new Set();
  const result = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    const sep = line.lastIndexOf(':');
    if (sep === -1) continue;
    const sessionName = line.slice(0, sep);
    const panePid = line.slice(sep + 1).trim();
    // Multiple panes per session are possible; the first one is enough,
    // they all share the same process environment.
    if (seen.has(sessionName)) continue;
    seen.add(sessionName);
    result.push({ sessionName, panePid });
  }
  return result;
}

function listPanes() {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['list-panes', '-a', '-F', '#{session_name}:#{pane_pid}']);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    // No tmux server means "no sessions", not an error (as in
    // listTmuxSessions).
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
  });
}

// Returns a map sessionName -> { accountId, hasToken }.
//   accountId: id of the stored account, or null if the token belongs to
//              no known account, or none is set at all
//   hasToken:  whether a CLAUDE_CODE_OAUTH_TOKEN is present at all
//
// That distinction is the whole point: "no token set" and "token belongs
// to no known account" are different problems.
//
// `resolver` is a function (token) => id|null, in practice
// accountStore.accountIdForToken. Passed in as a callback so token values
// never have to leave the store.
export async function resolveActiveAccounts(resolver, {
  listPanesFn = listPanes,
  readEnvironFn = readEnviron,
} = {}) {
  const map = new Map();
  for (const { sessionName, panePid } of parsePaneList(await listPanesFn())) {
    let token;
    try {
      token = tokenFromEnv(await readEnvironFn(panePid));
    } catch {
      // Process has since exited, or environ isn't readable - then it stays
      // "unknown", and callers fall back to the metadata.
      continue;
    }
    map.set(sessionName, { accountId: resolver(token), hasToken: Boolean(token) });
  }
  return map;
}
