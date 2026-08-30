// Idle session reaper: kills tmux sessions that (a) nobody has attached to
// anymore, (b) have been idle long enough AND (c) have no live child
// process in the pane that is younger than the idle threshold (e.g. a
// background task). All criteria must apply - each one individually spares
// a session (fail-safe: when in doubt, don't kill).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listTmuxSessions, killSession, tmuxTarget } from './tmuxManager.js';
import { getMeta } from './sessionMeta.js';
import { loadProjects } from './projectStore.js';
import { encodeProjectPath } from './sessionStore.js';

// The reaper may ONLY touch Claudux's own sessions, never a foreign one on
// the same shared default socket - `listTmuxSessions()` sees the whole
// server. Claudux sessions are named either like a UUID (sessions) or
// `login-<hex>` (ephemeral login sessions).
//
// Deliberately narrower than `isValidSlug` in tmuxManager.js: that only
// guards against shell injection and would let "my-own-terminal" through
// too. Fail-safe in this direction - wrongly killing a foreign session
// would be the expensive mistake, sparing one of our own the harmless one.
//
// The same predicate exists a second time in src/ttyd/attach.sh, which is
// bash and cannot import it. Change both together.
const CLAUDUX_SESSION_NAME_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|login-[0-9a-f]+)$/i;

export function isClaudux(sessionName) {
  return CLAUDUX_SESSION_NAME_RE.test(sessionName);
}

// Narrower than isClaudux: only the ephemeral `claude setup-token` sessions.
export function isLoginSession(sessionName) {
  return /^login-[0-9a-f]+$/i.test(sessionName);
}

// `isProtected` spares a session, `isUnused` works the other way round: it
// doesn't spare it, it speeds things up. A session that never had a word
// typed into it still occupies a full `claude` process and doesn't need the
// full grace period. The detection signal is the missing JSONL - Claude
// Code only creates its history on the first prompt.
//
// Both checks are injected instead of read here, so findReapable stays
// testable without the filesystem. The defaults each change nothing about
// prior behavior: a forgotten parameter must not cause the reaper to
// silently become inert or silently clean up earlier.
export async function findReapable(
  sessions,
  {
    nowEpoch,
    idleThresholdSec,
    hasLiveChildren,
    isProtected = () => false,
    isUnused = () => false,
    shortIdleThresholdSec = idleThresholdSec,
    loginIdleThresholdSec = null,
    // Which timestamp does "idle" count from? The default is the old clock,
    // so a forgotten parameter changes nothing - same reasoning as
    // isProtected/isUnused above.
    idleSinceEpoch = (s) => s.activityEpoch,
  },
) {
  const reapable = [];
  for (const s of sessions) {
    if (!isClaudux(s.name)) continue;
    if (s.attached) continue;
    // Math.min: the rule should only shorten, never extend. An oversized
    // short threshold would otherwise keep an unused session alive LONGER
    // than a used one.
    //
    // Login sessions get their own, even shorter deadline: their screen
    // shows a freshly generated token in plain text, and their purpose is
    // fulfilled as soon as it's saved. Via isUnused they would otherwise
    // run under the same deadline as a session nobody ever typed anything
    // into.
    const hasOwnLoginThreshold = isLoginSession(s.name) && loginIdleThresholdSec !== null;
    const threshold = hasOwnLoginThreshold
      ? Math.min(loginIdleThresholdSec, idleThresholdSec)
      : isUnused(s.name)
        ? Math.min(shortIdleThresholdSec, idleThresholdSec)
        : idleThresholdSec;
    if (nowEpoch - idleSinceEpoch(s) < threshold) continue;
    if (isProtected(s.name)) continue;
    // hasLiveChildren protects sessions with background jobs. For login
    // sessions that's backwards: there, `claude setup-token` itself is the
    // process meant to go away. With this rule, the short deadline would
    // never apply in exactly the abort case - when setup-token is waiting
    // for input that never comes.
    if (!hasOwnLoginThreshold && (await hasLiveChildren(s.name))) continue;
    reapable.push(s.name);
  }
  return reapable;
}

