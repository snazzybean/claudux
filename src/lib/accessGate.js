// Wires the pure predicates in accessGuard.js to the file in
// accessStore.js. Two consumers: the Express middleware below and the raw
// `upgrade` handler in server.js, which never sees middleware - both go
// through hasValidSession, so they cannot drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { findSession, getSessionTtlDays, isConfigured } from './accessStore.js';
import {
  isPublicPath, isSessionExpired, sessionTokenFromCookie, wantsHtml,
} from './accessGuard.js';

const LOGIN_PAGE = path.join(import.meta.dirname, '../../public/login.html');

export function hasValidSession(config, cookieHeader, now = Date.now()) {
  const token = sessionTokenFromCookie(cookieHeader);
  if (!token) return false;
  const session = findSession(config.accessSecretPath, token);
  if (!session) return false;
  return !isSessionExpired(session.createdAt, getSessionTtlDays(config.accessSecretPath), now);
}

// Read per request rather than cached: the page is served rarely, and a
// cache would need invalidating on every edit under public/ - which is
// exactly the build-step-free deploy flow this project keeps.
export function loginPageHtml() {
  return fs.readFileSync(LOGIN_PAGE, 'utf8');
}

// Serves the login page under the requested url instead of redirecting to
// one of its own: the address bar stays put, there is no return path to
// secure against open redirects, and the installed PWA keeps its start_url.
export function createAccessGate(config) {
  return (req, res, next) => {
    if (config.authEnabled === false) return next();
    if (isPublicPath(req.path)) return next();
    let allowed;
    try {
      allowed = hasValidSession(config, req.headers.cookie);
    } catch {
      // Fail closed: an unreadable access file refuses to serve rather than
      // serving everything.
      return res.status(500).json({ error: 'access configuration unreadable' });
    }
    if (allowed) return next();
    // Everything below /ttyd is the terminal iframe. Its navigation asks for
    // html too, and answering it with the login page would draw a second
    // login screen inside the terminal pane instead of reporting the lost
    // session to the page around it.
    if (wantsHtml(req.headers.accept) && !req.path.startsWith('/ttyd')) {
      return res.status(401).type('html').set('Cache-Control', 'no-store').send(loginPageHtml());
    }
    return res.status(401).json({
      error: 'not authenticated',
      setupNeeded: !isConfigured(config.accessSecretPath),
    });
  };
}
