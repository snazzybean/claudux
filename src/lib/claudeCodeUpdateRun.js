// Keeps the Claude Code CLI current: runs `claude update` on a timer,
// works for npm-global and native installs alike since the CLI itself
// knows which one it is. Unlike Claudux' own self-update, nothing here
// ever restarts anything - a running `claude` process keeps its old binary
// until it next starts on its own, which is fine (see the design doc).
import os from 'node:os';
import { run } from './selfUpdate.js';
import { readClaudeCodeVersion } from './claudeCodeVersion.js';
import { readAutoUpdateEnabled } from './claudeCodeUpdateSettings.js';
import { notifyAllReportingGone } from './notifier.js';
import { listTargets, removeTargets } from './notificationTargets.js';

const UPDATE_TIMEOUT_MS = 10 * 60_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export function releaseUrl(version) {
  return `https://github.com/anthropics/claude-code/releases/tag/v${version}`;
}

export function createClaudeCodeUpdateJob({
  runFn = run,
  versionFn = readClaudeCodeVersion,
  timeoutMs = UPDATE_TIMEOUT_MS,
  notifyFn = null,
} = {}) {
  let state = { phase: 'idle', updated: null, from: null, to: null, error: null, ranAt: null };
  let running = false;

  function status() {
    return { ...state };
  }

  async function execute() {
    state = { ...state, phase: 'running' };

    let before;
    try {
      before = await versionFn({ runFn });
    } catch (err) {
      state = { phase: 'failed', updated: null, from: null, to: null, error: err.message, ranAt: Date.now() };
      return;
    }

    try {
      await runFn('claude', ['update'], { cwd: os.homedir(), timeoutMs });
    } catch (err) {
      state = { phase: 'failed', updated: null, from: before, to: null, error: err.message, ranAt: Date.now() };
      return;
    }

    let after;
    try {
      after = await versionFn({ runFn });
    } catch (err) {
      state = { phase: 'failed', updated: null, from: before, to: null, error: err.message, ranAt: Date.now() };
      return;
    }
    if (after === null) {
      state = {
        phase: 'failed', updated: null, from: before, to: null,
        error: 'claude --version did not answer after the update', ranAt: Date.now(),
      };
      return;
    }

    const updated = after !== before;
    state = { phase: 'done', updated, from: before, to: after, error: null, ranAt: Date.now() };
    if (updated && notifyFn) await notifyFn({ from: before, to: after });
  }

  async function start() {
    if (running) {
      const busy = new Error('A check is already running');
      busy.code = 'BUSY';
      throw busy;
    }
    running = true;
    try {
      await execute();
    } finally {
      running = false;
    }
  }

  return { start, status, isRunning: () => running };
}

// Matches statusWatcher.js's own notifyFn: resolved at send time so a
// target added or removed in the meantime takes effect immediately, and
// pruned right where it is sent.
export function createDefaultNotifyFn(config) {
  return async ({ to }) => {
    const targetsPath = config.notificationTargetsPath;
    const message = {
      title: 'Claudux',
      body: `Claude Code updated to ${to}`,
      clickUrl: releaseUrl(to),
    };
    removeTargets(targetsPath, await notifyAllReportingGone(config, listTargets(targetsPath), message));
  };
}

export function startClaudeCodeUpdateInterval(config, {
  intervalMs = INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  job = createClaudeCodeUpdateJob({ notifyFn: createDefaultNotifyFn(config) }),
  enabledFn = () => readAutoUpdateEnabled(config.claudeUpdateSettingsPath),
} = {}) {
  const timer = setIntervalFn(() => {
    if (!enabledFn()) return;
    job.start().catch((err) => {
      if (err.code !== 'BUSY') console.error('claudeCodeUpdate: pass failed:', err.message);
    });
  }, intervalMs);
  return { stop: () => clearIntervalFn(timer), job };
}
