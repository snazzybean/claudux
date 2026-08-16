// Claude Code keeps one file per running process under
// <claudeHome>/sessions/<pid>.json, carrying both the CURRENT conversation
// id and the tmux session running it. After a /clear the pid stays and
// sessionId is replaced - that pairing is what Claudux needs.
//
// The format is internal and undocumented, so every read is a guarded one:
// anything unparseable is skipped, and a missing directory yields an empty
// map - Claudux then runs without the extra information.
import fs from 'node:fs';
import path from 'node:path';
import { isValidSlug } from './tmuxManager.js';
import { recordClaudeSwitch } from './sessionMeta.js';

export function parseEntry(rawJson) {
  let raw;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  // Interactive sessions only. The CLI's own validator knows three further
  // kinds (bg, daemon, daemon-worker) for processes nobody is sitting in
  // front of. Any of them that inherits its parent's tmux environment would
  // report the SAME carrier, and since the map is keyed by carrier it would
  // overwrite the session a person is looking at - storing its conversation
  // as the one on screen. A missing field is not a rejection: an unknown CLI
  // keeps the behaviour instead of emptying the map.
  if (raw.kind !== undefined && raw.kind !== 'interactive') return null;
  if (typeof raw.tmux !== 'string') return null;
  // Format is "<session>:@<window>.<pane>". Cut at the last ":@": a session
  // name can't contain a colon, but splitting at the first one would break
  // if that ever changes.
  const marker = raw.tmux.lastIndexOf(':@');
  if (marker === -1) return null;
  const tmuxSession = raw.tmux.slice(0, marker);
  // Both ids end up in getMeta and potentially in tmux arguments, so they go
  // through the same guard as everywhere else - it also blocks "__proto__".
  if (!isValidSlug(tmuxSession) || !isValidSlug(raw.sessionId)) return null;
  if (typeof raw.pid !== 'number') return null;
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    tmuxSession,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    statusUpdatedAt: typeof raw.statusUpdatedAt === 'number' ? raw.statusUpdatedAt : 0,
  };
}

export function readRegistry(claudeHome) {
  const dir = path.join(claudeHome, 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No directory means "no registry" - not an error. A CLI without it
    // leaves Claudux in its pre-hook behaviour instead of breaking.
    return new Map();
  }
  const map = new Map();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let entry;
    try {
      entry = parseEntry(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // vanished between readdir and read
    }
    if (entry) map.set(entry.tmuxSession, entry);
  }
  return map;
}

// Brings session-meta.json in line with what is actually running. Replaces
// the SessionStart hook's report; a carrier missing from `runningNames` is a
// leftover file, which also covers pid reuse without reading procStart.
export function reconcile(dataDir, registry, runningNames) {
  const running = runningNames instanceof Set ? runningNames : new Set(runningNames);
  const written = [];
  for (const [tmuxSession, entry] of registry) {
    if (!running.has(tmuxSession)) continue;
    if (recordClaudeSwitch(dataDir, tmuxSession, entry.sessionId)) written.push(tmuxSession);
  }
  return written;
}