// Checks whether ANY pane of the session still has live child processes,
// e.g. a background job. A single such pane spares the session.
//
// `maxChildAgeSec` caps how long that lasts. The pane process IS `claude`,
// with no shell in between, so an MCP server configured for the session is
// a permanent child of it - which made "does claude have any child?"
// permanently true, and no session with one could ever be reaped. The cap
// separates the two without naming any process: work in flight is younger
// than the idle threshold, while an MCP server is always as old as its own
// session and therefore over the cap by the time the session is idle enough
// to be considered.
//
// `-s` queries ALL panes of the session - without it, tmux only returns the
// active window, and a pane with a running child would go undetected. The
// search goes per PID through /proc/<pid>/task/<tid>/children for EVERY
// thread, because Linux tracks child PIDs per thread, not just under the
// main TID.
// `procRoot` exists so the non-Linux path is testable on Linux; nothing in
// production passes it.
export async function hasLiveChildrenForSession(sessionName, {
  procRoot = '/proc',
  // How long a child may keep its session alive. `null` means "forever",
  // which is the behaviour this function had before the cap existed.
  maxChildAgeSec = null,
  nowEpoch = Math.floor(Date.now() / 1000),
  // Passed in only by the test that needs an unreadable boot time;
  // `undefined` means "read it from procRoot", `null` means "unavailable".
  bootEpoch,
} = {}) {
  const panePids = await new Promise((resolve) => {
    const proc = spawn('tmux', ['list-panes', '-s', '-t', tmuxTarget.session(sessionName), '-F', '#{pane_pid}']);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim().split('\n').filter(Boolean)));
    proc.on('error', () => resolve([]));
  });
  const boot = bootEpoch === undefined ? await readBootEpoch(procRoot) : bootEpoch;
  for (const panePid of panePids) {
    try {
      const taskDirs = await fs.readdir(`${procRoot}/${panePid}/task`);
      for (const tid of taskDirs) {
        const children = await fs.readFile(`${procRoot}/${panePid}/task/${tid}/children`, 'utf8');
        const childPids = children.trim().split(/\s+/).filter(Boolean);
        if (childPids.length === 0) continue;
        if (maxChildAgeSec === null) return true;
        // An age that cannot be determined counts as young, i.e. it spares -
        // same fail-safe stance as the missing-/proc branch below. Reading
        // an age is a new way to fail (no boot time, or the process gone
        // between listing and reading), and it must not become a new way to
        // kill.
        if (boot === null) return true;
        for (const childPid of childPids) {
          const startedAt = await processStartEpoch(childPid, { procRoot, bootEpoch: boot });
          if (startedAt === null) return true;
          if (nowEpoch - startedAt <= maxChildAgeSec) return true;
        }
      }
    } catch {
      // Two different failures land here: the process is gone (then this pane
      // simply has no children), or there is no /proc at all - a non-Linux
      // host, where the criterion cannot be evaluated. The second case reports
      // "has children", following this module's fail-safe stance: a session
      // whose state is unknown is not killed.
      if (!fsSync.existsSync(`${procRoot}/self`)) return true;
    }
  }
  return false;
}

// Builds the "has this session ever created a history?" check for
// findReapable. The path runs through three stops: session-meta.json names
// the projectId, projects.json the path, from which the folder name under
// ~/.claude/projects is derived (see encodeProjectPath).
//
// If the chain breaks anywhere, the session counts as USED. That's the
// decisive direction: "no file found" only means "never used" if you know
// where you should have looked. Without a meta entry, the location is
// unknown, and a wrong assumption here would clean up a running session
// early.
//
// The project list is read once, not per session: runReaperOnce evaluates a
// single tick.
export function buildIsUnused({ claudeHome, dataDir }) {
  if (!claudeHome || !dataDir) return () => false;
  let projects;
  try {
    projects = loadProjects(path.join(dataDir, 'projects.json'));
  } catch {
    return () => false;
  }
  return (sessionName) => {
    try {
      const meta = getMeta(dataDir, sessionName);
      if (!meta?.projectId) return false;
      const project = projects.find((p) => p.id === meta.projectId);
      if (!project?.path) return false;
      const file = path.join(
        claudeHome,
        'projects',
        encodeProjectPath(project.path),
        `${sessionName}.jsonl`,
      );
      return !fsSync.existsSync(file);
    } catch {
      return false;
    }
  };
}

// Sessions seen attached, by name. `session_last_attached` marks the START
// of an attach, not its end, so a tab left open all day would otherwise die
// the moment it is closed rather than four hours later. Each tick records
// what it saw; that sighting becomes a floor under the clock.
//
// In memory on purpose, like presence.js: after a restart the value falls
// back to tmux's own timestamp, which errs towards sparing.
const attachSeen = new Map();

export function recordAttachSightings(sessions, nowEpoch, seen = attachSeen) {
  for (const s of sessions) if (s.attached) seen.set(s.name, nowEpoch);
  const alive = new Set(sessions.map((s) => s.name));
  for (const name of seen.keys()) if (!alive.has(name)) seen.delete(name);
  return seen;
}

