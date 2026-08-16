import os from 'node:os';
import path from 'node:path';

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 4001),
    // Every interface. What used to argue for loopback was that the port
    // handed out a shell without asking; the login carries that now (see
    // accessGate.js), and an interface reachable only from its own machine
    // is useless for the one thing this is built for - reaching a session
    // from another device. HOST=127.0.0.1 restores the closed bind, which is
    // what an installation behind a proxy on the same host wants.
    host: env.HOST || '0.0.0.0',
    // os.homedir() rather than process.env.HOME, here and in every default
    // below: a systemd unit without `User=` inherits no HOME, and the
    // interpolation would have produced the relative path "undefined/…" -
    // which resolves inside the checkout, the one place these files must
    // not be.
    claudeHome: env.CLAUDE_HOME || path.join(os.homedir(), '.claude'),
    // Same reasoning as the secret paths below: outside the checkout. A
    // CWD-relative default has no meaning under `npx`, where the package
    // lives in the npm cache and the working directory is arbitrary.
    dataDir: env.DATA_DIR || path.join(os.homedir(), '.claudux', 'data'),
    // On unless something says otherwise. A forgotten or empty value must
    // not hand out a shell, and `EnvironmentFile=` in systemd keeps trailing
    // comments, so an empty value is a case that actually occurs.
    authEnabled: env.AUTH_ENABLED !== 'false',
    // Same reasoning as accountsSecretPath below: outside the checkout,
    // behind file permissions.
    accessSecretPath:
      env.ACCESS_SECRET_PATH || path.join(os.homedir(), '.claudux', 'access.json'),
    // Outside the checkout on purpose (see README), but not root-owned
    // either - `/var/lib/claudux` needed sudo to create and doesn't exist
    // at all on macOS, which broke the very first account on a fresh,
    // non-systemd install.
    accountsSecretPath:
      env.ACCOUNTS_SECRET_PATH || path.join(os.homedir(), '.claudux', 'accounts.json'),
    // Same reasoning as accountsSecretPath: outside the checkout, behind
    // file permissions. A webhook url is itself a credential.
    notificationTargetsPath:
      env.NOTIFICATION_TARGETS_PATH || path.join(os.homedir(), '.claudux', 'notifications.json'),
    // Same reasoning as notificationTargetsPath: outside the checkout, behind
    // file permissions. Its own file rather than a field in a target - one
    // keypair serves every registered device, and deleting it unsubscribes
    // all of them.
    vapidKeysPath: env.VAPID_KEYS_PATH || path.join(os.homedir(), '.claudux', 'vapid.json'),
    // The `sub` claim of the VAPID token. Push services reject a token
    // without a usable one, and Apple's is strict about it. Derived from
    // publicBaseUrl when unset; the repository url is the last resort,
    // because a hardcoded hostname has no business in this file.
    vapidSubject:
      env.VAPID_SUBJECT
      || (env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).origin : '')
      || 'https://github.com/snazzybean/claudux',
    // Root for the "+ Add folder" browse dialog (src/routes/browse.js).
    // $HOME rather than a fixed directory: anything else is a local
    // convention that makes the browse button unusable elsewhere
    // (`POST /api/projects` itself takes any path, unaffected by this).
    browseRoot: env.PROJECTS_BROWSE_ROOT || os.homedir(),
    idleThresholdMs: Number(env.IDLE_THRESHOLD_MS || 4 * 60 * 60 * 1000),
    // Shorter threshold for sessions nobody ever typed a word into
    // (recognizable by the missing JSONL, see buildIsUnused in
    // reaper.js). They still occupy a full `claude` process, and an empty
    // conversation doesn't need the full grace period.
    //
    // Not tighter than the reaper's own interval: a session that was just
    // started should survive reading in another one in the meantime. Set
    // too small, it hits exactly the session you were about to use.
    shortIdleThresholdMs: Number(env.UNUSED_IDLE_THRESHOLD_MS || 30 * 60 * 1000),
    // Even shorter for the ephemeral `claude setup-token` sessions: their
    // screen shows a freshly generated token in plain text, and whoever
    // opens the tmux session reads it. After a completed login, the UI
    // ends it itself; this threshold applies to the abort case, where
    // nobody comes back.
    //
    // A floor, not a deadline - cleanup happens on the reaper's next pass.
    loginIdleThresholdMs: Number(env.LOGIN_IDLE_THRESHOLD_MS || 15 * 60 * 1000),
    // Frontend base URL for the notification's click link. A property of
    // the installation, not of a target - which is why this one stays in
    // .env while the targets themselves moved into the UI. Empty means the
    // notification goes out without a link instead of with a broken one.
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    // Port the ttyd child process listens on at 127.0.0.1 - 7681 is ttyd's
    // own default. ttydBin allows a different install location instead of
    // resolving through PATH.
    ttydPort: Number(env.TTYD_PORT || 7681),
    ttydBin: env.TTYD_BIN || 'ttyd',
  };
}
