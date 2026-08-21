import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getUtf8LocaleEnv } from '../src/lib/locale.js';
import {
  isValidSlug,
  buildNewSessionArgs,
  buildHookSettings,
  parseSessionList,
  normalizeTmuxListOutput,
  spawnTmux,
  waitForSession,
  disableStatusBar,
  pinLoginWindowSize,
  killSession,
  showBuffer,
  capturePane,
  buildLoginSessionArgs,
  LOGIN_DONE_MARKER,
  LOGIN_WINDOW_COLS,
  LOGIN_WINDOW_ROWS,
  paneWidth,
  sendKeys,
  aliveSessionNames,
  isUnwantedDeath,
  setRemainOnExit,
  hasSession,
  listTmuxSessions,
} from '../src/lib/tmuxManager.js';

// tmux output from `show-options` comes back as "status off\n" (name +
// value, space-separated) - only the value matters here. `-A` is required
// because `show-options` outputs NOTHING without this flag as long as the
// option was never explicitly set on this session (a plain default value
// isn't shown otherwise, only one actually set on this session).
function tmuxShowOption(name, option) {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['show-options', '-A', '-t', name, option]);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim().split(' ')[1] ?? ''));
  });
}

async function killSessionEventually(name, attempts = 20, delayMs = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      await killSession(name);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

test('isValidSlug accepts UUIDs and the login prefix, rejects special characters', () => {
  assert.equal(isValidSlug('11111111-1111-1111-1111-111111111111'), true);
  assert.equal(isValidSlug('login-a1b2c3d4'), true);
  assert.equal(isValidSlug('foo; rm -rf /'), false);
  assert.equal(isValidSlug(''), false);
});

// The token must NOT go into argv: /proc/<pid>/cmdline is world-readable,
// any local account could read it via `ps aux`. The process environment,
// by contrast, is only readable by the owner - so the token comes in via a
// 0600 file, whose PATH is in argv, not its content.
test('buildNewSessionArgs keeps the token out of argv and passes a token file path instead', () => {
  const args = buildNewSessionArgs({
    sessionId: '11111111-1111-1111-1111-111111111111',
    projectPath: '/srv/project',
    tokenFilePath: '/var/lib/claudux/session-tokens/11111111.token',
    resume: false,
  });

  assert.deepEqual(args.slice(0, 6), [
    'new-session', '-d',
    '-s', '11111111-1111-1111-1111-111111111111',
    '-c', '/srv/project',
  ]);
  assert.match(args[6], /claude-session\.sh$/);
  assert.equal(args[7], '/var/lib/claudux/session-tokens/11111111.token');
});

// Nothing in argv may look like the token value.
test('buildNewSessionArgs contains no token value or the env variable anywhere', () => {
  const args = buildNewSessionArgs({
    sessionId: 'abc',
    projectPath: '/srv/x',
    tokenFilePath: '/var/lib/claudux/session-tokens/abc.token',
    resume: false,
  });
  const all = args.join(' ');

  assert.ok(!all.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(!all.includes('sk-ant-'));
});

// Argv stays an array of separate elements - no `sh -c "…"` string.
// tmuxManager.js never assembles shell command lines as a matter of
// principle (see the header comment there); the wrapper is a real script,
// specifically so this principle isn't weakened by the security fix.
test('buildNewSessionArgs builds no shell string', () => {
  const args = buildNewSessionArgs({
    sessionId: 'abc',
    projectPath: '/srv/x',
    tokenFilePath: '/t/abc.token',
    resume: false,
  });

  assert.ok(!args.includes('-c') || args.indexOf('-c') === 4); // only tmux's own -c (working directory)
  assert.ok(!args.some((a) => a === 'sh' || a === 'bash'));
});

test('buildNewSessionArgs appends --resume when resume=true', () => {
  const args = buildNewSessionArgs({
    sessionId: 'abc',
    projectPath: '/srv/x',
    tokenFilePath: '/t/abc.token',
    resume: true,
  });
  assert.deepEqual(args.slice(-2), ['--resume', 'abc']);
});

test('buildNewSessionArgs throws on an invalid sessionId', () => {
  assert.throws(() => buildNewSessionArgs({
    sessionId: 'foo; rm -rf /',
    projectPath: '/srv/x',
    tokenFilePath: '/t/x.token',
    resume: false,
  }));
});

// `-c` is an OPTION value, and tmux format-expands those: `#(…)` in the
// path is a shell command run as the service user, without any shell string
// being assembled. The argv rule this module follows does not cover it.
test('buildNewSessionArgs throws on a project path tmux would expand or resolve itself', () => {
  for (const projectPath of ['/srv/#(id)', '/srv/#{pane_id}', 'relative/x', '', null]) {
    assert.throws(() => buildNewSessionArgs({
      sessionId: 'abc',
      projectPath,
      tokenFilePath: '/t/x.token',
      resume: false,
    }), `${projectPath} should be refused`);
  }
});

// Regression guard for the idle reaper: reaper.js decides via
// hasLiveChildrenForSession() based on the CHILDREN of the pane process. If
// the wrapper started `claude` without `exec`, the wrapper shell would stay
// the pane process and claude would permanently be its child - the session
// would always have "live children" and would never get cleaned up. The
// test targets the script because that's exactly where the property lives.
test('the session wrapper script replaces itself with claude via exec', async () => {
  const fsp = await import('node:fs/promises');
  const url = await import('node:url');
  const scriptPath = url.fileURLToPath(new URL('../scripts/claude-session.sh', import.meta.url));
  const content = await fsp.readFile(scriptPath, 'utf8');

  assert.match(content, /^exec claude "\$@"$/m);
});

// The token file must not outlive the session - it only hands off between
// the server and session start.
test('the session wrapper script deletes the token file after reading it', async () => {
  const fsp = await import('node:fs/promises');
  const url = await import('node:url');
  const scriptPath = url.fileURLToPath(new URL('../scripts/claude-session.sh', import.meta.url));
  const content = await fsp.readFile(scriptPath, 'utf8');

  assert.match(content, /rm -f "\$tokenfile"/);
});

test('parseSessionList parses tab-separated tmux output', () => {
  const raw = 'sess-a\t1723000000\t1\t1722990000\nsess-b\t1723000100\t0\t1722990100\n';
  assert.deepEqual(parseSessionList(raw), [
    { name: 'sess-a', activityEpoch: 1723000000, attached: true, createdEpoch: 1722990000, dead: false, deadStatus: null, deadSignal: null },
    { name: 'sess-b', activityEpoch: 1723000100, attached: false, createdEpoch: 1722990100, dead: false, deadStatus: null, deadSignal: null },
  ]);
});

test('parseSessionList returns an empty array for empty output', () => {
  assert.deepEqual(parseSessionList(''), []);
});

// The start time is the sort key for sessions that don't have a JSONL file
// yet. If the field is missing (older output), that must not turn into
// NaN - a NaN sort key would scramble the entire list instead of just this
// one row.
test('parseSessionList returns createdEpoch null when tmux doesn\'t supply the field', () => {
  assert.deepEqual(parseSessionList('sess-a\t1723000000\t1\n'), [
    { name: 'sess-a', activityEpoch: 1723000000, attached: true, createdEpoch: null, dead: false, deadStatus: null, deadSignal: null },
  ]);
});

test('parseSessionList treats session_attached as a count, not strictly boolean (multiple clients)', () => {
  // #{session_attached} is, per the tmux docs, the COUNT of attached
  // clients, not 0/1. Two clients connected at once (e.g. phone + laptop
  // via ttyd) return "2" - that must be treated as attached: true,
  // otherwise the idle reaper could wrongly kill a session that's
  // being actively watched.
  const raw = 'sess-a\t1723000000\t2\t1722990000\n';
  assert.deepEqual(parseSessionList(raw), [
    { name: 'sess-a', activityEpoch: 1723000000, attached: true, createdEpoch: 1722990000, dead: false, deadStatus: null, deadSignal: null },
  ]);
});

test('normalizeTmuxListOutput translates colon-separated tmux output to tab, even when the name field contains a comma', () => {
  // Regression: the session name comes from tmux itself and can originate
  // from a foreign session on the same tmux socket that this module didn't
  // create (isValidSlug/SLUG_RE only applies to sessions Claudux creates
  // itself). tmux allows commas in session names without restriction - a
  // comma delimiter would tear such names apart. A colon, on the other
  // hand, can NEVER occur in any session name (tmux already sanitizes ':'
  // to '_' at session creation time), so it's collision-free as an
  // internal delimiter.
  const raw = 'weird,name:1723000000:1:1722990000\nsess-b:1723000100:0:1722990100\n';
  assert.deepEqual(parseSessionList(normalizeTmuxListOutput(raw)), [
    { name: 'weird,name', activityEpoch: 1723000000, attached: true, createdEpoch: 1722990000, dead: false, deadStatus: null, deadSignal: null },
    { name: 'sess-b', activityEpoch: 1723000100, attached: false, createdEpoch: 1722990100, dead: false, deadStatus: null, deadSignal: null },
  ]);
});

test('parseSessionList reads the dead fields', () => {
  // Field order: name, activity, attached, created, dead, status, signal
  const raw = 'alive\t100\t0\t50\t0\t\t\ncrashed\t200\t0\t60\t1\t3\t\nkilled\t300\t0\t70\t1\t\t9';
  const [alive, crashed, killed] = parseSessionList(raw);

  assert.equal(alive.dead, false);
  assert.equal(alive.deadStatus, null);
  assert.equal(alive.deadSignal, null);

  assert.equal(crashed.dead, true);
  assert.equal(crashed.deadStatus, 3);
  assert.equal(crashed.deadSignal, null);

  // A SIGKILL leaves pane_dead_status EMPTY and reports through the signal
  // field. Both fields have to be read.
  assert.equal(killed.dead, true);
  assert.equal(killed.deadStatus, null);
  assert.equal(killed.deadSignal, 9);
});

test('aliveSessionNames drops the corpses', () => {
  const sessions = [
    { name: 'a', dead: false },
    { name: 'b', dead: true },
    { name: 'c', dead: false },
  ];
  assert.deepEqual(aliveSessionNames(sessions), ['a', 'c']);
});

test('isUnwantedDeath separates a crash from a clean exit', () => {
  assert.equal(isUnwantedDeath({ dead: true, deadStatus: 3, deadSignal: null }), true);
  assert.equal(isUnwantedDeath({ dead: true, deadStatus: null, deadSignal: 9 }), true);
  // /exit and Ctrl+D: the user meant it, so no toast and nothing to log.
  assert.equal(isUnwantedDeath({ dead: true, deadStatus: 0, deadSignal: null }), false);
  assert.equal(isUnwantedDeath({ dead: false, deadStatus: null, deadSignal: null }), false);
});

test('disableStatusBar turns off the tmux status bar for a real session', async () => {
  const name = 'disable-status-test';
  spawnTmux(['new-session', '-d', '-s', name, 'sleep', '30']);
  await waitForSession(name);

  assert.equal(await tmuxShowOption(name, 'status'), 'on'); // tmux default

  await disableStatusBar(name);

  assert.equal(await tmuxShowOption(name, 'status'), 'off');
  await killSessionEventually(name);
});

test('disableStatusBar ignores invalid session names instead of building a tmux command with unvalidated input', async () => {
  // No throw, no exception - consistent with how hasSession() handles
  // isValidSlug() failures (see there).
  await assert.doesNotReject(disableStatusBar('; rm -rf /'));
});

// window-size is a per-WINDOW option, not per-session - show-window-options
// (not show-options) is what actually reflects set-window-option here.
function tmuxShowWindowOption(name, option) {
  return new Promise((resolve) => {
    // `show-window-options` doesn't support -A at all on this tmux version
    // (3.5a errors "unknown flag") - the generic `show-options -w` does,
    // and -w is what targets window (not session) options with it. -A:
    // same reason as tmuxShowOption above, an option that was never
    // explicitly set on this window (the default, "latest", before
    // pinLoginWindowSize runs) would otherwise show up as nothing at all.
    const proc = spawn('tmux', ['show-options', '-w', '-A', '-t', name, option]);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out.trim().split(' ')[1] ?? ''));
  });
}

