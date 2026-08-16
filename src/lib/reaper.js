// Idle session reaper: kills tmux sessions that (a) nobody has attached to
// anymore, (b) have been idle long enough AND (c) have no live child
// process in the pane (e.g. a background task). All criteria must apply -
// each one individually spares a session (fail-safe: when in doubt, don't
// kill).
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
    if (nowEpoch - s.activityEpoch < threshold) continue;
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
// `-s` queries ALL panes of the session - without it, tmux only returns the
// active window, and a pane with a running child would go undetected. The
// search goes per PID through /proc/<pid>/task/<tid>/children for EVERY
// thread, because Linux tracks child PIDs per thread, not just under the
// main TID.
// `procRoot` exists so the non-Linux path is testable on Linux; nothing in
// production passes it.
export async function hasLiveChildrenForSession(sessionName, { procRoot = '/proc' } = {}) {
  const panePids = await new Promise((resolve) => {
    const proc = spawn('tmux', ['list-panes', '-s', '-t', tmuxTarget.session(sessionName), '-F', '#{pane_pid}']);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim().split('\n').filter(Boolean)));
    proc.on('error', () => resolve([]));
  });
  for (const panePid of panePids) {
    try {
      const taskDirs = await fs.readdir(`${procRoot}/${panePid}/task`);
      for (const tid of taskDirs) {
        const children = await fs.readFile(`${procRoot}/${panePid}/task/${tid}/children`, 'utf8');
        if (children.trim().length > 0) return true;
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

export async function runReaperOnce({ idleThresholdMs, shortIdleThresholdMs, loginIdleThresholdMs, claudeHome, dataDir }) {
  const sessions = await listTmuxSessions();
  const toKill = await findReapable(sessions, {
    nowEpoch: Math.floor(Date.now() / 1000),
    idleThresholdSec: Math.floor(idleThresholdMs / 1000),
    hasLiveChildren: hasLiveChildrenForSession,
    // Without dataDir, stick to prior behavior instead of silently
    // sparing everything.
    isProtected: dataDir ? (name) => getMeta(dataDir, name)?.protected === true : undefined,
    isUnused: buildIsUnused({ claudeHome, dataDir }),
    shortIdleThresholdSec: shortIdleThresholdMs
      ? Math.floor(shortIdleThresholdMs / 1000)
      : Math.floor(idleThresholdMs / 1000),
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
