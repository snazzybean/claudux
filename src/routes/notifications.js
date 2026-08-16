// HTTP for the notification targets. The store decides what is a secret;
// this router only makes sure nothing beyond listTargetsForApi() leaves the
// process.
import express from 'express';
import {
  listTargets,
  listTargetsForApi,
  addTarget,
  updateTarget,
  removeTarget,
  removeTargets,
  findByEndpoint,
} from '../lib/notificationTargets.js';
import { notifyAllReportingGone } from '../lib/notifier.js';
import { getVapidKeys } from '../lib/vapidKeys.js';

// webpush is deliberately absent: such a target needs a real browser with
// granted permission and is created only through /subscribe, never from typed
// fields.
const TYPES = ['ntfy', 'webhook'];

// Without these the target is accepted and then fails as a notification that
// simply never arrives - the one failure mode nobody notices. This is the
// boundary check and nothing more: the provider still owns the shape of its
// config (notificationTargets.js keeps it opaque on purpose), only the field
// it cannot work without is required here. A new provider type needs an entry
// here as well as its module, or its targets are accepted unchecked.
const REQUIRED_CONFIG = { ntfy: ['url', 'topic'], webhook: ['url'] };

function missingConfigField(type, targetConfig) {
  const required = REQUIRED_CONFIG[type] ?? [];
  return required.find((field) => {
    const value = targetConfig?.[field];
    return typeof value !== 'string' || value.trim() === '';
  }) ?? null;
}

export function notificationsRouter(config) {
  const router = express.Router();
  const targetsPath = () => config.notificationTargetsPath;

  router.get('/targets', (req, res) => {
    res.json({ targets: listTargetsForApi(targetsPath()) });
  });

  router.post('/targets', (req, res) => {
    const { type, name, config: targetConfig, enabled } = req.body ?? {};
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Unknown target type' });
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Name is required' });
    }
    const missing = missingConfigField(type, targetConfig);
    if (missing) return res.status(400).json({ error: `${missing} is required for a ${type} target` });
    const id = addTarget(targetsPath(), { type, name: name.trim(), enabled, config: targetConfig });
    res.status(201).json({ id });
  });

  router.patch('/targets/:id', (req, res) => {
    const { name, enabled, config: targetConfig } = req.body ?? {};
    const patch = {};
    if (typeof name === 'string' && name.trim() !== '') patch.name = name.trim();
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    // An absent config means "unchanged" - that is how a target gets renamed
    // or switched off without retyping its secret.
    if (targetConfig && typeof targetConfig === 'object') patch.config = targetConfig;
    if (!updateTarget(targetsPath(), req.params.id, patch)) {
      return res.status(404).json({ error: 'Target not found' });
    }
    res.json({ saved: true });
  });

  router.delete('/targets/:id', (req, res) => {
    if (!removeTarget(targetsPath(), req.params.id)) {
      return res.status(404).json({ error: 'Target not found' });
    }
    res.status(204).end();
  });

  // The public key is meant to leave - it is what the browser passes as
  // applicationServerKey. The private one never does.
  router.get('/vapid-key', (req, res) => {
    try {
      res.json({ publicKey: getVapidKeys(config.vapidKeysPath).publicKey });
    } catch (err) {
      // The store's message names the path but never the content, so passing
      // it to the log is safe - and it says what needs repairing.
      console.error(`notifications: ${err.message}`);
      res.status(500).json({ error: 'The VAPID keypair could not be read' });
    }
  });

  // 65 bytes for the uncompressed P-256 point, 16 for the auth secret. Wrong
  // lengths mean the browser sent something else, and the failure would
  // otherwise only show up as a notification that never arrives.
  function invalidSubscription({ endpoint, keys }) {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      return 'endpoint must be a url';
    }
    if (parsed.protocol !== 'https:') return 'endpoint must be https';
    if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
      return 'p256dh and auth must be base64url strings';
    }
    const p256dh = Buffer.from(keys.p256dh, 'base64url');
    const auth = Buffer.from(keys.auth, 'base64url');
    if (p256dh.length !== 65 || p256dh[0] !== 0x04) return 'p256dh is not a valid public key';
    if (auth.length !== 16) return 'auth must be 16 bytes';
    return null;
  }

  router.post('/subscribe', (req, res) => {
    const { endpoint, keys, name } = req.body ?? {};
    const problem = invalidSubscription({ endpoint, keys });
    if (problem) return res.status(400).json({ error: problem });

    // The host beats an empty name: it says which push service the row
    // belongs to, and it stays editable afterwards.
    const label = typeof name === 'string' && name.trim() !== ''
      ? name.trim()
      : new URL(endpoint).host;
    const targetConfig = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };

    // Update instead of insert when this device is already known: the browser
    // can hand out a fresh subscription for the same endpoint, and two rows
    // would send twice. Re-enabling is deliberate - whoever taps "activate"
    // wants notifications, even if the row had been switched off earlier.
    const existing = findByEndpoint(targetsPath(), endpoint);
    if (existing) {
      updateTarget(targetsPath(), existing.id, {
        name: label,
        enabled: true,
        config: targetConfig,
      });
      return res.json({ id: existing.id });
    }
    const id = addTarget(targetsPath(), { type: 'webpush', name: label, config: targetConfig });
    res.status(201).json({ id });
  });

  // The target list carries only the shortened origin, so the frontend cannot
  // tell two devices behind the same push service apart - hence this route.
  // POST rather than GET: the endpoint is a credential and has no business
  // in a url or an access log. Never hands an endpoint back out.
  router.post('/subscribed', (req, res) => {
    const { endpoint } = req.body ?? {};
    const target = typeof endpoint === 'string'
      ? findByEndpoint(targetsPath(), endpoint)
      : undefined;
    res.json({ registered: Boolean(target), enabled: target?.enabled === true });
  });

  // A test send is the most important button in this section: without it a
  // typo only shows up as a notification that never arrives.
  router.post('/targets/:id/test', async (req, res) => {
    const target = listTargets(targetsPath()).find((t) => t.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Target not found' });
    const goneIds = await notifyAllReportingGone(config, [{ ...target, enabled: true }], {
      title: 'Claudux',
      body: 'Test notification',
      clickUrl: config.publicBaseUrl || undefined,
    });
    // A 410 is final (RFC 8030), so even a test removes the row. Reported
    // back, because a row vanishing on "test" is otherwise a surprise.
    removeTargets(targetsPath(), goneIds);
    // The dispatcher swallows per-target errors by design, so this reports
    // that the attempt ran - the answer is not proof of delivery.
    res.json({ sent: true, removed: goneIds.length > 0 });
  });

  return router;
}
