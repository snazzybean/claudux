// Pure predicates for the access gate. No file and no Express knowledge on
// purpose: the same checks run in an Express middleware and in the raw
// `upgrade` handler, which never sees middleware (see server.js).
export const COOKIE_NAME = 'claudux_session';

// Reachable without a session. A stylesheet is not a secret, and the PWA has
// to be installable before anyone is logged in. The login page is NOT in
// here - the gate serves it under whatever url was requested.
const PUBLIC_FILES = new Set(['/styles.css', '/manifest.json', '/favicon.ico']);
const PUBLIC_PREFIX = '/icons/';
export const PUBLIC_PATHS = [...PUBLIC_FILES, `${PUBLIC_PREFIX}*`];

export function isPublicPath(pathname) {
  if (typeof pathname !== 'string') return false;
  if (pathname.includes('..')) return false;
  return PUBLIC_FILES.has(pathname) || pathname.startsWith(PUBLIC_PREFIX);
}

export function sessionTokenFromCookie(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

// Computed rather than stored: a change to the setting has to apply to
// devices that are already logged in, which a stamped expiry could not do.
export function isSessionExpired(createdAt, ttlDays, now = Date.now()) {
  if (ttlDays === null) return false;
  return now > createdAt + ttlDays * 24 * 60 * 60 * 1000;
}

export function wantsHtml(accept) {
  return typeof accept === 'string' && accept.includes('text/html');
}
