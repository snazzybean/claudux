// Web Push crypto with Node's own primitives: payload encryption per
// RFC 8291 (aes128gcm, RFC 8188) and the VAPID authorization header per
// RFC 8292. Taking this over the `web-push` package is deliberate - that one
// has not moved since early 2024 and drags five dependencies into a project
// that has five in total.
//
// `salt` and the server keypair are parameters, not just internals: the RFC
// prints a test vector with fixed values, and without injection the output
// could only ever be compared against itself.
import crypto from 'node:crypto';

const PADDING_DELIMITER = 0x02;
const RECORD_SIZE = 4096;
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

// hkdfSync does extract AND expand in one call, which is exactly the shape
// RFC 8291 asks for twice.
function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

export function encryptPayload(plaintext, uaPublicKey, authSecret, {
  salt = crypto.randomBytes(16),
  serverPrivate,
} = {}) {
  const uaPublic = Buffer.from(uaPublicKey, 'base64url');
  const auth = Buffer.from(authSecret, 'base64url');

  const ecdh = crypto.createECDH('prime256v1');
  if (serverPrivate) ecdh.setPrivateKey(Buffer.from(serverPrivate, 'base64url'));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdh.computeSecret(uaPublic), auth, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([PADDING_DELIMITER])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(5);
  header.writeUInt32BE(RECORD_SIZE, 0);
  header.writeUInt8(asPublic.length, 4);
  return Buffer.concat([salt, header, asPublic, ciphertext]);
}

export function buildVapidHeader(endpoint, keys, subject, {
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const token = [
    { typ: 'JWT', alg: 'ES256' },
    // The audience is the endpoint's ORIGIN. A token whose aud carries the
    // path is rejected.
    { aud: new URL(endpoint).origin, exp: now + TOKEN_TTL_SECONDS, sub: subject },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');

  // ieee-p1363 gives the raw r||s pair. Node's default is DER, which JWS does
  // not accept - and the failure mode is a 401 from the push service, not an
  // error here.
  const signature = crypto.sign('sha256', Buffer.from(token), {
    key: crypto.createPrivateKey(keys.privateKey),
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${token}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}
