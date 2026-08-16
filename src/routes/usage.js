// GET /api/sessions/:id/usage - what the account pill in the popover
// shows: the session's context state, usage in the 5-hour and 7-day
// window, each with a reset time and color tier.
//
// All dependencies are injectable, so the tests need neither tmux nor the
// network - a real fetch costs quota (see rateLimits.js).
import express from 'express';
import { isValidSlug } from '../lib/tmuxManager.js';
import { getMeta, claudeSessionIdsForTmux } from '../lib/sessionMeta.js';
import { resolveActiveAccounts } from '../lib/activeAccount.js';
import { accountIdForToken, getTokenById } from '../lib/accountStore.js';
import {
  fetchLimits,
  createLimitCache,
  colorLevel,
  expectedExhaustionAt,
  FIVE_HOURS_SEC,
  SEVEN_DAYS_SEC,
} from '../lib/rateLimits.js';
import {
  contextForSession,
  contextLevel,
  modelFromSettings,
} from '../lib/contextUsage.js';

export function usageRouter(config, deps = {}) {
  const {
    // The account actually running, via the token in
    // /proc/<pid>/environ - not the stored assignment (rationale in
    // activeAccount.js).
    activeAccounts = () => resolveActiveAccounts((t) => accountIdForToken(config.accountsSecretPath, t)),
    tokenFor = (accountId) => getTokenById(config.accountsSecretPath, accountId),
    fetchLimitsDep = fetchLimits,
    nowSec = () => Math.floor(Date.now() / 1000),
    // Cache per account id: only queried when the popover opens, and only
    // if the last value is older than 60 seconds.
    cache = createLimitCache({ ttlMs: 60000 }),
  } = deps;

  const router = express.Router();

  router.get('/sessions/:id/usage', async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      if (!isValidSlug(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

      // Context first: it's on disk, needs no quota, and is still there
      // even if everything goes wrong with the fetch below. Reading it
      // costs a tail chunk, not the whole transcript (see contextUsage.js).
      const rawContext = contextForSession(
        config.claudeHome,
        claudeSessionIdsForTmux(config.dataDir, sessionId),
        modelFromSettings(config.claudeHome),
      );
      const context = { ...rawContext, level: contextLevel(rawContext.percent) };

      let accountId = null;
      try {
        accountId = (await activeAccounts()).get(sessionId)?.accountId ?? null;
      } catch {
        // tmux unreachable - then the stored assignment remains.
      }
      if (!accountId) accountId = getMeta(config.dataDir, sessionId)?.accountId ?? null;

      const token = accountId ? tokenFor(accountId) : null;
      if (!token) {
        // No account or no stored token: the context state is still worth
        // reporting.
        return res.json({ context, limits: null, accountId, asOf: null, error: null });
      }

      const now = nowSec();
      try {
        const entry = await cache.get(accountId, () => fetchLimitsDep(token));
        res.json({
          context,
          accountId,
          limits: {
            fiveHour: withTier(entry.limits.fiveHour, now, FIVE_HOURS_SEC),
            sevenDay: withTier(entry.limits.sevenDay, now, SEVEN_DAYS_SEC),
          },
          asOf: entry.asOf,
          error: entry.error ?? null,
        });
      } catch (err) {
        // The fetch is the only part that can fail without making the
        // response worthless - hence 200 with an error text instead of
        // 5xx.
        res.json({ context, accountId, limits: null, asOf: null, error: err.message });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// Color and projection are decided here, not in the browser: both live in
// a calculation (see rateLimits.js) that belongs under test - and public/
// has no test harness.
function withTier(windowData, nowSec, windowSec) {
  if (!windowData) return null;
  return {
    ...windowData,
    level: colorLevel(windowData.percent, windowData.resetsAt, nowSec, windowSec),
    exhaustedAt: expectedExhaustionAt(windowData.percent, windowData.resetsAt, nowSec, windowSec),
  };
}
