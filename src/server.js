import express from 'express';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import { minifyStatic } from './lib/staticAssets.js';
import { loadConfig } from './config.js';
import { projectsRouter } from './routes/projects.js';
import { sessionsRouter } from './routes/sessions.js';
import { notifyRouter } from './routes/notify.js';
import { notificationsRouter } from './routes/notifications.js';
import { eventsRouter } from './routes/events.js';
import { presenceRouter } from './routes/presence.js';
import { accountsRouter } from './routes/accounts.js';
import { browseRouter } from './routes/browse.js';
import { filesRouter } from './routes/files.js';
import { uploadsRouter, cleanupUploads } from './routes/uploads.js';
import { usageRouter } from './routes/usage.js';
import { updateRouter } from './routes/update.js';
import { cleanupOldModules } from './lib/updateRun.js';
import { checkNoGlobalAuthOverride } from '../scripts/check-settings-guard.js';
import { cleanupSessionTokenFiles } from './lib/sessionTokenFile.js';
import { cleanupHookSettingsFiles } from './lib/hookSettingsFile.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as ttydManager from './lib/ttydManager.js';
import { isAllowedUpgradeOrigin } from './lib/originGuard.js';
import { createAccessGate, hasValidSession } from './lib/accessGate.js';
import { accessPublicRouter, accessProtectedRouter } from './routes/access.js';
import { permissionHookRouter, permissionViewRouter, createPermissionStore } from './routes/permission.js';
import { getMeta } from './lib/sessionMeta.js';
import { startReaperInterval } from './lib/reaper.js';
import { startStatusWatcherInterval } from './lib/statusWatcher.js';
import { startSubagentWatcherInterval } from './lib/subagentWatcher.js';
import { claudeUpdateRouter } from './routes/claudeUpdate.js';
import { startClaudeCodeUpdateInterval } from './lib/claudeCodeUpdateRun.js';

