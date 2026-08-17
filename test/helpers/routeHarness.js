// Shared fixtures for the route test files (test/routes*.test.js).
//
// What lives here is what more than one of those files needs: a config into
// a temp directory, a listening app, and the tmux fixtures whose
// preconditions are subtle enough that a second copy would drift. Helpers
// only one file uses stay in that file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../../src/server.js';
import { killSession, listTmuxSessions, waitForSession } from '../../src/lib/tmuxManager.js';
import { addProject } from '../../src/lib/projectStore.js';

// POST/PATCH /api/accounts check the token prefix, because a value without
// it gets silently discarded by Claude Code. Tests that create an account
// via the HTTP route therefore need a formally valid token. Tests against
// accountStore.js directly don't: the validation deliberately sits only at
// the system boundary, not in the persistence layer.
export const VALID_TOKEN = `sk-ant-oat01-${'A'.repeat(95)}`;

export function tmpConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-data-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-claude-'));
  return {
    port: 0,
    claudeHome,
    dataDir,
    accountsSecretPath: path.join(dataDir, 'accounts.json'),
    // Spelled out because leaving it off would NOT switch the gate off: an
    // absent field means "on", so a forgotten config cannot produce an open
    // instance. The gate has its own file, test/accessServer.test.js.
    authEnabled: false,
    // Into the tmpdir, so a test never reads or writes the installation's
    // real target store.
    notificationTargetsPath: path.join(dataDir, 'notifications.json'),
    // Same reason, and here it matters more: writing the installation's real
    // keypair would unsubscribe every device registered against it.
    vapidKeysPath: path.join(dataDir, 'vapid.json'),
    vapidSubject: 'https://claudux.example.com',
    idleThresholdMs: 1000,
    publicBaseUrl: 'https://claudux.example.com',
    // Port 1 is a low, privileged port nothing binds to - unlike 7681
    // (the default, see config.js), it can't accidentally proxy a test
    // request into a running ttyd instance.
    ttydPort: 1,
    ...overrides,
  };
}

// App plus a listening server for the session routes. `port` is what the
// tests fetch against; `close` frees the handle, without which node:test
// waits for the timeout instead of finishing.
export function startApp(config) {
  const server = createApp(config).listen(0);
  const { port } = server.address();
  return { port, close: () => { server.closeAllConnections(); server.close(); } };
}

// A project on disk, so the resume route finds a real directory.
export function tmpProject(config, name = 'one') {
  return addProject(path.join(config.dataDir, 'projects.json'), {
    name, projectPath: fs.mkdtempSync(path.join(os.tmpdir(), 'claudux-proj-')),
  });
}

