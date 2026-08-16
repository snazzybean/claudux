// The VAPID keypair identifies this installation to every push service. It
// belongs to the installation, not to a target: ten registered devices share
// one pair, which is why it does not live in notifications.json.
//
// Plaintext behind 0600, same stance as accountStore.js - no encryption is
// claimed here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    // Uncompressed point - the form applicationServerKey expects in the
    // browser.
    publicKey: Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]).toString('base64url'),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

export function getVapidKeys(vapidKeysPath) {
  let raw;
  try {
    raw = fs.readFileSync(vapidKeysPath, 'utf8');
  } catch (err) {
    // Only a missing file leads to a new keypair. Generating one is
    // irreversible for every device already registered: a new pair makes
    // every existing subscription fail with 403, and nothing in the UI would
    // explain it. That is why a file that exists but cannot be read as a
    // keypair throws below instead of being replaced.
    if (err.code !== 'ENOENT') throw err;
    const keys = generate();
    fs.mkdirSync(path.dirname(vapidKeysPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(vapidKeysPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
    fs.chmodSync(vapidKeysPath, 0o600); // writeFileSync leaves an existing mode alone
    return keys;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never pass on the content or the parser message - both can quote key
    // material.
    throw new Error(`vapid: ${vapidKeysPath} is not valid JSON - refusing to replace it`);
  }
  if (typeof parsed?.publicKey !== 'string' || typeof parsed?.privateKey !== 'string') {
    throw new Error(`vapid: ${vapidKeysPath} has no usable keypair - refusing to replace it`);
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}
