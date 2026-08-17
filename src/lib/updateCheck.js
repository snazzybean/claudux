// Which version is out there. Compares the installed version from
// package.json against the latest GitHub release.
//
// Cached server-side: unauthenticated, GitHub allows 60 requests per hour and
// IP - one request per page load would reach that before noon with a few tabs
// open.
import fs from 'node:fs';

const API = 'https://api.github.com';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const MIN_SPACING_MS = 60 * 1000;

function parts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

// Deliberately false for anything unparsable: offering an update to a version
// that cannot be resolved into a tag is worse than offering none.
export function isNewer(latest, current) {
  if (!parts(latest) || !parts(current)) return false;
  return compareVersions(latest, current) > 0;
}

// Read rather than imported: a JSON import still warns as experimental on
// Node 22, and the warning would show up on every start.
export function readPackageMeta({
  readFileFn = () => fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
} = {}) {
  const pkg = JSON.parse(readFileFn());
  const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '')?.[1] ?? null;
  return { version: pkg.version, slug };
}

export async function fetchLatestRelease({ slug, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!slug) return null;
  try {
    const res = await fetchImpl(`${API}/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claudux' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.tag_name) return null;
    return { version: body.tag_name, notesUrl: body.html_url ?? null };
  } catch {
    // Silent: no result means no message.
    return null;
  }
}

export function createUpdateChecker({
  meta = readPackageMeta(),
  fetchImpl = fetch,
  nowFn = Date.now,
  ttlMs = TWELVE_HOURS,
  minManualMs = MIN_SPACING_MS,
} = {}) {
  let latest = null;
  let notesUrl = null;
  let checkedAt = null;
  let lastAttempt = null;
  let inFlight = null;

  function state() {
    return { current: meta.version, latest, notesUrl, checkedAt };
  }

  async function run() {
    lastAttempt = nowFn();
    const release = await fetchLatestRelease({ slug: meta.slug, fetchImpl });
    // A failed check keeps the previous result - otherwise the card would
    // flip to "up to date" and back on the next tick.
    if (release) {
      latest = release.version;
      notesUrl = release.notesUrl;
      checkedAt = nowFn();
    }
    return state();
  }

  async function refresh({ manual = false } = {}) {
    const now = nowFn();
    // The minimum spacing holds for both paths. After a restart the cache is
    // empty, and the interface polls this route every few seconds until the
    // new version answers - without the floor, an unreachable GitHub would
    // see dozens of requests in those two minutes.
    if (lastAttempt !== null && now - lastAttempt < minManualMs) return state();
    if (!manual && checkedAt !== null && now - checkedAt < ttlMs) return state();
    if (!inFlight) inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { state, refresh };
}
