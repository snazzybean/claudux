import express from 'express';
import {
  isConfigured, setPassword, verifyPassword, createSession, revokeSession,
  revokeAllSessions, getSessionTtlDays, setSessionTtlDays,
} from '../lib/accessStore.js';
import { COOKIE_NAME, sessionTokenFromCookie } from '../lib/accessGuard.js';
import { createLoginThrottle } from '../lib/loginThrottle.js';

const MIN_PASSWORD_LENGTH = 8;
// Chrome and Edge cap Max-Age at 400 days no matter what the server sends,
// so this is what "never expires" looks like on the wire. The session itself
// has no expiry; the cookie is refreshed on every authenticated response.
const NO_EXPIRY_DAYS = 400;

function isUsablePassword(value) {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH;
}

// A Secure cookie over plain http is accepted by the browser and never sent
// back, which looks like a login loop rather than an error - so it is set
// only where it can work.
function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

export function sendSessionCookie(req, res, secretPath) {
  const token = createSession(secretPath);
  const days = getSessionTtlDays(secretPath) ?? NO_EXPIRY_DAYS;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax', // Strict would send a push notification's click to the login screen
    path: '/',
    secure: isHttps(req),
    maxAge: days * 24 * 60 * 60 * 1000,
  });
}

// Setup and login: reachable without a session, hence in front of the gate.
export function accessPublicRouter(config) {
  const router = express.Router();
  const throttle = createLoginThrottle();

  router.get('/state', (req, res) => {
    res.json({ configured: isConfigured(config.accessSecretPath) });
  });

  // The first caller sets the password. No setup code and no loopback
  // restriction: that is the usual arrangement for self-hosted projects, and
  // the alternatives make an install from a phone impossible.
  router.post('/setup', (req, res) => {
    if (isConfigured(config.accessSecretPath)) {
      return res.status(409).json({ error: 'already configured' });
    }
    if (!isUsablePassword(req.body?.password)) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    setPassword(config.accessSecretPath, req.body.password);
    sendSessionCookie(req, res, config.accessSecretPath);
    return res.json({ ok: true });
  });

  router.post('/login', async (req, res) => {
    // The throttle sits on login alone: setup has no secret to guess, and a
    // delay there would only be a way to hold up an installation.
    const key = req.ip || 'unknown';
    const delay = throttle.delayMs(key);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const password = req.body?.password;
    if (typeof password !== 'string' || !verifyPassword(config.accessSecretPath, password)) {
      throttle.recordFailure(key);
      // No reason ever travels with the refusal.
      return res.status(401).json({ error: 'not authenticated' });
    }
    throttle.recordSuccess(key);
    sendSessionCookie(req, res, config.accessSecretPath);
    return res.json({ ok: true });
  });

  return router;
}

// Everything that presupposes a session, hence behind the gate.
export function accessProtectedRouter(config) {
  const router = express.Router();

  router.post('/logout', (req, res) => {
    revokeSession(config.accessSecretPath, sessionTokenFromCookie(req.headers.cookie));
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  router.post('/logout-all', (req, res) => {
    revokeAllSessions(config.accessSecretPath);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // A new password revokes every session, this one included - so the answer
  // is deliberately not followed by a fresh cookie.
  router.post('/password', (req, res) => {
    const { current, next } = req.body ?? {};
    if (typeof current !== 'string' || !verifyPassword(config.accessSecretPath, current)) {
      return res.status(401).json({ error: 'not authenticated' });
    }
    if (!isUsablePassword(next)) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    setPassword(config.accessSecretPath, next);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.json({ ok: true });
  });

  router.get('/session-ttl', (req, res) => {
    res.json({ days: getSessionTtlDays(config.accessSecretPath) });
  });

  router.put('/session-ttl', (req, res) => {
    try {
      setSessionTtlDays(config.accessSecretPath, req.body?.days);
    } catch {
      return res.status(400).json({ error: 'unknown session lifetime' });
    }
    return res.json({ days: getSessionTtlDays(config.accessSecretPath) });
  });

  return router;
}
