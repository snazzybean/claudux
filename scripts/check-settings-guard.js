// Prevents a global ~/.claude/settings.json from redirecting the auth path
// - via an `env` block or via `apiKeyHelper`. Either of these would
// overwrite or bypass the per-session token, and all accounts would
// effectively run through the same global key. That silently breaks the
// multi-account mechanism, so startup aborts instead.
import fs from 'node:fs';
import os from 'node:os';

const FORBIDDEN_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

// apiKeyHelper is NOT an env override, but its own top-level key: the
// script stored there delivers the token to use via stdout and can
// redirect auth just as silently. But it doesn't end up in the env block,
// hence its own check instead of extending the loop below.
const FORBIDDEN_TOP_LEVEL_KEYS = ['apiKeyHelper'];

export function checkNoGlobalAuthOverride(settingsJsonContent) {
  let settings;
  try {
    settings = JSON.parse(settingsJsonContent);
  } catch (err) {
    // Fail-closed: a broken settings.json cannot be safely interpreted as
    // "has no env block". The catch also gives guardOrExit the same
    // { ok, reason } shape as every other error case.
    return { ok: false, reason: `settings.json is not valid JSON: ${err.message}` };
  }
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(settings, key)) {
      return {
        ok: false,
        reason: `settings.json sets ${key} globally - can redirect the auth path around CLAUDE_CODE_OAUTH_TOKEN.`,
      };
    }
  }
  const envBlock = settings.env || {};
  for (const key of FORBIDDEN_ENV_KEYS) {
    // Object.hasOwn instead of truthiness: the key is set even when its
    // value is an empty string - an `envBlock[key]` check would let
    // exactly that override through.
    if (Object.hasOwn(envBlock, key)) {
      return {
        ok: false,
        reason: `settings.json sets ${key} globally - overrides CLAUDE_CODE_OAUTH_TOKEN for ALL sessions.`,
      };
    }
  }
  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Same source as the server (src/config.js), so the check reads the file
  // the server will actually read.
  const claudeHome = process.env.CLAUDE_HOME || `${os.homedir()}/.claude`;
  const settingsPath = `${claudeHome}/settings.json`;
  if (fs.existsSync(settingsPath)) {
    const result = checkNoGlobalAuthOverride(fs.readFileSync(settingsPath, 'utf8'));
    if (!result.ok) {
      console.error(`❌ ${result.reason}`);
      process.exit(1);
    }
  }
  console.log('✅ No global auth override in settings.json.');
}
