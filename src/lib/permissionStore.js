// What a session is being asked, for as long as it is being asked it - and
// the key every session's hook secret is derived from.
//
// In memory: a dialog must not outlive the process that was asked, and a
// stale one on disk would draw a box for a session that has long since moved
// on. Only the secret needs to survive a restart of this service, and it
// does so by being derivable rather than by being stored.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOOK_KEY_FILE = 'permission-hook.key';

// One key per installation, from which every session's secret is derived.
// Derived rather than drawn and remembered, because deploying this project
// restarts the service while `KillMode=process` leaves every `claude`
// running with the secret it was started with: a secret held in memory
// would be gone after the restart while those sessions keep sending theirs,
// and every dialog they report would be refused for the rest of their lives -
// silently, since the terminal keeps its own box either way.
//
// Read per call rather than cached, the same way the access gate reads its
// file: 32 bytes, and no cache to invalidate.
function installationKey(dataDir) {
  const keyPath = path.join(dataDir, HOOK_KEY_FILE);
  try {
    return fs.readFileSync(keyPath);
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    // `wx` rather than checking and then writing: two starts at once would
    // both find nothing, and the loser's key would replace one that has
    // already been handed to a session.
    try {
      const key = crypto.randomBytes(32);
      fs.writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
      return key;
    } catch {
      return fs.readFileSync(keyPath);
    }
  }
}

// How long a prepared id stays known. The flag only has to bridge the way
// from the spawn to the session's meta entry - after that getMeta answers
// for the id and the flag is redundant, which is why it expires instead of
// staying. The interval it covers is bounded by waitForSession's own timeout
// plus two tmux option calls, so this is wide enough for a badly loaded
// container by a long way, while an id whose session is over stops opening
// the hook route shortly after.
const PREPARED_TTL_MS = 30_000;

export function createPermissionStore({ dataDir, preparedTtlMs = PREPARED_TTL_MS }) {
  const dialogs = new Map();
  // Timestamps rather than a bare Set: an id nobody asks about again would
  // otherwise stay for the life of the process - one per session ever
  // started, each of them keeping the hook route open.
  const prepared = new Map();
  const expired = (at) => Date.now() - at > preparedTtlMs;
  return {
    put(id, dialog) { dialogs.set(id, dialog); },
    get(id) { return dialogs.get(id) ?? null; },
    clear(id) { dialogs.delete(id); },
    // Which sessions were started with a hook of their own. The session's
    // meta entry is only written after the spawn, so this is what closes the
    // window in between - see the knowsSession wiring in server.js.
    prepare(id) {
      // Swept here rather than on a timer: this is the only place the map
      // grows, so one pass per start bounds it by the sessions starting
      // inside one window.
      for (const [known, at] of prepared) {
        if (expired(at)) prepared.delete(known);
      }
      prepared.set(id, Date.now());
    },
    isPrepared(id) {
      const at = prepared.get(id);
      if (at === undefined) return false;
      if (!expired(at)) return true;
      prepared.delete(id);
      return false;
    },
    // Exported for the test that the map cannot outgrow one window's worth
    // of starts - from outside there is nothing else to look at.
    preparedCount() { return prepared.size; },
    secretFor(id) {
      return crypto.createHmac('sha256', installationKey(dataDir)).update(id).digest('hex');
    },
  };
}

// How young a payload has to be to survive a status that says no box is
// standing. The hook fires BEFORE the box is drawn, so for the moment in
// between the session still reads as working while the payload for the box
// that is coming already sits in the store - and a watcher pass can land in
// exactly that moment. Longer than a pass, so the two can never be that pair.
const STATUS_GRACE_MS = 5000;

// The store holds at most the box that is standing, and this is what enforces
// it for anyone who is not looking: the view clears a payload when it sees the
// pane without a box, but it only runs while its tab is on screen. A box
// answered in the terminal with that tab closed used to leave its title behind
// for the next box the hook fails to report.
//
// Driven from the status stream (see the watcher wiring in server.js), which
// runs whatever any browser is doing. `waiting` is the status of a session
// standing in front of a box; anything else means there is none.
export function forgetDialogIfSettled(store, { tmuxSession, state }, graceMs = STATUS_GRACE_MS) {
  if (state === 'waiting') return false;
  const held = store.get(tmuxSession);
  if (!held || Date.now() - held.at < graceMs) return false;
  store.clear(tmuxSession);
  return true;
}
