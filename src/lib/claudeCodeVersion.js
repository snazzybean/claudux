// How Claude Code is installed and which version is current - read fresh
// each time, not cached. Works for any installation method: it only shells
// out to the CLI itself, never assumes where the binary lives on disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from './selfUpdate.js';

const VERSION_TIMEOUT_MS = 15_000;

export function parseVersion(output) {
  const match = /^(\d+\.\d+\.\d+)/.exec(String(output ?? '').trim());
  return match ? match[1] : null;
}

export async function readClaudeCodeVersion({ runFn = run } = {}) {
  try {
    const { stdout } = await runFn('claude', ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
    return parseVersion(stdout);
  } catch {
    return null;
  }
}

// `~/.claude.json` is written by the CLI itself, next to the ~/.claude
// directory - purely informational, never gates anything.
export function readInstallMethod({ claudeJsonPath = path.join(os.homedir(), '.claude.json') } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    return typeof parsed.installMethod === 'string' ? parsed.installMethod : null;
  } catch {
    return null;
  }
}
