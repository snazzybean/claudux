// Notification targets, stored outside the git checkout behind file
// permissions - same stance as accountStore.js, which also stores plaintext
// behind 0600 rather than encrypting. Nothing here is ever logged.
//
// The only source of targets - deliberately no .env fallback: a target that
// no list can show is worse than none.
//
// `config` is opaque to this module: only the provider knows its shape. That
// is deliberate - the `webpush` type carries keys and subscriptions instead
// of a url, and would not fit a shared "url + headers + body" schema.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function readAll(targetsPath) {
  let raw;
  try {
    raw = fs.readFileSync(targetsPath, 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never pass on the content or the parser message: both can quote
    // secret material (a webhook url is itself the credential).
    console.error(`notificationTargets: ${targetsPath} is not valid JSON - treating it as empty.`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}

function writeAll(targetsPath, all) {
  fs.mkdirSync(path.dirname(targetsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(targetsPath, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(targetsPath, 0o600); // writeFileSync leaves an existing file's mode alone
}

export function listTargets(targetsPath) {
  const all = readAll(targetsPath);
  return Object.entries(all).map(([id, t]) => ({ ...t, id }));
}

function summarize(target) {
  // Per type, because there is no shared shape: webpush carries an endpoint
  // the browser assigned, the others a url somebody typed. For webpush the
  // origin is also the useful half - it says which push service is behind
  // the row, while the path identifying the device stays here.
  const url = target.type === 'webpush' ? target.config?.endpoint : target.config?.url;
  if (typeof url !== 'string' || url === '') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/…`;
  } catch {
    return '…';
  }
}

function hasSecret(target) {
  if (target.type === 'webhook') return Boolean(target.config?.url);
  if (target.type === 'webpush') return Boolean(target.config?.keys?.auth);
  return Boolean(target.config?.topic);
}

export function listTargetsForApi(targetsPath) {
  return listTargets(targetsPath).map((t) => ({
    id: t.id,
    type: t.type,
    name: t.name,
    enabled: t.enabled,
    summary: summarize(t),
    hasSecret: hasSecret(t),
  }));
}

export function addTarget(targetsPath, target) {
  const all = readAll(targetsPath);
  const id = crypto.randomUUID();
  all[id] = {
    type: target.type,
    name: target.name,
    enabled: target.enabled !== false,
    config: target.config ?? {},
  };
  writeAll(targetsPath, all);
  return id;
}

export function updateTarget(targetsPath, id, patch) {
  const all = readAll(targetsPath);
  if (!Object.hasOwn(all, id)) return false;
  const previous = all[id];
  all[id] = {
    ...previous,
    ...patch,
    // A patch without `config` must not drop the stored one - that is how
    // renaming or toggling works without retyping the secret. Headers merge
    // one level deeper for the same reason: rotating a token patches a
    // single header, and replacing the set would take Content-Type with it -
    // the flag the webhook provider escapes its values by.
    config: patch.config
      ? {
        ...previous.config,
        ...patch.config,
        ...(patch.config.headers
          ? { headers: { ...previous.config?.headers, ...patch.config.headers } }
          : {}),
      }
      : previous.config,
  };
  writeAll(targetsPath, all);
  return true;
}

export function removeTarget(targetsPath, id) {
  const all = readAll(targetsPath);
  if (!Object.hasOwn(all, id)) return false;
  delete all[id];
  writeAll(targetsPath, all);
  return true;
}

// Every sender prunes what the push service called gone, so the loop lives
// here instead of three times over at the call sites.
export function removeTargets(targetsPath, ids) {
  for (const id of ids) removeTarget(targetsPath, id);
}

// The endpoint is the stable per-device key, assigned by the browser. Without
// this lookup every activation would mint a new uuid, and a device that
// re-subscribed would sit in the list twice and get every notification twice.
export function findByEndpoint(targetsPath, endpoint) {
  return listTargets(targetsPath).find(
    (t) => t.type === 'webpush' && t.config?.endpoint === endpoint,
  );
}
