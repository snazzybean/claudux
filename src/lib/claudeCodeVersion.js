// The installed Claude Code CLI version - read fresh each time, not cached.
// Works for any installation method: it only shells out to the CLI itself,
// never assumes where the binary lives on disk.
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