export function createApp(config, { claudeCodeUpdateJob, browseStartDirFn } = {}) {
  const app = express();
  // The files tab saves text files up to 1 MB and the permission hook
  // reports tool inputs of a similar size; both bring their own parser (see
  // routes/files.js and routes/permission.js). If the global one ran ahead
  // of them with its default of 100 kB, it would reject the body with 413
  // before the route ever saw it.
  const jsonParser = express.json();
  const ownParser = (p) => p.startsWith('/api/files') || p.startsWith('/api/permission');
  app.use((req, res, next) => (
    ownParser(req.path) ? next() : jsonParser(req, res, next)
  ));
  // Setup and login have to work without a session, so they sit in front of
  // the gate. Everything that presupposes one sits behind it - a single
  // router here would offer the password change to anyone who can send a
  // request.
  app.use('/access', accessPublicRouter(config));
  // The permission routers are split the same way and for the same kind of
  // reason: the hook is called by the `claude` process, which has no session
  // cookie, so a router behind the gate would answer 401 and the store would
  // never fill - in production only, since the probe runs with the gate off.
  // The POST authenticates itself with the per-session secret instead. The
  // GET/DELETE the browser reads stay behind the gate, mounted with the
  // other routers below.
  const permissionStore = createPermissionStore({ dataDir: config.dataDir });
  const permissionWiring = {
    store: permissionStore,
    // Either half alone leaves a hole: the meta entry is only written after
    // the spawn, so a hook firing before that would be turned away, while a
    // session Claudux never started (resumed straight from the JSONL
    // history) has no prepared flag until it is resumed once.
    knowsSession: (id) => permissionStore.isPrepared(id) || Boolean(getMeta(config.dataDir, id)),
  };
  // Handed out rather than imported, the same route as the ttyd upgrade
  // handler below: the session routes take each session's secret from it.
  app.locals.permissionStore = permissionStore;
  app.use('/api', permissionHookRouter(config, permissionWiring));
  app.use(createAccessGate(config));
  app.use('/access', accessProtectedRouter(config));

  // Browsers request /favicon.ico in addition to the <link rel="icon">
  // tag, even when that already points at a valid PNG - without this
  // route, a harmless but visible 404 on every page load. Real .ico
  // encoding would need its own container format; the existing PNG with a
  // matching content type is enough for browsers here.
  app.get('/favicon.ico', (req, res) => {
    res.type('image/png').sendFile(path.join(import.meta.dirname, '../public/icons/icon-192.png'));
  });
  // Order matters: compression wraps whatever the two below write, and
  // minifyStatic has to see the request before express.static answers it.
  // index.html only has its comments stripped, no more (see staticAssets.js).
  //
  // The filter exempts SSE: gzip buffers writes waiting for its window to
  // fill, which is fine for a whole file but starves a stream that lives on
  // small, infrequent chunks - the browser's EventSource never saw the
  // first byte and sat in CONNECTING forever. compression() has no path
  // scope of its own once mounted (a request that falls through the two
  // middlewares below still carries its patched res.write), so every
  // streaming response needs this same exemption, not just this one route.
  const publicDir = path.join(import.meta.dirname, '../public');
  app.use(compression({
    filter: (req, res) => {
      if (res.getHeader('Content-Type') === 'text/event-stream') return false;
      return compression.filter(req, res);
    },
  }));
  app.use(minifyStatic(publicDir));
  app.use(express.static(publicDir));

  // pathFilter rather than app.use('/ttyd', ...): Express' own path
  // mounting would strip the /ttyd prefix when passing the request on, but
  // ttyd runs with -b /ttyd and expects it (see test/ttydProxy.test.js).
  const ttydProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${config.ttydPort}`,
    ws: true,
    pathFilter: '/ttyd',
  });
  app.use(ttydProxy);
  // Built here, where config lives, but deliberately NOT installed here:
  // the upgrade event hangs off the raw HTTP server (see below).
  app.locals.ttydUpgrade = (req, socket, head) => {
    // The second checkpoint. The gate above is Express middleware and never
    // runs for an upgrade - and the socket behind this one is a shell.
    if (config.authEnabled !== false) {
      let allowed;
      try {
        allowed = hasValidSession(config, req.headers.cookie);
      } catch {
        allowed = false; // an unreadable access file refuses, it does not admit
      }
      if (!allowed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    if (!isAllowedUpgradeOrigin(req.headers, config.publicBaseUrl)) {
      // A status line before the destroy, so a rejected upgrade shows up as
      // 403 in the browser console instead of as an unexplained reset.
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    ttydProxy.upgrade(req, socket, head);
  };

  // Attach new routers HERE - the error handler below must stay the last
  // piece of middleware, otherwise its JSON errors no longer apply to
  // routers attached after it.
  app.use('/api/projects', projectsRouter(config));
  app.use('/api', sessionsRouter(config));
  app.use('/api', permissionViewRouter(config, permissionWiring));
  app.use('/api', usageRouter(config));
  app.use('/api/notify', notifyRouter(config));
  app.use('/api/notifications', notificationsRouter(config));
  // The watcher runs outside createApp (only under the entry point below),
  // so the publish half is handed out through app.locals rather than
  // imported - the same route as the ttyd proxy's upgrade handler.
  const events = eventsRouter();
  app.use('/api/events', events.router);
  app.locals.publishStatus = events.publish;
  app.locals.publishSubagents = (event) => events.publish(event, 'subagents');
  app.locals.setInitialEvents = events.setInitialEvents;
  app.use('/api/presence', presenceRouter());
  app.use('/api/accounts', accountsRouter(config));
  app.use('/api/uploads', uploadsRouter());
  app.use('/api/browse', browseRouter(browseStartDirFn ? { startDirFn: browseStartDirFn } : {}));
  app.use('/api/files', filesRouter(config));
  app.use('/api/update', updateRouter(config));
  app.use('/api/claude-update', claudeUpdateRouter(config, claudeCodeUpdateJob ? { job: claudeCodeUpdateJob } : {}));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // NEVER log the raw error object: on a parse failure, express.json()
    // attaches the RAW request body as `err.body`, and the body of POST
    // /api/accounts carries an account token - a `console.error(err)`
    // would write it to stderr in plain text on every broken JSON. Instead
    // a fixed, known-safe subset, which also guards against future error
    // properties. `err.message` is safe: body-parser only cites position
    // and line in it, never the content.
    console.error({ message: err.message, status: err.status, type: err.type });
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

// Aborts startup if the global settings.json sets
// ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN via an `env` block (see
// check-settings-guard.js). If settings.json is missing entirely, there's
// nothing to check - no abort.
function guardOrExit(config) {
  const settingsPath = `${config.claudeHome}/settings.json`;
  if (!fs.existsSync(settingsPath)) return;
  const result = checkNoGlobalAuthOverride(fs.readFileSync(settingsPath, 'utf8'));
  if (!result.ok) {
    console.error(`❌ Startup aborted: ${result.reason}`);
    process.exit(1);
  }
}

// Named rather than inline under the argv check: bin/claudux.js starts the
// server too, and there `process.argv[1]` is the bin script, not this file.
export function startServer(config = loadConfig()) {
  guardOrExit(config);
  // Token handoff files are only valid between session start and wrapper
  // start (see sessionTokenFile.js). After a restart, no session is
  // waiting for them anymore - whatever is left is a pure token leftover
  // on disk and gets removed here.
  cleanupSessionTokenFiles(config.dataDir);
  // Same reasoning for pasted screenshots: an upload only matters for the
  // paste that follows it.
  cleanupUploads();
  // And for the hook settings files: every session started from here on
  // writes its own. Not quite the same reasoning though - the sweep keeps a
  // grace period for the session that was starting as this service
  // restarted, see hookSettingsFile.js.
  cleanupHookSettingsFiles(config.dataDir);
  // Left over from a completed update: the old modules stay in place while
  // the previous process is still using them (see updateRun.js).
  cleanupOldModules().catch(() => {});

  const ttydChild = ttydManager.start({ ttydBin: config.ttydBin, port: config.ttydPort });
  const stopReaper = startReaperInterval(config);
  const claudeCodeUpdate = startClaudeCodeUpdateInterval(config);
  const app = createApp(config, { claudeCodeUpdateJob: claudeCodeUpdate.job });
  const stopStatusWatcher = startStatusWatcherInterval(config, {
    onEvents: (list) => list.forEach((event) => app.locals.publishStatus(event)),
  });
  const subagentWatcher = startSubagentWatcherInterval(config, {
    onEvents: (list) => list.forEach(app.locals.publishSubagents),
  });
  // The subagent stream is deltas only, so whoever connects late hears the
  // running agents from here instead of waiting for one of them to change.
  app.locals.setInitialEvents(() => subagentWatcher.currentEvents().map((event) => ({ type: 'subagents', event })));
  const server = app.listen(config.port, config.host, () => {
    console.log(`Claudux is running on ${config.host}:${config.port}`);
  });
  // Hangs off the raw HTTP server, so it bypasses every Express middleware.
  // Whoever adds auth or a rate limit inside createApp() gets an app that
  // looks protected while the terminal WebSocket stays wide open -
  // silently, since nothing errors. Any such middleware has to be applied
  // to this handler too; the origin check inside it is built that way.
  server.on('upgrade', app.locals.ttydUpgrade);

  // Shutdown order: stop the reaper first (no new run during shutdown),
  // then SIGTERM ttyd and wait briefly for its exit - the timeout fallback
  // keeps a hanging or already dead child from blocking the exit. The tmux
  // servers stay untouched: they are detached and unref'd (see
  // tmuxManager.spawnTmux) and are meant to survive a Claudux restart.
  async function shutdown() {
    stopReaper();
    stopStatusWatcher();
    subagentWatcher.stop();
    claudeCodeUpdate.stop();
    await new Promise((resolve) => {
      if (!ttydChild || ttydChild.exitCode !== null || ttydChild.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2000);
      ttydChild.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      ttydManager.stop(ttydChild);
    });
    process.exit(0);
  }
  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
