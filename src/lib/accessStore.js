// Keeps the site password and the issued sessions in a file outside the git
// checkout (chmod 600). Neither of the two secrets is stored as such: the
// password as an scrypt hash, a session token as its SHA-256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const DEFAULT_TTL_DAYS = 30;
export const ALLOWED_TTL_DAYS = [7, 30, 180, 365, null];

export function readAccess(secretPath) {
  let raw;
  try {
    raw = fs.readFileSync(secretPath, 'utf8');
  } catch (err) {
    // Only a missing file means "not set up yet". Every other failure -
    // unreadable, a directory, EIO - has to reach the caller, which refuses
    // to serve rather than offering the setup screen again.
    if (err.code === 'ENOENT') {
      return { password: null, sessionTtlDays: DEFAULT_TTL_DAYS, sessions: [] };
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse quotes the broken content in its message, and that content
    // is hash and salt material.
    throw new Error(`access.json is not valid JSON: ${secretPath}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`access.json is not an object: ${secretPath}`);
  }
  return {
    password: parsed.password ?? null,
    sessionTtlDays: ALLOWED_TTL_DAYS.includes(parsed.sessionTtlDays)
      ? parsed.sessionTtlDays
      : DEFAULT_TTL_DAYS,
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}

function write(secretPath, data) {
  const dir = path.dirname(secretPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // mkdirSync's mode does nothing to an existing directory
  fs.writeFileSync(secretPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600);
}

export function isConfigured(secretPath) {
  return readAccess(secretPath).password !== null;
}

export function setPassword(secretPath, plain) {
  const data = readAccess(secretPath);
  const salt = crypto.randomBytes(16).toString('hex');
  data.password = {
    salt,
    hash: crypto.scryptSync(plain, salt, KEY_LENGTH, SCRYPT).toString('hex'),
    ...SCRYPT,
  };
  data.sessions = []; // a new password logs every device out
  write(secretPath, data);
}

export function verifyPassword(secretPath, plain) {
  const { password } = readAccess(secretPath);
  if (!password) return false;
  const expected = Buffer.from(password.hash, 'hex');
  // The stored parameters, not the current constants: a future change to
  // SCRYPT must not invalidate the password already on disk.
  const actual = crypto.scryptSync(plain, password.salt, expected.length, {
    N: password.N, r: password.r, p: password.p,
  });
  return crypto.timingSafeEqual(expected, actual);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(secretPath) {
  const token = crypto.randomBytes(32).toString('base64url');
  const data = readAccess(secretPath);
  data.sessions.push({ idHash: tokenHash(token), createdAt: Date.now() });
  write(secretPath, data);
  return token;
}

export function findSession(secretPath, token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const wanted = tokenHash(token);
  const found = readAccess(secretPath).sessions.find((s) => s.idHash === wanted);
  return found ? { createdAt: found.createdAt } : null;
}

export function revokeSession(secretPath, token) {
  if (typeof token !== 'string' || token.length === 0) return;
  const wanted = tokenHash(token);
  const data = readAccess(secretPath);
  data.sessions = data.sessions.filter((s) => s.idHash !== wanted);
  write(secretPath, data);
}

export function revokeAllSessions(secretPath) {
  const data = readAccess(secretPath);
  data.sessions = [];
  write(secretPath, data);
}

export function getSessionTtlDays(secretPath) {
  return readAccess(secretPath).sessionTtlDays;
}

export function setSessionTtlDays(secretPath, days) {
  if (!ALLOWED_TTL_DAYS.includes(days)) {
    throw new Error('unknown session lifetime');
  }
  const data = readAccess(secretPath);
  data.sessionTtlDays = days;
  write(secretPath, data);
}
