// Runs the update. Everything up to the restart is covered by a rollback;
// the restart itself is not.
import fs from 'node:fs/promises';
import path from 'node:path';
import { run, restartUnit } from './selfUpdate.js';

const ROOT_DIR = path.join(import.meta.dirname, '../..');
const GIT_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const removeDir = (target) => fs.rm(target, { recursive: true, force: true });

// The old modules are renamed aside rather than reinstalled afterwards. If a
// registry timeout was what broke the install, a second npm ci as the
// rollback breaks the same way - and npm ci deletes node_modules first, so
// what is left is the old commit with half a directory. A rename needs no
// network, and it leaves the running process its esbuild binary.
export async function cleanupOldModules({ rootDir = ROOT_DIR, rmFn = removeDir } = {}) {
  await rmFn(path.join(rootDir, 'node_modules.old'));
}

export function createUpdateJob({
  rootDir = ROOT_DIR,
  runFn = run,
  renameFn = fs.rename,
  rmFn = removeDir,
  unitFn = () => restartUnit(),
  restartFn = (unit) => run('systemctl', ['restart', '--no-block', unit]),
} = {}) {
  const modules = path.join(rootDir, 'node_modules');
  const modulesOld = path.join(rootDir, 'node_modules.old');
  let state = { phase: 'idle', error: null, tag: null };
  let running = false;

  function status() {
    return { ...state };
  }

  async function execute(tag) {
    state = { phase: 'pulling', error: null, tag };
    await runFn('git', ['fetch', '--tags', '--prune', 'origin'], { cwd: rootDir, timeoutMs: GIT_TIMEOUT_MS });
    const { stdout } = await runFn('git', ['rev-parse', 'HEAD'], { cwd: rootDir, timeoutMs: GIT_TIMEOUT_MS });
    const previous = stdout.trim();

    // A leftover from an earlier update would make the rename fail with
    // ENOTEMPTY - and keep failing, until someone deletes it by hand.
    await rmFn(modulesOld);
    await renameFn(modules, modulesOld);
    try {
      await runFn('git', ['checkout', '--detach', `tags/${tag}`], { cwd: rootDir, timeoutMs: GIT_TIMEOUT_MS });
      state = { ...state, phase: 'installing' };
      await runFn('npm', ['ci', '--omit=dev'], { cwd: rootDir, timeoutMs: INSTALL_TIMEOUT_MS });
    } catch (err) {
      // The filesystem first, and independently of git: it needs no network
      // and no repository: if the checkout back failed before this, the
      // process would be left without its modules.
      await rmFn(modules);
      await renameFn(modulesOld, modules);
      try {
        await runFn('git', ['checkout', '--detach', previous], { cwd: rootDir, timeoutMs: GIT_TIMEOUT_MS });
      } catch (rollbackErr) {
        throw new Error(
          `${err.message} (rollback to ${previous} failed: ${rollbackErr.message})`,
          { cause: rollbackErr },
        );
      }
      throw err;
    }

    const unit = await unitFn();
    if (!unit) {
      state = { ...state, phase: 'restart-required' };
      return;
    }
    state = { ...state, phase: 'restarting' };
    await restartFn(unit);
  }

  async function start(tag) {
    if (running) {
      const busy = new Error('An update is already running');
      busy.code = 'BUSY';
      throw busy;
    }
    running = true;
    try {
      await execute(tag);
    } catch (err) {
      state = { phase: 'failed', error: err.message, tag };
    } finally {
      running = false;
    }
  }

  return { start, status, isRunning: () => running };
}