export function postJson(port, route, body) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function patchJson(port, route, body) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// spawnTmux is fire-and-forget: the route answers as soon as the
// `tmux new-session` child has started, so a kill right after it often hits
// a session that does not exist yet. A `.catch(() => {})` would just swallow
// the error and leave the leak in place, hence retrying until it succeeds.
export async function killSessionEventually(name, attempts = 20, delayMs = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      await killSession(name);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// `pane_dead` follows the pane's fd closing, while pane_dead_status and
// pane_dead_signal only exist once tmux has reaped the pane's process - so
// a pane can be listed as dead with no cause of death on it. Every caller
// here asserts on that cause, so this is what they have to wait for.
//
// The wait is bounded and dumps the entry, because the two ways it can run
// out need telling apart: a pane that died the other way carries the field
// the caller is not looking at, while a pane with neither field means tmux
// has not reaped its child - which on a loaded GitHub runner it may never
// do (see the task-4 report). Waiting longer does not help there.
export async function waitForPaneDeath(sessionId, { attempts = 30, delayMs = 100 } = {}) {
  let entry;
  for (let i = 0; i < attempts; i++) {
    entry = (await listTmuxSessions()).find((s) => s.name === sessionId);
    if (entry?.dead && (entry.deadStatus !== null || entry.deadSignal !== null)) return entry;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`pane of ${sessionId} did not report a cause of death: ${JSON.stringify(entry)}`);
}

// TEMPORARY experiment, removed once its answer is recorded. Signals do not
// queue: a SIGCHLD that arrives while tmux is between waitpid calls is
// dropped, and tmux reaps in a waitpid(-1, WNOHANG) loop - so a zombie left
// behind that way would be collected by the NEXT SIGCHLD, along with its
// wait status. `tmux run-shell` forks a child of the server, so letting one
// exit produces exactly that next SIGCHLD.
//
// No `-t`: the target would be the one unchecked value in here, and
// run-shell needs none to fork its child.
async function flushProbe(sessionId, pid) {
  const run = (cmd, args) => new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    proc.on('close', (code) => resolve(`exit ${code}: ${out.trim()}`));
    proc.on('error', (e) => resolve(`spawn failed: ${e.message}`));
  });
  const stat = (label) => run('sh', ['-c', `ps -o stat= -p ${pid} 2>&1 | tr -d ' \\n'; echo " (${label})"`]);
  const before = (await listTmuxSessions()).find((s) => s.name === sessionId);
  const zombieBefore = await stat('before');
  const shell = await run('tmux', ['run-shell', 'true']);
  const samples = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const late = (await listTmuxSessions()).find((s) => s.name === sessionId);
    samples.push(late);
    if (late?.deadStatus !== null || late?.deadSignal !== null) break;
  }
  const zombieAfter = await stat('after');
  console.error([
    `FLUSH ${sessionId}: pid ${pid}`,
    `FLUSH before: ${JSON.stringify(before)} ${zombieBefore.trim()}`,
    `FLUSH run-shell: ${shell}`,
    `FLUSH after ${samples.length * 100}ms: ${JSON.stringify(samples.at(-1))} ${zombieAfter.trim()}`,
  ].join('\n'));
}

// A crash in production is the pane's process dying while the tmux session
// stays. Returns the sessionId of a session that is now a corpse.
export async function crashPaneProcess(sessionId, { signal = 'SIGKILL' } = {}) {
  const pid = await new Promise((resolve) => {
    const proc = spawn('tmux', ['list-panes', '-t', sessionId, '-F', '#{pane_pid}']);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim()));
  });
  assert.ok(pid, 'precondition: the pane PID was read');
  process.kill(Number(pid), signal);
  let entry;
  try {
    entry = await waitForPaneDeath(sessionId);
  } catch (err) {
    // TEMPORARY experiment, removed once its answer is recorded.
    await flushProbe(sessionId, pid);
    throw err;
  }
  // An exit status instead of a signal means the pane process was already
  // gone when the kill above landed. Caught here, with the whole entry, so
  // it doesn't reach the callers as a bare `null !== 9` on the signal.
  assert.notEqual(entry.deadSignal, null,
    `precondition: the pane died by the test's signal, not on its own: ${JSON.stringify(entry)}`);
  return entry;
}

// Waits until the session is not only there but actually alive. Without
// this, a `claude` that exits at once on the test token would leave a
// corpse, and crashPaneProcess above would kill a PID that is already gone -
// flaky in a way that looks like a signal mismatch instead of a bad
// precondition.
export async function assertAliveSession(sessionId) {
  assert.equal(await waitForSession(sessionId), true, 'precondition: the tmux session started');
  const entry = (await listTmuxSessions()).find((s) => s.name === sessionId);
  assert.ok(entry, 'precondition: the session is listed');
  assert.equal(entry.dead, false, 'precondition: the pane is alive before the test kills it');
}

export async function startedSession(config, name) {
  const { addAccount } = await import('../../src/lib/accountStore.js');
  const account = addAccount(config.accountsSecretPath, 'private', 'sk-test-token');
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), `claudux-${name}-`));
  const app = createApp(config);
  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const project = await (
    await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, projectPath }),
    })
  ).json();
  const session = await (
    await fetch(`${base}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: account.id }),
    })
  ).json();
  await assertAliveSession(session.id);
  return { base, server, project, session };
}
