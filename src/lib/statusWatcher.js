import path from 'node:path';
import { readRegistry, reconcile } from './sessionRegistry.js';
import { loadProjects, notifyLevel } from './projectStore.js';
import { getMeta } from './sessionMeta.js';
import { listTmuxSessions, aliveSessionNames } from './tmuxManager.js';
import { isVisible } from './presence.js';
import { notifyAllReportingGone } from './notifier.js';
import { listTargets, removeTargets } from './notificationTargets.js';
import { getAccountById } from './accountStore.js';

// How long a session has to sit still before "finished" goes out. Every
// short pause inside one piece of work is shorter than this - a turn that
// ends while a background task runs resumes within seconds.
const SETTLE_MS = 90_000;
// `shell` means background work is still running, so it stays silent. This
// is the way out for a deliberately long-lived one - a dev server would
// otherwise mute its session forever.
const SHELL_FALLBACK_MS = 600_000;

// Decides whether a status change is worth a notification.
//
// Pure: `now` comes in from outside, so the whole state machine is testable
// without a timer, without the filesystem and without a claude process.
//
// A phase ends with every change of `statusUpdatedAt`, not with the next
// `busy`. The registry carries no signal for a running background agent -
// it leaves the session on `idle` - so the settle window is what separates
// "finished" from "resumes in a moment".
export function decide(previous, current, visible, { now, settleMs = SETTLE_MS, shellFallbackMs = SHELL_FALLBACK_MS } = {}) {
  const isBusy = current.status === 'busy';
  const next = { status: current.status, statusUpdatedAt: current.statusUpdatedAt, notified: false };

  // First sighting: seed only. Without this, a restart would find no
  // previous state for any session and report every one of them as a fresh
  // transition.
  //
  // Seeding a session that is WORKING leaves the flag down: the end of that
  // turn is a transition this process did observe, and marking it as
  // already reported would swallow the first notification after every
  // deploy - the opposite mistake to the one the seed exists for.
  if (!previous) return { notify: false, state: current.status, next: { ...next, notified: !isBusy } };
  if (isBusy) return { notify: false, state: current.status, next };
  // Once per phase. The flag rises only where something actually went out or
  // was dropped for being visible - never on a pass that is merely waiting
  // for the window.
  if (previous.statusUpdatedAt === current.statusUpdatedAt && previous.notified) {
    return { notify: false, state: current.status, next: { ...next, notified: true } };
  }
  // A question and a permission prompt both block the session on an answer.
  if (current.status !== 'waiting') {
    const due = current.status === 'shell' ? shellFallbackMs : settleMs;
    if (now - current.statusUpdatedAt < due) return { notify: false, state: current.status, next };
  }
  // A suppressed notification is not made up for later: the phase happens
  // once, and a suppressed one is gone.
  return { notify: !visible, state: current.status, next: { ...next, notified: true } };
}

const BODY = {
  waiting: 'Session is asking for confirmation',
  idle: 'Session is waiting for input',
  // Only reached through the fallback: the turn ended long ago and a
  // background command is still running.
  shell: 'Turn finished, a background command is still running',
};

// `blocking` is exactly the status the session cannot leave on its own: a
// question or a permission prompt. A finished turn and the shell fallback
// both say "have a look", not "I am stuck".
export function levelAllows(level, state) {
  if (level === 'none') return false;
  if (level === 'blocking') return state === 'waiting';
  return true;
}

// One pass: reconcile the /clear pairing, then decide per carrier. Returns
// the events for the SSE stream; the notification goes out here.
export async function runWatcherOnce(config, state, {
  registryFn = () => readRegistry(config.claudeHome),
  // Two sources, deliberately: the status decision must skip corpses, and
  // reconcile must not. See the reconcile call below.
  listFn = () => listTmuxSessions(),
  isVisibleFn = isVisible,
  // Prunes right where it sends: this watcher is the actual sender, so a dead
  // subscription would otherwise survive here no matter what the route does.
  notifyFn = async (message) => {
    const targetsPath = config.notificationTargetsPath;
    removeTargets(targetsPath, await notifyAllReportingGone(config, listTargets(targetsPath), message));
  },
  // Resolved at send time, not stored: injectable so tests build their
  // config as a plain literal instead of needing a real accounts.json.
  accountNameFn = (id) => getAccountById(config.accountsSecretPath, id)?.name ?? null,
  // Injectable so the settle window is testable without waiting for it.
  nowFn = Date.now,
  // Resolved at send time like the account name, so a level changed in the
  // dialog takes effect with the next message instead of at the next
  // restart.
  notifyLevelFn = (projectId) => notifyLevel(
    loadProjects(path.join(config.dataDir, 'projects.json')).find((p) => p.id === projectId),
  ),
} = {}) {
  const registry = registryFn();
  const sessions = await listFn();
  // The same reconcile the list route runs. Keeping it here shrinks the
  // window between a /clear and the next list request to one tick. It sees
  // corpses too - a crash right after a /clear would otherwise lose the
  // pairing.
  reconcile(config.dataDir, registry, sessions.map((s) => s.name));
  // A corpse keeps its last registry value; treating it as running would
  // pulse "working" for a dead session indefinitely.
  const running = new Set(aliveSessionNames(sessions));

  const events = [];
  for (const [tmuxSession, entry] of registry) {
    if (!running.has(tmuxSession)) continue;
    const meta = getMeta(config.dataDir, tmuxSession);
    if (!meta) continue; // not a session Claudux started
    // Both ids: the frontend reports the row it has open, which after a
    // /clear is not the carrier's name.
    const visible = isVisibleFn(tmuxSession) || isVisibleFn(entry.sessionId);
    const previous = state.get(tmuxSession);
    const result = decide(previous, entry, visible, { now: nowFn() });
    state.set(tmuxSession, result.next);
    // The dot follows EVERY phase change, the notification only the ones
    // nobody is looking at - tying the event to the notification would keep
    // `busy` off the stream entirely. The first sighting counts as a change:
    // otherwise a session would wear an unmeasured state until it moved on
    // its own.
    if (!previous || previous.status !== entry.status) {
      events.push({ tmuxSession, sessionId: entry.sessionId, state: entry.status });
    }
    if (result.notify && levelAllows(notifyLevelFn(meta.projectId), result.state)) {
      await notifyFn({
        // Resolved at send time, so a rename shows up right away. The id
        // would say nothing to anyone reading the notification.
        title: `Claudux (${accountNameFn(meta.accountId) ?? 'unknown'})`,
        body: BODY[result.state] ?? 'Session changed state',
        clickUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/#/session/${entry.sessionId}` : undefined,
      });
    }
  }
  // Sessions that ended must not stay in the map for the process's lifetime.
  for (const key of state.keys()) if (!running.has(key)) state.delete(key);
  return events;
}

export function startStatusWatcherInterval(config, {
  intervalMs = 2000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  runFn = runWatcherOnce,
  onEvents = () => {},
} = {}) {
  const state = new Map();
  const timer = setIntervalFn(() => {
    runFn(config, state)
      .then(onEvents)
      .catch((err) => console.error(`statusWatcher: pass failed: ${err.message}`));
  }, intervalMs);
  timer.unref?.();
  return () => clearIntervalFn(timer);
}
