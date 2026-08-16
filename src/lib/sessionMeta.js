import fs from 'node:fs';
import path from 'node:path';

function metaPath(dataDir) {
  return path.join(dataDir, 'session-meta.json');
}

// One list request asks this module a handful of times per session, and the
// sidebar tick does that for every project - re-parsing the same file cost
// more than reading it.
//
// Two guards, because either one alone has a hole. The (mtime, size) key
// catches a write that went past this module - what the tests do when they
// lay down a fixture. setMeta drops the entry itself, because Claudux's own
// writes are exactly the ones that can land inside the same millisecond
// without changing the size: a carrier id swapped for another is the same
// length, and a stale entry there shows a running session as ended.
//
// The map is keyed by dataDir and holds one entry per data directory.
const readCache = new Map();

// Every return is prototype-less: the callers index this by session name,
// and against a plain object a name like `constructor` reads as a stored
// entry that was never written.
function readAll(dataDir) {
  const file = metaPath(dataDir);
  if (!fs.existsSync(file)) return Object.create(null);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return Object.create(null);
  }
  const cached = readCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.all;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return Object.create(null);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return Object.create(null);
  }
  const all = Object.assign(Object.create(null), parsed);
  readCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, all });
  return all;
}

export function getMeta(dataDir, sessionId) {
  return readAll(dataDir)[sessionId] || null;
}

// All Claude session IDs under which a tmux session may have carried its
// conversation: the session itself plus everything that points at it via
// `tmuxSession`.
//
// Such secondary entries arise from `/clear` - Claude Code then assigns a
// new session ID, the tmux session keeps its name (see the claude-switch
// in routes/sessions.js). Anyone looking for the context state finds the
// conversation from BEFORE the /clear under the old ID.
export function claudeSessionIdsForTmux(dataDir, tmuxSession) {
  const all = readAll(dataDir);
  const ids = new Set([tmuxSession]);
  for (const [id, meta] of Object.entries(all)) {
    if (meta?.tmuxSession === tmuxSession) ids.add(id);
  }
  return [...ids];
}

// The reverse of claudeSessionIdsForTmux: under which tmux name does this
// conversation run? The `live` dot depends on this - after a /clear, the
// Claude session is named differently than the tmux session carrying it.
//
// Transitive, because entries chain across multiple /clear calls: each
// points at the previous one, only the last carries the real tmux name.
// The `seen` set breaks off a cycle instead of following it forever.
export function tmuxSessionFor(dataDir, claudeSessionId) {
  const all = readAll(dataDir);
  let current = claudeSessionId;
  const seen = new Set([current]);
  for (;;) {
    const next = all[current]?.tmuxSession;
    // On a cycle, return the last ID reached, not the first: a cycle has
    // no correct answer, but jumping back to the starting point discards
    // the stretch that could actually be followed.
    if (!next || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

// Of the conversations this tmux session has already carried, which one is
// it carrying RIGHT NOW? After a /clear there are several, and only one of
// them is in the terminal - without this information the sidebar would
// mark the pre-/clear row as the open one.
//
// Read from the registry, not measured here: the source is
// recordClaudeSwitch below, same as for `tmuxSession`. If the value is
// missing, the session carries its own conversation - the normal case
// without /clear.
export function currentConversationFor(dataDir, tmuxSession) {
  return readAll(dataDir)[tmuxSession]?.currentSession || tmuxSession;
}

export function setMeta(dataDir, sessionId, meta) {
  fs.mkdirSync(dataDir, { recursive: true });
  // A copy rather than a write into the object readAll returned: that one
  // may be the cached instance, and every other reader holds the same
  // reference.
  const all = { ...readAll(dataDir), [sessionId]: meta };
  fs.writeFileSync(metaPath(dataDir), JSON.stringify(all, null, 2));
  readCache.delete(metaPath(dataDir));
}

// The pairing "this carrier now runs that conversation", as reported by a
// /clear. Returns whether anything was written - callers run this on every
// list request, and an unconditional write would rewrite the file each time.
//
// Both directions are stored: the new id points at its carrier (for the live
// dot and the context lookup), the carrier points at the conversation
// currently on screen (after several /clear calls, several ids point at the
// same carrier but only one of them is running).
export function recordClaudeSwitch(dataDir, tmuxSession, claudeSessionId) {
  if (claudeSessionId === tmuxSession) return false;
  // Without a meta entry it isn't a session Claudux started. The registry
  // sees every claude process on the host, so without this check
  // session-meta.json would fill up with foreign entries.
  const previous = getMeta(dataDir, tmuxSession);
  if (!previous) return false;
  if (previous.currentSession === claudeSessionId && getMeta(dataDir, claudeSessionId)) return false;
  setMeta(dataDir, claudeSessionId, {
    accountId: previous.accountId,
    projectId: previous.projectId,
    tmuxSession,
  });
  setMeta(dataDir, tmuxSession, { ...previous, currentSession: claudeSessionId });
  return true;
}
