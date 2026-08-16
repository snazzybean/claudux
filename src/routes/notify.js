// The hand-callable entry to a notification: reports that a session is
// waiting for input, and goes out to every configured target.
import express from 'express';
import { notifyAllReportingGone } from '../lib/notifier.js';
import { listTargets, removeTargets } from '../lib/notificationTargets.js';
import { getMeta } from '../lib/sessionMeta.js';
import { isValidSlug } from '../lib/tmuxManager.js';
import { isVisible } from '../lib/presence.js';
import { getAccountById } from '../lib/accountStore.js';

export function notifyRouter(config) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const { sessionId, message } = req.body ?? {};
    // The session ID comes from whoever calls this route and can be
    // missing. That deliberately does NOT lead to 400 - the notification
    // then goes out degraded (account "unknown", no click link) instead of
    // staying silent in exactly this case. isValidSlug additionally blocks
    // foreign values like "__proto__", which getMeta() would otherwise
    // report as "found".
    //
    // If someone is currently looking at this session, the notification
    // would just be noise - a notification goes out after EVERY response.
    // Still 204 though: from the caller's perspective nothing went wrong,
    // there was simply nothing to report. Per session, not global,
    // otherwise one open tab would silence every other session.
    if (isValidSlug(sessionId) && isVisible(sessionId)) {
      return res.status(204).end();
    }

    const meta = isValidSlug(sessionId) ? getMeta(config.dataDir, sessionId) : null;
    const account = getAccountById(config.accountsSecretPath, meta?.accountId)?.name ?? 'unknown';

    // No try/catch: notifyAll never rejects (see notifier.js), and the
    // caller cannot act on a status anyway - hence 204 either way.
    const goneIds = await notifyAllReportingGone(config, listTargets(config.notificationTargetsPath), {
      title: `Claudux (${account})`,
      body: message || 'Session is waiting for input',
      // Without a base url this would interpolate to the relative
      // "/#/session/<id>" - truthy, so it would travel as a Click header the
      // push service cannot use.
      clickUrl: config.publicBaseUrl && isValidSlug(sessionId)
        ? `${config.publicBaseUrl}/#/session/${sessionId}`
        : undefined,
    });
    // A push subscription the service called gone stays gone. Left in place
    // it would be pushed at on every future notification, forever.
    removeTargets(config.notificationTargetsPath, goneIds);
    res.status(204).end();
  });

  return router;
}
