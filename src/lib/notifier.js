// Sends a message to every enabled target. Errors are logged per target and
// never thrown: Express 4 does not forward rejections from async handlers to
// the error middleware, and an unhandled rejection ends the process - which
// a single unreachable target would then trigger on every notification.
//
// The one exception to "swallow everything" is a subscription the push service
// calls gone. Swallowing that would mean pushing at a dead endpoint on every
// future notification, so the id is handed back. Deleting is left to the
// caller: this module receives an already-read array and has no handle on the
// store.
import { send as sendNtfy } from './notify/ntfy.js';
import { send as sendWebhook } from './notify/webhook.js';
import { send as sendWebpush, SubscriptionGoneError } from './notify/webpush.js';

const PROVIDERS = { ntfy: sendNtfy, webhook: sendWebhook, webpush: sendWebpush };

export async function notifyAll(targets, message, {
  fetchFn = fetch,
  vapidKeysPath,
  vapidSubject,
} = {}) {
  const goneIds = [];
  await Promise.all(
    targets
      .filter((target) => target.enabled !== false)
      .map(async (target) => {
        const provider = PROVIDERS[target.type];
        if (!provider) {
          console.error(`notifyAll: unknown target type "${target.type}" - skipped.`);
          return;
        }
        try {
          await provider(target.config, message, { fetchFn, vapidKeysPath, vapidSubject });
        } catch (err) {
          // Target names are safe to log, their config is not.
          if (err instanceof SubscriptionGoneError) {
            console.error(`notifyAll: target "${target.name}" is gone - removing it.`);
            goneIds.push(target.id);
            return;
          }
          console.error(`notifyAll: target "${target.name}" failed: ${err.message}`);
        }
      }),
  );
  return { goneIds };
}

// Wraps notifyAll with the installation's keypair - the config wiring every
// caller would otherwise repeat.
export async function notifyAllReportingGone(config, targets, message, { fetchFn = fetch } = {}) {
  const { goneIds } = await notifyAll(targets, message, {
    fetchFn,
    vapidKeysPath: config.vapidKeysPath,
    vapidSubject: config.vapidSubject,
  });
  return goneIds;
}
