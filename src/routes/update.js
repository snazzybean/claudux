import express from 'express';
import { createUpdateChecker, isNewer } from '../lib/updateCheck.js';
import { updateReadiness } from '../lib/selfUpdate.js';
import { createUpdateJob } from '../lib/updateRun.js';

export function updateRouter(config, {
  checker = createUpdateChecker(),
  job = createUpdateJob(),
  readinessFn = updateReadiness,
} = {}) {
  const router = express.Router();

  async function describe() {
    const state = checker.state();
    const readiness = await readinessFn({});
    return {
      ...state,
      ...readiness,
      updateAvailable: isNewer(state.latest, state.current),
    };
  }

  router.get('/', async (req, res, next) => {
    try {
      await checker.refresh({});
      res.json(await describe());
    } catch (err) { next(err); }
  });

  router.post('/check', async (req, res, next) => {
    try {
      await checker.refresh({ manual: true });
      res.json(await describe());
    } catch (err) { next(err); }
  });

  router.get('/status', (req, res) => {
    res.json(job.status());
  });

  // Checked here again rather than trusted from the interface: behind this
  // route sits a process that runs git and npm.
  router.post('/', async (req, res, next) => {
    try {
      const info = await describe();
      if (!info.canUpdate) return res.status(400).json({ error: info.reason });
      if (!info.updateAvailable) return res.status(400).json({ error: 'Already up to date' });
      // Nothing may be awaited between this check and start(): two requests
      // in the same tick would otherwise both get through.
      if (job.isRunning()) return res.status(409).json({ error: 'An update is already running' });
      // Not awaited either: the job runs for minutes, and a proxy in front
      // would cut the response. Its progress comes from GET /status.
      job.start(info.latest).catch(() => {});
      return res.status(202).json({ started: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
