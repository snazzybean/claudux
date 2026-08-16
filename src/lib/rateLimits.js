// Reads an account's quota status (5-hour and 7-day windows) from the
// `anthropic-ratelimit-unified-*` headers of the API.
//
// Why a real request and not a cheaper route:
//
//   - There's no local file with the values. `rate-limit-status.txt` looks
//     like it should have them, but Claude Code no longer maintains it.
//   - `GET /api/oauth/usage` answers tokens from `claude setup-token` with
//     HTTP 403 - that flow doesn't grant the required `user:profile` scope.
//   - `POST /v1/messages/count_tokens` would be free, but doesn't return a
//     single ratelimit header.
//
// The token is NEVER logged here and NEVER written into an error message.

const API_URL = 'https://api.anthropic.com/v1/messages';

// The cheapest request that still triggers the headers. Haiku instead of
// Opus, so the tokens spent don't add up even with frequent opens.
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

// Without this system prompt the API rejects OAuth tokens - they're bound
// to Claude Code, not to arbitrary clients.
const PROBE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

export const FIVE_HOURS_SEC = 18000;
export const SEVEN_DAYS_SEC = 604800;

function numberOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// One window out of the header set. Without a usable utilization value
// there's no window: "unknown" has to be distinguishable from "nothing
// used", otherwise the UI would show an empty green bar where there's
// actually no information at all.
function windowFromHeaders(headers, prefix) {
  const fraction = numberOrNull(headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`));
  if (fraction === null) return null;
  return {
    // utilization is a fraction 0..1, not a percentage.
    percent: fraction * 100,
    resetsAt: numberOrNull(headers.get(`anthropic-ratelimit-unified-${prefix}-reset`)),
    status: headers.get(`anthropic-ratelimit-unified-${prefix}-status`) ?? null,
  };
}

export function parseUnifiedHeaders(headers) {
  return {
    fiveHour: windowFromHeaders(headers, '5h'),
    sevenDay: windowFromHeaders(headers, '7d'),
  };
}

// Color tier of a window: 'dim' | 'ok' | 'warn' | 'crit'.
//
// Copied verbatim from the terminal's statusline script: terminal and
// browser should never show different colors for the same situation.
//
// The core of it is the projection: what decides isn't the usage, but
// whether it's on pace to hit the limit before the reset at the current
// rate. It needs no stored state, only the reset time and the window
// length.
export function colorLevel(percent, resetsAt, nowSec, windowSec) {
  if (!Number.isFinite(percent)) return 'dim';
  // Right at the start of a window every projection is noise: 5% after
  // three minutes would work out to 500%.
  if (percent < 10) return 'dim';
  if (percent >= 90) return 'crit';
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return percent >= 75 ? 'warn' : 'ok';

  const elapsed = nowSec - (resetsAt - windowSec);
  // Reset lies in the future, but the window hasn't mathematically started
  // yet - then a high value can't be explained and counts as critical.
  if (elapsed <= 0) return percent >= 75 ? 'crit' : 'ok';

  const projected = percent / (elapsed / windowSec);
  if (projected >= 100) return 'crit';
  if (projected >= 85) return 'warn';
  return 'ok';
}

// When is the quota expected to run out? Epoch seconds or null.
//
// The same projection as in colorLevel, just rearranged: there a percentage
// comes out, here a point in time. The percentage decides the color, but
// only the point in time says how much longer there is to work with.
//
// null whenever the calculation wouldn't yield anything honest: too early
// in the window (noise), no known window start, or the pace holds out
// until the reset - then there's no exhaustion to predict.
export function expectedExhaustionAt(percent, resetsAt, nowSec, windowSec) {
  if (!Number.isFinite(percent) || percent < 10 || percent >= 100) return null;
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return null;

  const elapsed = nowSec - (resetsAt - windowSec);
  if (elapsed <= 0) return null;

  const target = nowSec + ((100 - percent) * elapsed) / percent;
  // After the reset the quota is full again - an exhaustion past that point
  // no longer happens within this window.
  return target <= resetsAt ? Math.round(target) : null;
}

// Fetches the quota status for ONE token.
//
// `fetchImpl` is injectable so the tests don't need network access and
// don't burn any quota.
//
// The headers are read REGARDLESS of the HTTP status: the most interesting
// moment is the one where the quota is exhausted - then the API answers
// with 429 and still attaches the values.
export async function fetchLimits(token, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      system: PROBE_SYSTEM,
      messages: [{ role: 'user', content: 'hi' }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const limits = parseUnifiedHeaders(res.headers);
  if (limits.fiveHour === null && limits.sevenDay === null) {
    // Not a single header: either a rejected token (401/403) or a response
    // we don't understand. The status belongs in the message, the token
    // under no circumstances.
    const error = new Error(`Rate limit unavailable (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }
  return limits;
}

// Cache per ACCOUNT, not per session: the quota belongs to the
// subscription. Two sessions of the same account share one fetch.
//
// Only queried when the pill is tapped, and only if the last value is
// older than `ttlMs` - every fetch costs a real mini request. No
// background polling.
//
// `now` is injectable so the tests can set the clock instead of waiting.
//
// Keyed by account id, not name: the name is display only and changes on
// rename, which would split one subscription's quota across two entries.
export function createLimitCache({ ttlMs = 60000, now = Date.now } = {}) {
  const entries = new Map();

  return {
    async get(accountId, loader) {
      const old = entries.get(accountId);
      const current = now();
      if (old && current - old.asOf < ttlMs) return old;

      try {
        const fresh = { limits: await loader(), asOf: now() };
        entries.set(accountId, fresh);
        return fresh;
      } catch (err) {
        // Without network, a number from earlier with an honest timestamp
        // is more useful than a blank display. The old entry stays
        // unchanged in memory, so its `asOf` doesn't drift.
        if (old) return { ...old, error: err.message };
        throw err;
      }
    },
  };
}