test('pinLoginWindowSize sets window-size to manual, opting out of resizing to a later-attached client', async () => {
  const name = 'pin-window-test';
  spawnTmux(['new-session', '-d', '-s', name, 'sleep', '30']);
  await waitForSession(name);

  assert.equal(await tmuxShowWindowOption(name, 'window-size'), 'latest'); // tmux default

  await pinLoginWindowSize(name);

  assert.equal(await tmuxShowWindowOption(name, 'window-size'), 'manual');
  await killSessionEventually(name);
});

test('pinLoginWindowSize ignores invalid session names instead of building a tmux command with unvalidated input', async () => {
  await assert.doesNotReject(pinLoginWindowSize('; rm -rf /'));
});

test('setRemainOnExit keeps the session alive when its process dies', async () => {
  const name = `claudux-remain-${crypto.randomUUID()}`;
  await new Promise((resolve) => {
    const proc = spawn('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', 'sleep 1; exit 3']);
    proc.on('close', () => resolve());
  });
  try {
    await setRemainOnExit(name);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await hasSession(name), true, 'without remain-on-exit tmux would have torn the session down');
    const entry = (await listTmuxSessions()).find((s) => s.name === name);
    assert.equal(entry.dead, true);
    assert.equal(entry.deadStatus, 3);
    assert.equal(isUnwantedDeath(entry), true);
  } finally {
    await killSession(name).catch(() => {});
  }
});

