// May this instance update itself, and as what was it installed?
//
// The two preconditions in the checkout - clean tree, HEAD exactly on a tag -
// lock a development checkout out without needing a rule of its own: it sits
// on a branch with its own commits and fails the second one.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT_DIR = path.join(import.meta.dirname, '../..');

// git must never ask. origin can be an SSH url, the service may run without a
// usable HOME, and a fetch waiting for a host key blocks silently - the job
// would sit in "pulling" until the next restart.
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
};

export function run(cmd, args, { cwd = ROOT_DIR, timeoutMs = 60_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

export function detectMode({ rootDir = ROOT_DIR, existsFn = fs.existsSync } = {}) {
  if (existsFn('/.dockerenv')) return 'docker';
  if (rootDir.includes('/_npx/')) return 'npx';
  if (existsFn(path.join(rootDir, '.git'))) return 'checkout';
  return 'unknown';
}

export async function readCheckoutState({ rootDir = ROOT_DIR, runFn = run } = {}) {
  const { stdout: porcelain } = await runFn('git', ['status', '--porcelain'], { cwd: rootDir });
  let tag = null;
  try {
    const { stdout } = await runFn('git', ['describe', '--exact-match', '--tags', 'HEAD'], { cwd: rootDir });
    tag = stdout.trim() || null;
  } catch {
    // Exits non-zero when HEAD is not a tag - that is an answer, not a fault.
  }
  return { clean: porcelain.trim() === '', tag };
}

const BLOCKED = {
  docker: 'Pull the new image (docker pull) and restart the container.',
  npx: 'The next npx invocation brings it along.',
  unknown: 'Cannot tell how this instance was installed.',
};

export async function updateReadiness({ rootDir = ROOT_DIR, runFn = run, existsFn = fs.existsSync } = {}) {
  const mode = detectMode({ rootDir, existsFn });
  if (mode !== 'checkout') return { mode, canUpdate: false, reason: BLOCKED[mode] };

  let state;
  try {
    state = await readCheckoutState({ rootDir, runFn });
  } catch (err) {
    return { mode, canUpdate: false, reason: `Cannot read the checkout: ${err.message}` };
  }
  if (!state.clean) return { mode, canUpdate: false, reason: 'The checkout has uncommitted changes.' };
  if (!state.tag) return { mode, canUpdate: false, reason: 'HEAD is not on a release tag.' };
  return { mode, canUpdate: true, reason: null };
}

export function systemdUnit({
  readFileFn = () => fs.readFileSync('/proc/self/cgroup', 'utf8'),
} = {}) {
  try {
    return /\/([\w.-]+\.service)\b/.exec(readFileFn())?.[1] ?? null;
  } catch {
    return null;
  }
}

// The unit this process may restart - null when there is none it owns.
//
// The cgroup alone is not enough to decide that: it answers the same for
// every process inside the unit, including a second claudux started from
// another checkout inside one of this one's own sessions. Acting on that
// answer restarts the production instance rather than the one being updated,
// which is what happened during the first acceptance run. So systemd has to
// confirm that this process is the unit's main process.
export async function restartUnit({
  readFileFn = () => fs.readFileSync('/proc/self/cgroup', 'utf8'),
  pid = process.pid,
  runFn = run,
} = {}) {
  const unit = systemdUnit({ readFileFn });
  if (!unit) return null;
  try {
    const { stdout } = await runFn('systemctl', ['show', unit, '-p', 'MainPID', '--value'], { timeoutMs: 10_000 });
    return Number(stdout.trim()) === pid ? unit : null;
  } catch {
    return null;
  }
}
