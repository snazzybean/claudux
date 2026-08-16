// test/webpushCrypto.test.js
//
// The vector is RFC 8291 section 5 verbatim. Salt and the server keypair are
// injected because both are random in production - without injection the
// output could only be compared against itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, buildVapidHeader } from '../src/lib/notify/webpushCrypto.js';

const VECTOR = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  result:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('encryptPayload reproduces the RFC 8291 test vector byte for byte', () => {
  const payload = encryptPayload(
    Buffer.from(VECTOR.plaintext, 'base64url'),
    VECTOR.uaPublic,
    VECTOR.auth,
    { salt: Buffer.from(VECTOR.salt, 'base64url'), serverPrivate: VECTOR.asPrivate },
  );
  assert.equal(payload.toString('base64url'), VECTOR.result);
});

test('the header carries salt, record size and the 65-byte server key', () => {
  const payload = encryptPayload(Buffer.from('hi'), VECTOR.uaPublic, VECTOR.auth);
  assert.equal(payload.subarray(0, 16).length, 16);
  assert.equal(payload.readUInt32BE(16), 4096);
  assert.equal(payload[20], 65);
  assert.equal(payload[21], 0x04); // uncompressed point
});

test('a fresh salt and keypair per call produce different output', () => {
  const a = encryptPayload(Buffer.from('same'), VECTOR.uaPublic, VECTOR.auth);
  const b = encryptPayload(Buffer.from('same'), VECTOR.uaPublic, VECTOR.auth);
  assert.notEqual(a.toString('base64url'), b.toString('base64url'));
});

test('the receiver can decrypt what encryptPayload produced', () => {
  const payload = encryptPayload(Buffer.from('watermelon'), VECTOR.uaPublic, VECTOR.auth);
  const salt = payload.subarray(0, 16);
  const asPublic = payload.subarray(21, 86);
  const ciphertext = payload.subarray(86);

  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(Buffer.from(VECTOR.uaPrivate, 'base64url'));
  const secret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    Buffer.from(VECTOR.uaPublic, 'base64url'),
    asPublic,
  ]);
  const ikm = Buffer.from(
    crypto.hkdfSync('sha256', secret, Buffer.from(VECTOR.auth, 'base64url'), keyInfo, 32),
  );
  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const out = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  assert.equal(out.subarray(0, out.length - 1).toString(), 'watermelon');
  assert.equal(out[out.length - 1], 0x02); // padding delimiter
});

test('buildVapidHeader signs a verifiable ES256 token over the endpoint origin', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const keys = {
    publicKey: Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]).toString('base64url'),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };

  const header = buildVapidHeader(
    'https://web.push.apple.com/some/long/path',
    keys,
    'https://claudux.example.com',
    { now: 1_700_000_000 },
  );

  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(match, `unexpected header shape: ${header}`);
  const [, token, k] = match;
  assert.equal(k, keys.publicKey);

  const [rawHeader, rawClaims, rawSignature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(rawHeader, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(rawClaims, 'base64url'));
  // The audience is the ORIGIN, not the full endpoint - a push service
  // rejects a token whose aud carries the path.
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://claudux.example.com');
  assert.ok(claims.exp > 1_700_000_000);
  assert.ok(claims.exp <= 1_700_000_000 + 24 * 60 * 60);

  const signature = Buffer.from(rawSignature, 'base64url');
  assert.equal(signature.length, 64); // raw r||s, not DER
  assert.ok(
    crypto.verify(
      'sha256',
      Buffer.from(`${rawHeader}.${rawClaims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    ),
  );
});