test('setRemainOnExit leaves a corpse a SIGKILL can be read off', async () => {
  const name = `claudux-remain-signal-${crypto.randomUUID()}`;
  await new Promise((resolve) => {
    const proc = spawn('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', 'sleep 30']);
    proc.on('close', () => resolve());
  });
  try {
    await setRemainOnExit(name);
    const pid = await new Promise((resolve) => {
      const proc = spawn('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}']);
      let out = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.on('close', () => resolve(out.trim()));
    });
    assert.ok(pid, 'precondition: the pane PID was read');
    process.kill(Number(pid), 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    const entry = (await listTmuxSessions()).find((s) => s.name === name);
    assert.ok(entry, 'the session still exists - that is what remain-on-exit is for');
    assert.equal(entry.dead, true);
    // The OOM case: status stays empty, the signal carries the news.
    assert.equal(entry.deadStatus, null);
    assert.equal(entry.deadSignal, 9);
    assert.equal(isUnwantedDeath(entry), true);
  } finally {
    await killSession(name).catch(() => {});
  }
});

test('setRemainOnExit resolves for an invalid session name', async () => {
  await setRemainOnExit('not a valid name');
});

test('listTmuxSessions reports a live pane as not dead', async () => {
  const name = `claudux-alive-${crypto.randomUUID()}`;
  await new Promise((resolve) => {
    const proc = spawn('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', 'sleep 30']);
    proc.on('close', () => resolve());
  });
  try {
    const entry = (await listTmuxSessions()).find((s) => s.name === name);
    assert.ok(entry, 'precondition: the session is listed');
    assert.equal(entry.dead, false);
    // tmux leaves both fields EMPTY while the pane lives - not "0".
    assert.equal(entry.deadStatus, null);
    assert.equal(entry.deadSignal, null);
  } finally {
    await killSession(name).catch(() => {});
  }
});

