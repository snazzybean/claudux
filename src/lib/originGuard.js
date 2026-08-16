// The terminal WebSocket is the one endpoint a foreign web page can reach
// without any credential of its own: a browser sends the upgrade with the
// user's cookies and network position, and the socket behind it is a shell.
// Same-origin is therefore the minimum bar, and it has to be checked on the
// raw `upgrade` event - Express middleware never sees it (see server.js).

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

// A missing Origin is allowed on purpose. Browsers always send one on a
// WebSocket upgrade, so its absence means a non-browser client - curl, a
// script, the test suite - and those aren't what this guard is about: they
// can reach the whole unauthenticated API directly and gain nothing by
// forging an upgrade. Rejecting them would only break tooling.
//
// Three accepted sources, because the deployment may or may not sit behind
// a reverse proxy: the Host the request arrived with, the one a proxy
// forwarded, and the configured public url. Caddy passes Host through
// unchanged, but a proxy that rewrites it must not lock the terminal out.
export function isAllowedUpgradeOrigin(headers = {}, publicBaseUrl = '') {
  const origin = headers.origin;
  if (!origin) return true;
  const originHost = hostOf(origin);
  if (!originHost) return false;
  // A comma-separated list means several proxies appended to it; the first
  // entry is the one the client actually addressed.
  const forwarded = String(headers['x-forwarded-host'] || '').split(',')[0].trim();
  const allowed = [headers.host, forwarded, publicBaseUrl && hostOf(publicBaseUrl)];
  return allowed.some((candidate) => candidate && candidate === originHost);
}
