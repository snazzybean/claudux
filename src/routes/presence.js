// Accepts the frontend's heartbeat: which session is currently open and
// visible there. Used by the notify route, which should send nothing while
// someone is already looking at the session anyway (see
// src/lib/presence.js).
import express from 'express';
import { reportVisible, reportHidden } from '../lib/presence.js';
import { isValidSlug } from '../lib/tmuxManager.js';

export function presenceRouter() {
  const router = express.Router();

  // The heartbeat keeps going on a beat as long as the page is open. It
  // therefore deliberately carries no response and no state: 204, done.
  router.post('/', (req, res) => {
    const { sessionId, visible } = req.body ?? {};
    // isValidSlug protects the map from foreign values like "__proto__" -
    // the same caution as with the meta lookup in the notify route.
    if (!isValidSlug(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    if (visible) reportVisible(sessionId);
    else reportHidden(sessionId);

    res.status(204).end();
  });

  return router;
}