// tmux buffers are ONE global stack for the whole host, not isolated
// test state. The test therefore runs against the real tmux server and
// only verifies the roundtrip with a unique value, instead of assuming a
// clean starting state.
//
// The final delete-buffer is mandatory: otherwise the test marker stays as
// "most recently copied" and shows up in a real session if someone there
// uses the copy feature. Without -b it removes exactly the top buffer and
// makes the previous one current again. A short window between set-buffer
// and delete-buffer remains.
test('showBuffer reads the content most recently set via tmux set-buffer', async () => {
  const marker = `claudux-showbuffer-test-${crypto.randomUUID()}`;
  await new Promise((resolve, reject) => {
    const proc = spawn('tmux', ['set-buffer', marker]);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`set-buffer exit ${code}`))));
  });

  try {
    assert.equal(await showBuffer(), marker);
  } finally {
    await new Promise((resolve) => {
      const proc = spawn('tmux', ['delete-buffer']);
      proc.on('close', () => resolve()); // best effort - the test result doesn't depend on it
    });
  }
});

// capturePane reads the visible pane content of a session. Unlike
// showBuffer (server-global buffer stack, see comment above) this is
// session-scoped: `-t <name>` addresses exactly one session, foreign
// sessions on the same tmux server stay untouched.
//
// Needed for auth detection (src/lib/authStatus.js): an expired login
// leaves neither an exit code nor a status file, only text in the pane -
// without reading it, it stays invisible to Claudux.
test('capturePane reads the visible content of exactly the addressed session', async () => {
  const name = `claudux-capture-${crypto.randomUUID()}`;
  const marker = `marker-${crypto.randomUUID()}`;
  // `echo <marker>; sleep …` instead of just `echo`: without a running
  // process the session would end again immediately and be gone by the
  // time it's read.
  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', `echo ${marker}; sleep 30`]);
  await waitForSession(name);

  try {
    const content = await capturePane(name);
    assert.match(content, new RegExp(marker));
  } finally {
    await killSession(name).catch(() => {});
  }
});

// Analogous to hasSession/disableStatusBar: an invalid name must not
// trigger a tmux call with an uncontrolled argument (see the file header
// comment on argv construction in tmuxManager.js).
test('capturePane rejects an invalid session name instead of calling tmux', async () => {
  await assert.rejects(() => capturePane('not;a valid name'));
});

// A nonexistent session is a normal state for callers (the session may
// have ended between listing and reading) - that must not make the auth
// check abort with an error.
test('capturePane returns an empty string for a nonexistent session', async () => {
  assert.equal(await capturePane(`claudux-does-not-exist-${crypto.randomUUID()}`), '');
});

// tmux ends a session as soon as its command finishes. With a bare
// `claude setup-token`, the token would only sit in the pane for a
// fraction of a second and couldn't be copied - the session must stay open
// afterward.
test('buildLoginSessionArgs keeps the session open instead of ending with setup-token', () => {
  const args = buildLoginSessionArgs('login-a1b2c3d4');
  const command = args[args.length - 1];

  assert.match(command, /claude setup-token/);
  // A blocking `read` after the command: without it the session dies with
  // the process and takes the token with it.
  assert.match(command, /read/);
});

