// The route for the background CLI update. `current` is read live on every
// GET (cheap - just a local process, no network) rather than cached, so
// the System tab always shows the truth even between 6h ticks.
import express from 'express';
import { readClaudeCodeVersion } from '../lib/claudeCodeVersion.js';
import { readAutoUpdateEnabled, writeAutoUpdateEnabled } from '../lib/claudeCodeUpdateSettings.js';
import { createClaudeCodeUpdateJob } from '../lib/claudeCodeUpdateRun.js';

const RESULT_BY_UPDATED = { true: 'updated', false: 'up-to-date' };

export function claudeUpdateRouter(config, {
  job = createClaudeCodeUpdateJob(),
  versionFn = readClaudeCodeVersion,
} = {}) {
  const router = express.Router();

  function lastResult() {
    const s = job.status();
    if (s.phase === 'failed') return 'failed';
    if (s.phase === 'done') return RESULT_BY_UPDATED[String(s.updated)];
    return null;
  }

  router.get('/', async (req, res, next) => {
    try {
      res.json({
        current: await versionFn(),
        autoUpdateEnabled: readAutoUpdateEnabled(config.claudeUpdateSettingsPath),
        lastRunAt: job.status().ranAt,
        lastResult: lastResult(),
      });
    } catch (err) { next(err); }
  });

  router.get('/status', (req, res) => {
    res.json(job.status());
  });

  // Checked here again rather than trusted from the interface - behind
  // this route sits a process that runs the CLI's own updater.
  router.post('/', (req, res) => {
    if (job.isRunning()) return res.status(409).json({ error: 'A check is already running' });
    job.start().catch(() => {});
    return res.status(202).json({ started: true });
  });

  router.post('/toggle', (req, res) => {
    const enabled = req.body?.enabled !== false;
    writeAutoUpdateEnabled(config.claudeUpdateSettingsPath, enabled);
    res.json({ autoUpdateEnabled: enabled });
  });

  return router;
}
