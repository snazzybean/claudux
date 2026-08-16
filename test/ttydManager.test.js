import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTtydArgs, ATTACH_SCRIPT_PATH, start, stop } from '../src/lib/ttydManager.js';
import { getUtf8LocaleEnv } from '../src/lib/locale.js';

test('buildTtydArgs sets loopback-only, writable, base path, no leave alert', () => {
  const args = buildTtydArgs({ port: 7681, attachScriptPath: '/opt/app/src/ttyd/attach.sh' });
  assert.deepEqual(args, [
    '-p', '7681',
    '-i', '127.0.0.1',
    '-W',
    '-b', '/ttyd',
    '-t', 'disableLeaveAlert=true',
    '-a', '/opt/app/src/ttyd/attach.sh',
  ]);
});

test('ATTACH_SCRIPT_PATH points at src/ttyd/attach.sh, absolute', () => {
  assert.match(ATTACH_SCRIPT_PATH, /\/src\/ttyd\/attach\.sh$/);
});

test('start passes binary, built arguments and the locale env to spawnFn', () => {
  let captured;
  const fakeSpawn = (bin, args, opts) => {
    captured = { bin, args, opts };
    return { on: () => {}, kill: () => {} };
  };
  start({ ttydBin: 'ttyd', port: 7681 }, { spawnFn: fakeSpawn });
  assert.equal(captured.bin, 'ttyd');
  assert.deepEqual(captured.args, buildTtydArgs({ port: 7681 }));
  const expectedLocale = getUtf8LocaleEnv();
  for (const [key, value] of Object.entries(expectedLocale)) {
    assert.equal(captured.opts.env[key], value);
  }
});

test('start registers an error handler so a missing ttyd binary does not take the process down', () => {
  let errorHandler;
  const fakeSpawn = () => ({
    on: (event, handler) => { if (event === 'error') errorHandler = handler; },
    kill: () => {},
  });
  start({ ttydBin: 'ttyd', port: 7681 }, { spawnFn: fakeSpawn });
  assert.equal(typeof errorHandler, 'function');
  assert.doesNotThrow(() => errorHandler(new Error('spawn ENOENT')));
});

test('start logs an unexpected exit including the port number', () => {
  let exitHandler;
  const fakeSpawn = () => ({
    on: (event, handler) => { if (event === 'exit') exitHandler = handler; },
    kill: () => {},
  });
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    start({ ttydBin: 'ttyd', port: 17682 }, { spawnFn: fakeSpawn });
    exitHandler(1, null);
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /17682/);
});

test('an exit triggered by stop() is NOT logged', () => {
  let exitHandler;
  const fakeChild = {
    on: (event, handler) => { if (event === 'exit') exitHandler = handler; },
    kill: () => {},
  };
  const fakeSpawn = () => fakeChild;
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const child = start({ ttydBin: 'ttyd', port: 17683 }, { spawnFn: fakeSpawn });
    stop(child);
    exitHandler(0, 'SIGTERM');
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 0);
});

test('stop sends SIGTERM to the given child process', () => {
  let killedWith;
  const fakeChild = { kill: (sig) => { killedWith = sig; } };
  stop(fakeChild);
  assert.equal(killedWith, 'SIGTERM');
});

test('stop does nothing when no child process is given', () => {
  assert.doesNotThrow(() => stop(null));
});

// A real process, the way tmuxManager.test.js already does for tmux -
// proof that the built arguments produce a ttyd that actually runs, not
// just one that looks syntactically plausible.
test('start really starts ttyd, reachable under the base path', async () => {
  const port = 17681;
  const child = start({ ttydBin: 'ttyd', port });
  try {
    const deadline = Date.now() + 2000;
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ttyd/`);
        ok = res.status === 200;
        if (ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ok, true);
  } finally {
    stop(child);
  }
});