// Chained with `;`, not `&&`: if setup-token fails (wrong code, network
// error), the error message must stay readable on screen - with `&&` the
// session would close exactly when there's something to see.
test('buildLoginSessionArgs keeps the session open even when setup-token fails', () => {
  const command = buildLoginSessionArgs('login-a1b2c3d4').at(-1);

  assert.ok(!/setup-token\s*&&/.test(command));
});

test('buildLoginSessionArgs creates a detached session under the given name', () => {
  const args = buildLoginSessionArgs('login-a1b2c3d4');

  assert.deepEqual(args.slice(0, 4), ['new-session', '-d', '-s', 'login-a1b2c3d4']);
});

// Wide enough that a real ~100-character token never wraps - a wrapped
// token makes a truncated capture look complete (see loginScreen.js). -x/-y
// only fix the INITIAL size; pinLoginWindowSize is what makes it stick past
// a client attaching later.
test('buildLoginSessionArgs fixes an initial window size wide enough for a real token', () => {
  const args = buildLoginSessionArgs('login-a1b2c3d4');

  const xIndex = args.indexOf('-x');
  const yIndex = args.indexOf('-y');
  assert.ok(xIndex > 0 && yIndex > 0);
  assert.equal(args[xIndex + 1], String(LOGIN_WINDOW_COLS));
  assert.equal(args[yIndex + 1], String(LOGIN_WINDOW_ROWS));
});

// loginScreen.js gates completeness on this marker precisely because it's
// printed by THIS command, after setup-token has already exited - not CLI
// wording that could drift.
test('buildLoginSessionArgs prints LOGIN_DONE_MARKER only after setup-token has exited', () => {
  const command = buildLoginSessionArgs('login-a1b2c3d4').at(-1);

  assert.ok(command.includes(LOGIN_DONE_MARKER));
  assert.ok(command.indexOf('claude setup-token') < command.indexOf(LOGIN_DONE_MARKER));
});

test('buildLoginSessionArgs throws on an invalid session name', () => {
  assert.throws(() => buildLoginSessionArgs('foo; rm -rf /'));
});