// Builds the "how long has nothing happened here?" clock.
//
// `session_activity` is the honest half of that question: it moves with any
// output in the pane, so work shows up in it, and so does an attach. What
// it cannot see is an attach during which NOTHING was drawn - a tab left
// open all day on an idle session. Its timestamp then still points at the
// start of the attach, and closing the tab would make the session reapable
// on the spot instead of four hours later.
//
// Hence the max: the sightings only ever move the deadline later, never
// earlier, so this cannot end a session sooner than the old clock would.
export function buildIdleSince({ attachSeen: seen = attachSeen } = {}) {
  return (s) => Math.max(s.activityEpoch, seen.get(s.name) ?? 0);
}

// Start time of a process as an epoch, read from /proc/<pid>/stat field 22
// plus the boot time from /proc/stat.
//
// Deliberately NOT the mtime of /proc/<pid>, which looks like the same
// thing and isn't: measured against a running MCP server it was 10.7 hours
// off, because the directory's timestamp moves with the process rather than
// marking its birth.
//
// The 100 is USER_HZ, the unit /proc reports these ticks in. It is a
// constant of the kernel's userspace ABI, not of the configured HZ.
export async function processStartEpoch(pid, { procRoot = '/proc', bootEpoch }) {
  try {
    const stat = await fs.readFile(`${procRoot}/${pid}/stat`, 'utf8');
    // comm (field 2) may contain spaces and parentheses, so everything up to
    // the LAST ')' is skipped rather than split on.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    if (!Number.isFinite(ticks)) return null;
    return bootEpoch + Math.floor(ticks / 100);
  } catch {
    return null;
  }
}

async function readBootEpoch(procRoot) {
  try {
    const stat = await fs.readFile(`${procRoot}/stat`, 'utf8');
    const line = stat.split('\n').find((l) => l.startsWith('btime '));
    const epoch = Number(line?.slice(6));
    return Number.isFinite(epoch) ? epoch : null;
  } catch {
    return null;
  }
}

export async function runReaperOnce({ idleThresholdMs, shortIdleThresholdMs, loginIdleThresholdMs, claudeHome, dataDir }) {
  const sessions = await listTmuxSessions();
  const nowEpoch = Math.floor(Date.now() / 1000);
  const idleThresholdSec = Math.floor(idleThresholdMs / 1000);
  recordAttachSightings(sessions, nowEpoch);
  const toKill = await findReapable(sessions, {
    nowEpoch,
    idleThresholdSec,
    // A child only counts as running work while it is younger than the idle
    // threshold. Past that it is a deliberately long-lived process, not a
    // task in flight - and an MCP server, which is always as old as its own
    // session, is over the cap by the time the session is idle enough to be
    // considered at all.
    hasLiveChildren: (name) => hasLiveChildrenForSession(name, { maxChildAgeSec: idleThresholdSec, nowEpoch }),
    idleSinceEpoch: buildIdleSince(),
    // Without dataDir, stick to prior behavior instead of silently
    // sparing everything.
    isProtected: dataDir ? (name) => getMeta(dataDir, name)?.protected === true : undefined,
    isUnused: buildIsUnused({ claudeHome, dataDir }),
    shortIdleThresholdSec: shortIdleThresholdMs
      ? Math.floor(shortIdleThresholdMs / 1000)
      : idleThresholdSec,
    loginIdleThresholdSec: loginIdleThresholdMs ? Math.floor(loginIdleThresholdMs / 1000) : null,
  });
  // A single failing kill-session call must not abort the entire run: the
  // remaining entries would stay unkilled until the next tick.
  const killed = [];
  for (const name of toKill) {
    try {
      await killSession(name);
      killed.push(name);
    } catch (err) {
      console.error(`Reaper: kill-session for "${name}" failed: ${err.message}`);
    }
  }
  return killed;
}

// runFn is injectable, like isProtected/isUnused/hasLiveChildren above, so
// the test gets by without a real tmux server.
export function startReaperInterval(config, {
  intervalMs = 20 * 60 * 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  runFn = runReaperOnce,
} = {}) {
  const timer = setIntervalFn(() => {
    runFn(config)
      .then((killed) => {
        if (killed.length > 0) {
          console.log(`Reaper: ended ${killed.length} idle session(s): ${killed.join(', ')}`);
        }
      })
      .catch((err) => {
        console.error('Reaper: pass failed:', err.message);
      });
  }, intervalMs);
  return () => clearIntervalFn(timer);
}
