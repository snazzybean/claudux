// The route the PermissionRequest hook calls, and the one the conversation
// view reads it back through.
//
// The hook answers `escalate` on purpose: the event fires INSTEAD of the
// terminal dialog, so an allow or deny would resolve the request without
// anyone being asked, and a hook left pending while someone decides on a
// phone leaves the person at the terminal in front of a session that looks
// stalled. With escalate the terminal keeps its own dialog, Claudux still
// learns what is being asked, and whoever answers first wins.
//
// Two routers rather than one, because they authenticate differently - see
// the mount site in server.js.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOOK_KEY_FILE = 'permission-hook.key';

// A tool input is written by the model in a single message, so its size is
// bounded by the model's own output limit - but far above the 100 kB the
// global parser allows. A `Write` of a large file is the case that hits it,
// and a 413 there would leave the view showing no dialog while the terminal
// sits waiting.
export const MAX_HOOK_BODY = 1024 * 1024;

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

// The dialogs stay in memory: one must not outlive the process that was
// asked, and a stale dialog on disk would draw a box for a session that has
// long since moved on. Only the secret needs to survive a restart, and it
// does so by being derivable rather than by being stored.
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

// Timing-safe compare, and length-safe: timingSafeEqual throws on differing
// lengths, which would leak the length through a 500.
function secretMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function permissionHookRouter(config, { store, knowsSession }) {
  const router = express.Router();
  // Its own parser, and the global one is exempted from this path in
  // server.js: the app-level parser runs first and would already have
  // answered 413 before this router ever saw the request.
  //
  // On the route, not on the router: this one is mounted at /api, so a
  // router-wide parser would parse every other /api request as well and
  // hand it this limit instead of the global one.
  const hookParser = express.json({ limit: MAX_HOOK_BODY });

  router.post('/permission/:id', hookParser, (req, res) => {
    const { id } = req.params;
    if (!knowsSession(id)) return res.status(404).json({ error: 'Unknown session' });
    // The only authentication this route has: it sits in front of the access
    // gate, because the caller is the `claude` process and has no cookie.
    if (!secretMatches(store.secretFor(id), req.get('x-claudux-session-secret'))) {
      return res.status(403).json({ error: 'Bad session secret' });
    }
    const payload = req.body ?? {};
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    // Nothing usable arrived. Still answered, so the hook is never left
    // hanging, but nothing is stored: an all-empty dialog would draw an
    // empty card next to a terminal showing a real box.
    if (!toolName) return res.json({ decision: 'escalate' });
    store.put(id, {
      toolName,
      toolInput: payload.tool_input ?? null,
      suggestions: payload.permission_suggestions ?? null,
      promptId: typeof payload.prompt_id === 'string' ? payload.prompt_id : null,
      at: Date.now(),
    });
    res.json({ decision: 'escalate' });
  });

  return router;
}

export function permissionViewRouter(config, { store, knowsSession }) {
  const router = express.Router();

  router.get('/permission/:id', (req, res) => {
    const { id } = req.params;
    if (!knowsSession(id)) return res.status(404).json({ error: 'Unknown session' });
    res.json({ dialog: store.get(id) });
  });

  router.delete('/permission/:id', (req, res) => {
    const { id } = req.params;
    if (!knowsSession(id)) return res.status(404).json({ error: 'Unknown session' });
    store.clear(id);
    res.json({ ok: true });
  });

  return router;
}