// The tmux server is started by the systemd service and has no HOME of
// its own; every session inherits that gap. Claude Code copes with it,
// shell hooks abort under `set -u` with "HOME: unbound variable". The
// wrapper is the one place every session runs through.
test('the session wrapper script backfills a missing HOME before starting claude', async () => {
  const fsp = await import('node:fs/promises');
  const os2 = await import('node:os');
  const path2 = await import('node:path');
  const url = await import('node:url');
  const { spawn: spawn2 } = await import('node:child_process');

  const scriptPath = url.fileURLToPath(new URL('../scripts/claude-session.sh', import.meta.url));
  const dir = await fsp.mkdtemp(path2.join(os2.tmpdir(), 'claudux-home-'));
  // Fake `claude` in PATH: prints what the script passed through as HOME.
  // The real binary is deliberately not started for this.
  await fsp.writeFile(path2.join(dir, 'claude'), '#!/bin/sh\necho "HOME=[$HOME]"\n', { mode: 0o755 });
  const tokenFile = path2.join(dir, 'tok');
  await fsp.writeFile(tokenFile, 'sk-ant-oat01-unused', { mode: 0o600 });

  const output = await new Promise((resolve) => {
    // env WITHOUT HOME - exactly the situation in a real Claudux session.
    const proc = spawn2(scriptPath, [tokenFile], {
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(out));
  });

  assert.doesNotMatch(output, /HOME=\[\]/, 'HOME arrived empty at claude');
  assert.match(output, /HOME=\[\/.+\]/);
});

// If the wrapper fails, that must not stay invisible: without the `read`
// the tmux session dies in the same instant, and in the browser all that's
// visible is a flicker. The message must stay on screen.
test('the session wrapper script shows a readable message when the token file is missing, instead of dying silently', async () => {
  const url = await import('node:url');
  const { spawn: spawn2 } = await import('node:child_process');
  const scriptPath = url.fileURLToPath(new URL('../scripts/claude-session.sh', import.meta.url));

  const { output, code } = await new Promise((resolve) => {
    const proc = spawn2(scriptPath, ['/does/not/exist/tok'], { env: { PATH: process.env.PATH } });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    // Close stdin right away: the waiting `read` gets EOF and the test
    // doesn't hang - in a real terminal it waits for the user instead.
    proc.stdin.end();
    proc.on('close', (c) => resolve({ output: out, code: c }));
  });

  assert.match(output, /token file/);
  // It must be recognizable that input is being waited for here -
  // otherwise the session closes before anyone reads the message.
  assert.match(output, /Enter/);
  assert.notEqual(code, 0);
});

// Without `--session-id` two numbering schemes run side by side: Claudux
// names the tmux session after a self-generated UUID, Claude Code writes
// its JSONL history under one of its own. The sidebar lists the history,
// `live` resolves via the tmux name - the two never meet.
//
// Consequence: no live marker, no account chip, and opening it later
// creates a SECOND tmux session alongside the first, which keeps running
// as an orphan. The resume path isn't affected, because it uses a real
// Claude session ID from the history.
test('buildNewSessionArgs passes the session ID to claude so the tmux name and Claude session ID match', () => {
  const args = buildNewSessionArgs({
    sessionId: '11111111-1111-1111-1111-111111111111',
    projectPath: '/srv/project',
    tokenFilePath: '/t/x.token',
    resume: false,
  });

  assert.deepEqual(args.slice(-2), ['--session-id', '11111111-1111-1111-1111-111111111111']);
});

// On resume, --session-id must NOT also be set: --resume already
// addresses an existing conversation, having both together would be
// contradictory.
test('buildNewSessionArgs sets only --resume on resume, not --session-id as well', () => {
  const args = buildNewSessionArgs({
    sessionId: 'abc',
    projectPath: '/srv/x',
    tokenFilePath: '/t/x.token',
    resume: true,
  });

  assert.ok(!args.includes('--session-id'));
  assert.deepEqual(args.slice(-2), ['--resume', 'abc']);
});


test('paneWidth returns the width of a running session', async () => {
  const name = `claudux-width-${crypto.randomUUID()}`;
  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', 'read _']);
  await waitForSession(name);
  try {
    const width = await paneWidth(name);
    assert.ok(Number.isInteger(width) && width > 0, `unexpected width: ${width}`);
  } finally {
    await killSession(name);
  }
});

// No reject when the session is missing: the caller polls on a beat, and a
// login session that just ended is the normal case, not an error.
test('paneWidth returns 0 for a nonexistent session', async () => {
  assert.equal(await paneWidth(`claudux-does-not-exist-${crypto.randomUUID()}`), 0);
});

// The name goes into a tmux argv as -t. An invalid value must never end up
// there: with an empty target, tmux would hit the CURRENT session.
test('paneWidth rejects an invalid session name', async () => {
  await assert.rejects(() => paneWidth('not; valid'), /Invalid session name/);
});

test('sendKeys writes the text literally into the session', async () => {
  const name = `claudux-sendkeys-${crypto.randomUUID()}`;
  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', 'read input; printf "read:%s\\n" "$input"; read _']);
  await waitForSession(name);
  try {
    await sendKeys(name, 'abc#def');
    await new Promise((r) => setTimeout(r, 500));
    const text = await capturePane(name);
    assert.ok(text.includes('read:abc#def'), `Pane text was: ${text}`);
  } finally {
    await killSession(name);
  }
});

// A code with a leading dash would be read as a tmux option without "--".
// The character pattern in the route forbids it, but the safeguard
// belongs at the place that builds the argv.
test('sendKeys treats a leading dash as text', async () => {
  const name = `claudux-sendkeys-minus-${crypto.randomUUID()}`;
  spawnTmux(['new-session', '-d', '-s', name, 'sh', '-c', 'read input; printf "read:%s\\n" "$input"; read _']);
  await waitForSession(name);
  try {
    await sendKeys(name, '-abc');
    await new Promise((r) => setTimeout(r, 500));
    const text = await capturePane(name);
    assert.ok(text.includes('read:-abc'), `Pane text was: ${text}`);
  } finally {
    await killSession(name);
  }
});

test('sendKeys rejects an invalid session name', async () => {
  await assert.rejects(() => sendKeys('not; valid', 'abc'), /Invalid session name/);
});

test('spawnTmux passes the resolved UTF-8 locale on to the child process', () => {
  let capturedEnv;
  const fakeSpawn = (cmd, args, opts) => {
    capturedEnv = opts.env;
    return { on: () => {}, unref: () => {} };
  };
  spawnTmux(['new-session', '-d', '-s', 'irrelevant'], { spawnFn: fakeSpawn });
  const expected = getUtf8LocaleEnv();
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(capturedEnv[key], value);
  }
});

// showBuffer stands in for the other tmuxEnv() call sites (list-sessions,
// has-session, kill-session, capture-pane, ...): covering one proves the
// helper reaches spawn(), not just spawnTmux()'s own inline env.
test('showBuffer passes the resolved UTF-8 locale on to the child process', async () => {
  let capturedEnv;
  const fakeSpawn = (cmd, args, opts) => {
    capturedEnv = opts.env;
    return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: (event, handler) => { if (event === 'close') handler(0); } };
  };
  await showBuffer({ spawnFn: fakeSpawn });
  const expected = getUtf8LocaleEnv();
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(capturedEnv[key], value);
  }
});

