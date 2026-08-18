// Whether the background job in claudeCodeUpdateRun.js is allowed to run
// automatically. Default is on - a feature explicitly asked for should not
// need a second opt-in, and a missing or corrupt file must not silently
// turn it off.
import fs from 'node:fs';
import path from 'node:path';

export function readAutoUpdateEnabled(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return true;
  }
  try {
    return JSON.parse(raw).autoUpdateEnabled !== false;
  } catch {
    return true;
  }
}

export function writeAutoUpdateEnabled(settingsPath, enabled) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify({ autoUpdateEnabled: enabled }, null, 2), { mode: 0o600 });
}
