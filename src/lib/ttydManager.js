import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getUtf8LocaleEnv } from './locale.js';

// Absolute rather than relative to cwd - independent of the working
// directory the Node process was started with (same principle as
// SESSION_WRAPPER_PATH in tmuxManager.js).
export const ATTACH_SCRIPT_PATH = fileURLToPath(new URL('../ttyd/attach.sh', import.meta.url));

// -i 127.0.0.1: only the internal proxy should reach ttyd, not the network.
// -W: without it the terminal is read-only.
// -b /ttyd: base path the internal proxy does not strip (see server.js).
// -t disableLeaveAlert=true: ttyd's own client JS registers a beforeunload
// listener that fires on EVERY reassignment of iframe.src, not just on
// actually leaving the page - Claudux reassigns terminalFrame.src on every
// session switch (see openSession() in public/app.js).
export function buildTtydArgs({ port, attachScriptPath = ATTACH_SCRIPT_PATH }) {
  return [
    '-p', String(port),
    '-i', '127.0.0.1',
    '-W',
    '-b', '/ttyd',
    '-t', 'disableLeaveAlert=true',
    '-a', attachScriptPath,
  ];
}

// No module-wide state: the caller (src/server.js) holds the child process
// reference itself and passes it to stop() on shutdown - hidden module
// state would leak between tests.
export function start({ ttydBin, port }, { spawnFn = spawn } = {}) {
  const child = spawnFn(ttydBin, buildTtydArgs({ port }), {
    // stderr inherited instead of ignored: ttyd's own "bind: Address
    // already in use" needs to reach the journal/console - otherwise a
    // port conflict fails ttyd silently while Claudux itself looks healthy.
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ...getUtf8LocaleEnv() },
  });
  child.on('error', (err) => {
    console.error(`ttydManager: could not start "${ttydBin}":`, err.message);
  });
  child.on('exit', (code, signal) => {
    // stop() marks the child before sending SIGTERM - that exit is expected
    // and shouldn't be logged as a failure.
    if (child.stoppedByUs) return;
    console.error(`ttydManager: ttyd ended unexpectedly (code ${code}, signal ${signal}) - port ${port} may already be in use; /ttyd/* stays unreachable until Claudux restarts.`);
  });
  return child;
}

export function stop(child) {
  if (!child) return;
  child.stoppedByUs = true;
  child.kill('SIGTERM');
}