// The same hazard attach.sh has guarded against all along, on the Node
// side: with no session carrying the exact name, tmux prefix-matches, so
// a bare `-t <name>` reaches `<name>-suffix` - and kills, reads or types
// there. One test for all nine call sites; they share the target helper.
test('a session whose name merely starts with the target is neither read nor killed', async () => {
  const base = `claudux-prefix-${crypto.randomUUID()}`;
  const sibling = `${base}-suffix`;
  await new Promise((resolve) => {
    const proc = spawn('tmux', ['new-session', '-d', '-s', sibling, 'sh', '-c', 'printf sibling-pane-marker; sleep 30']);
    proc.on('close', () => resolve());
  });
  try {
    assert.equal(await hasSession(sibling), true, 'precondition: the sibling is running');

    assert.equal(await hasSession(base), false);
    assert.equal(await capturePane(base), '');
    await assert.rejects(() => killSession(base));

    assert.equal(await hasSession(sibling), true, 'the sibling must have survived all three');
  } finally {
    await killSession(sibling).catch(() => {});
  }
});

// attach.sh is the last stop before the terminal: ttyd respawns it
// unthrottled, so a session that is gone must not let it exit instantly.
function runAttach(sessionName) {
  const script = fileURLToPath(new URL('../src/ttyd/attach.sh', import.meta.url));
  return new Promise((resolve) => {
    const proc = spawn(script, [sessionName], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    proc.on('close', (code) => resolve({ code, out }));
    proc.on('error', () => resolve({ code: null, out }));
  });
}

test('attach.sh reports a session that no longer exists instead of exiting silently', async () => {
  const { code, out } = await runAttach(crypto.randomUUID());
  assert.notEqual(code, 0);
  assert.match(out, /no longer exists/i);
});

test('attach.sh reports a dead pane instead of attaching to the corpse', async () => {
  const name = crypto.randomUUID();
  await new Promise((resolve) => {
    const proc = spawn('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', 'sleep 30']);
    proc.on('close', () => resolve());
  });
  try {
    await new Promise((resolve) => {
      const proc = spawn('tmux', ['set-window-option', '-t', name, 'remain-on-exit', 'on']);
      proc.on('close', () => resolve());
    });
    // Kill the pane's process, not the session: that is what a crash does.
    const pid = await new Promise((resolve) => {
      const proc = spawn('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}']);
      let o = '';
      proc.stdout.on('data', (d) => (o += d));
      proc.on('close', () => resolve(o.trim()));
    });
    assert.ok(pid, 'precondition: the pane PID was read');
    process.kill(Number(pid), 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    const { code, out } = await runAttach(name);
    assert.notEqual(code, 0);
    assert.match(out, /crashed/i);
  } finally {
    await killSession(name).catch(() => {});
  }
});

// Without "=" tmux falls back to prefix matching when nothing carries the
// exact name: asking for "<name>" would then reach "<name>-suffix" and hand
// the user a terminal into somebody else's session.
test('attach.sh does not reach a session whose name merely starts with the target', async () => {
  const base = crypto.randomUUID();
  const sibling = `${base}-suffix`;
  await new Promise((resolve) => {
    const proc = spawn('tmux', ['new-session', '-d', '-s', sibling, 'sh', '-c', 'sleep 30']);
    proc.on('close', () => resolve());
  });
  try {
    const { code, out } = await runAttach(base);

    assert.notEqual(code, 0);
    assert.match(out, /no longer exists/i);
  } finally {
    await killSession(sibling).catch(() => {});
  }
});

test('attach.sh holds instead of exiting instantly on an invalid name', async () => {
  const { code, out } = await runAttach('not a valid name');

  assert.notEqual(code, 0);
  assert.match(out, /Enter to close/i);
});

// The name gate used to be a character class, so `?arg=<name>` attached
// WRITABLY to any session on the shared tmux socket - including ones
// Claudux never created. Both accepted forms are covered here, because
// dropping the login one would leave "Show terminal" in the account login
// with nothing to open.
test('attach.sh refuses a session it did not issue and keeps accepting login names', async () => {
  const foreign = 'someones-own-terminal';
  await new Promise((resolve) => {
    const proc = spawn('tmux', ['new-session', '-d', '-s', foreign, 'sh', '-c', 'sleep 30']);
    proc.on('close', () => resolve());
  });
  try {
    const refused = await runAttach(foreign);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /not a claudux session/i);
    assert.equal(await hasSession(foreign), true, 'the foreign session must be left alone');

    // The login session does not exist, so "no longer exists" is the answer
    // AFTER the name gate - which is exactly what this asserts.
    const login = await runAttach('login-a1b2c3d4');
    assert.match(login.out, /no longer exists/i);
  } finally {
    await killSession(foreign).catch(() => {});
  }
});

