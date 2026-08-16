// Web Push to a single browser subscription. Unlike ntfy and webhook there is
// no url anybody typed: the endpoint comes from the browser, and the payload
// is encrypted for that one device.
import { encryptPayload, buildVapidHeader } from './webpushCrypto.js';
import { getVapidKeys } from '../vapidKeys.js';

// How long the push service keeps the message while the device is offline.
// Four hours: a notification about a finished turn is worthless the next
// morning, but a phone in a pocket should still get it.
const TTL_SECONDS = 4 * 60 * 60;

// Its own type so the dispatcher can tell "this device is gone for good" from
// "the push service had a bad minute". Only 404 and 410 are final (RFC 8030);
// everything else stays a logged failure and the target stays.
export class SubscriptionGoneError extends Error {
  constructor(status) {
    // No endpoint in the message: together with the keys it is the credential
    // for pushing to this device, and messages end up in the log.
    super(`subscription is gone (${status})`);
    this.name = 'SubscriptionGoneError';
  }
}

export async function send(config, { title, body, clickUrl }, {
  fetchFn = fetch,
  vapidKeysPath,
  vapidSubject,
} = {}) {
  const keys = getVapidKeys(vapidKeysPath);
  const payload = encryptPayload(
    Buffer.from(JSON.stringify({ title, body, ...(clickUrl ? { url: clickUrl } : {}) })),
    config.keys.p256dh,
    config.keys.auth,
  );

  const res = await fetchFn(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(TTL_SECONDS),
      Authorization: buildVapidHeader(config.endpoint, keys, vapidSubject),
    },
    body: payload,
  });

  if (res.status === 404 || res.status === 410) throw new SubscriptionGoneError(res.status);
  if (!res.ok) {
    // 403 gets its own hint because it has two quite different causes and the
    // log is where this gets diagnosed: either the token was signed with a
    // keypair this subscription does not know (a replaced vapid.json - the
    // device has to register again), or the token itself was rejected over its
    // sub/aud/expiry, which Apple's service is strict about. Neither is a dead
    // device, so the target stays either way.
    const hint = res.status === 403
      ? ' - either the keypair does not match this subscription, or the token was rejected (check VAPID_SUBJECT)'
      : '';
    throw new Error(`push service responded with ${res.status} ${res.statusText}${hint}`);
  }
}
