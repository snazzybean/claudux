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
import { isValidSlug } from '../lib/tmuxManager.js';

// A tool input is written by the model in a single message, so its size is
// bounded by the model's own output limit - but far above the 100 kB the
// global parser allows. A `Write` of a large file is the case that hits it,
// and a 413 there would leave the view showing no dialog while the terminal
// sits waiting.
export const MAX_HOOK_BODY = 1024 * 1024;

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
    // One answer for all three refusals, and the secret is checked before
    // the session is looked up. This route sits in front of the access gate
    // on an instance that is reachable from the internet, so a 404 for an
    // unknown id beside a 403 for a known one is a list of valid session ids
    // for anyone who asks. The secret is the only authentication there is
    // here - the caller is the `claude` process and has no cookie - and a
    // caller who has it learns nothing from the difference.
    //
    // The slug check is what sessions.js does on every route that takes an
    // id. Nothing below builds a path from it, so this is consistency rather
    // than a hole - the kind that stops being cosmetic the first time
    // someone keys a filename on it.
    if (!isValidSlug(id)
      || !secretMatches(store.secretFor(id), req.get('x-claudux-session-secret'))
      || !knowsSession(id)) {
      return res.status(403).json({ error: 'Unknown session or bad secret' });
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

  // These two are behind the gate, so they can go on saying which sessions
  // exist - whoever asks has already proved they may. The slug check is the
  // one sessions.js makes on every route that takes an id.
  router.get('/permission/:id', (req, res) => {
    const { id } = req.params;
    if (!isValidSlug(id)) return res.status(400).json({ error: 'Invalid session ID' });
    if (!knowsSession(id)) return res.status(404).json({ error: 'Unknown session' });
    res.json({ dialog: store.get(id) });
  });

  router.delete('/permission/:id', (req, res) => {
    const { id } = req.params;
    if (!isValidSlug(id)) return res.status(400).json({ error: 'Invalid session ID' });
    if (!knowsSession(id)) return res.status(404).json({ error: 'Unknown session' });
    store.clear(id);
    res.json({ ok: true });
  });

  return router;
}