// The hook settings travel as a start option, so the secret has to travel
// with them - but it must never reach claude's own argv. Its slot is
// therefore always emitted, `-` standing for "this session has none": with a
// conditional slot the wrapper would shift away claude's first option
// instead, and swallowing --session-id leaves the session out of the sidebar
// entirely.
test('buildNewSessionArgs passes hook settings and always keeps the secret slot', () => {
  const withHook = buildNewSessionArgs({
    sessionId: '11111111-2222-3333-4444-555555555555',
    projectPath: '/srv/example', tokenFilePath: '/tmp/t.token', resume: false,
    hookSettingsPath: '/tmp/hooks.json', sessionSecret: 'sekret',
  });
  const afterToken = withHook.indexOf('/tmp/t.token') + 1;
  // The element right behind the token file path, and only there - the
  // wrapper reads it by position and moves it into the environment.
  assert.equal(withHook[afterToken], 'sekret');
  assert.equal(withHook.filter((a) => a === 'sekret').length, 1);
  const at = withHook.indexOf('--settings');
  assert.notEqual(at, -1);
  assert.equal(withHook[at + 1], '/tmp/hooks.json');
});

test('buildNewSessionArgs marks the empty secret slot instead of dropping it', () => {
  const plain = buildNewSessionArgs({
    sessionId: '11111111-2222-3333-4444-555555555555',
    projectPath: '/srv/example', tokenFilePath: '/tmp/t.token', resume: false,
  });
  const afterToken = plain.indexOf('/tmp/t.token') + 1;
  assert.equal(plain[afterToken], '-');
  assert.equal(plain.includes('--settings'), false);
  // No option of claude's ever lands in that slot - that is the whole point
  // of the sentinel.
  assert.deepEqual(plain.slice(-2), ['--session-id', '11111111-2222-3333-4444-555555555555']);

  const resumed = buildNewSessionArgs({
    sessionId: '11111111-2222-3333-4444-555555555555',
    projectPath: '/srv/example', tokenFilePath: '/tmp/t.token', resume: true,
  });
  assert.equal(resumed[resumed.indexOf('/tmp/t.token') + 1], '-');
  assert.deepEqual(resumed.slice(-2), ['--resume', '11111111-2222-3333-4444-555555555555']);
});

test('buildHookSettings names the loopback route and the escalate hook', () => {
  const settings = buildHookSettings(4055, '11111111-2222-3333-4444-555555555555');
  const hook = settings.hooks.PermissionRequest[0].hooks[0];
  assert.equal(hook.type, 'http');
  assert.match(hook.url, /^http:\/\/127\.0\.0\.1:4055\/api\/permission\/11111111-/);
  assert.deepEqual(hook.allowedEnvVars, ['CLAUDUX_SESSION_SECRET']);
  assert.equal(hook.headers['x-claudux-session-secret'], '$CLAUDUX_SESSION_SECRET');
});

// The secret arrives as an argv element and has to leave argv before claude
// runs - the same handoff as the token, and the reason the slot exists at
// all.
test('the session wrapper script moves the secret into the environment and keeps it out of claude argv', async () => {
  const fsp = await import('node:fs/promises');
  const os2 = await import('node:os');
  const path2 = await import('node:path');
  const url = await import('node:url');
  const { spawn: spawn2 } = await import('node:child_process');

  const scriptPath = url.fileURLToPath(new URL('../scripts/claude-session.sh', import.meta.url));
  const dir = await fsp.mkdtemp(path2.join(os2.tmpdir(), 'claudux-secret-'));
  // Fake `claude` in PATH: reports its own argv and what it inherited.
  await fsp.writeFile(path2.join(dir, 'claude'), '#!/bin/sh\necho "ARGV=[$*]"\necho "SECRET=[${CLAUDUX_SESSION_SECRET:-}]"\n', { mode: 0o755 });

  const run = async (extra) => {
    const tokenFile = path2.join(dir, `tok-${extra.join('-') || 'none'}`);
    await fsp.writeFile(tokenFile, 'unused', { mode: 0o600 });
    return new Promise((resolve) => {
      const proc = spawn2(scriptPath, [tokenFile, ...extra], {
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: os2.homedir() },
      });
      let out = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.on('close', () => resolve(out));
    });
  };

  const withSecret = await run(['sekret', '--session-id', 'abc']);
  assert.match(withSecret, /SECRET=\[sekret\]/);
  assert.match(withSecret, /ARGV=\[--session-id abc\]/);

  // The sentinel means "no secret" and must not reach the environment as a
  // literal `-` either.
  const withoutSecret = await run(['-', '--resume', 'abc']);
  assert.match(withoutSecret, /SECRET=\[\]/);
  assert.match(withoutSecret, /ARGV=\[--resume abc\]/);
});
