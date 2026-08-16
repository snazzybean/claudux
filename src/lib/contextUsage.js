// How full is a session's context? Claude Code only ever hands this number
// to its own statusline command - it's not written to any file. But it can
// be calculated from the transcript: the assistant's last reply carries, in
// `usage`, how much context it read.
//
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
//
// `output_tokens` is NOT part of that - that's generated text, not context
// that was read.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WINDOW = 200000;
const LARGE_WINDOW = 1000000;

// The same character set as in sessionTokenFile.js: a session ID turns into
// a file name, and a value like "../../etc/passwd" must never be able to
// lead out of the projects directory.
const SLUG_RE = /^[a-zA-Z0-9-]{1,80}$/;

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

// Last assistant reply of the MAIN SESSION: tokens and model name.
//
// Both come from the same line, hence one function and one pass - the file
// can grow to several megabytes in normal use.
//
// The model name lives ONLY here. The `model` entry in settings.json is a
// default and diverges from the running session as soon as it was started
// with a different model or switched via /model.
//
// `isSidechain` marks lines from subagents - same file, but their own,
// usually much smaller, context.
export function contextFromTranscript(jsonlText) {
  let tokens = null;
  let model = null;
  for (const line of String(jsonlText ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Half a line: Claude Code writes continuously, so the file can be
      // read mid-write.
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    if (entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    tokens = number(usage.input_tokens)
      + number(usage.cache_read_input_tokens)
      + number(usage.cache_creation_input_tokens);
    model = typeof entry.message?.model === 'string' ? entry.message.model : null;
  }
  return { tokens, model };
}

// The JSONL only carries the model name without a window marker. The
// window size lives in the `model` entry of settings.json, there as
// "opus[1m]".
export function windowFromModelEntry(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') return null;
  return /\[1m\]/i.test(entry) ? LARGE_WINDOW : DEFAULT_WINDOW;
}

// Percentage only when the window is known. At 50k tokens with an unknown
// model it would be 25% or 5% - a made-up number is worse than none here,
// because the whole point of the display is to be trusted.
export function resolveContext({ tokens, modelEntry }) {
  let contextWindow = windowFromModelEntry(modelEntry);
  // Above 200k tokens it can no longer be a 200K window - then the size is
  // settled, entirely without an entry.
  if (Number.isFinite(tokens) && tokens > DEFAULT_WINDOW) contextWindow = LARGE_WINDOW;

  return {
    tokens: Number.isFinite(tokens) ? tokens : null,
    percent: Number.isFinite(tokens) && contextWindow ? (tokens / contextWindow) * 100 : null,
    contextWindow,
  };
}

// The number wanted here sits in the LAST matching line, so the end of the
// file is enough - and these run to several megabytes, which readFileSync
// would move into memory in full, blocking the event loop for every other
// request. Same approach as sessionStore.readTailChunk, which reads titles
// this way.
//
// chunkBytes is a parameter so a test can force the boundary case without
// writing a 64 kB fixture.
const TAIL_READ_BYTES = 64 * 1024;

export function readTranscriptTail(filePath, chunkBytes = TAIL_READ_BYTES) {
  const fileSize = fs.statSync(filePath).size;
  if (fileSize <= chunkBytes) return fs.readFileSync(filePath, 'utf8');

  const buffer = Buffer.alloc(chunkBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, chunkBytes, fileSize - chunkBytes);
  } finally {
    fs.closeSync(fd);
  }
  // The chunk boundary almost never lands on a line boundary - drop the
  // truncated first line, or the caller's JSON.parse trips over a fragment.
  const firstNewline = buffer.indexOf(0x0a);
  return firstNewline === -1 ? '' : buffer.subarray(firstNewline + 1).toString('utf8');
}

// Claude Code stores transcripts under ~/.claude/projects/<encoded-path>/.
// Claudux knows the project path, but the encoding is undocumented (and not
// obvious with special characters) - so the file gets searched for instead
// of its path rebuilt. The directory listing is small (on the order of the
// number of projects).
export function findTranscriptPath(claudeDir, sessionId) {
  if (typeof sessionId !== 'string' || !SLUG_RE.test(sessionId)) return null;
  const projectsDir = path.join(claudeDir, 'projects');
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // No projects directory: fresh install, nothing to find.
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Color tier for the context - the same thresholds as in the terminal's
// statusline script, so both don't show different colors for the same
// state. Unlike with the quotas, there's no projection here: a context
// doesn't fill up by the clock.
export function contextLevel(percent) {
  if (!Number.isFinite(percent)) return 'dim';
  if (percent < 50) return 'ok';
  if (percent < 75) return 'warn';
  return 'crit';
}

export function modelFromSettings(claudeDir) {
  try {
    const raw = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8');
    const entry = JSON.parse(raw)?.model;
    return typeof entry === 'string' ? entry : null;
  } catch {
    // No settings.json, broken JSON, no model entry: then the window size
    // stays unresolved and resolveContext shows only tokens.
    return null;
  }
}

// Picks the most recently written JSONL out of several possible session
// IDs.
//
// Needed because of `/clear`: Claude Code then assigns a new session ID and
// writes to a new file, while the tmux session keeps its name (details in
// src/lib/sessionRegistry.js). Both files sit side by side afterwards;
// the older one shows the context state of the conversation from BEFORE the
// /clear.
//
// Decided by mtime, not by the order of the candidates: which entry in
// session-meta.json is the newer one depends on the write order of a JSON
// file - the file itself knows better.
export function chooseTranscript(claudeDir, sessionIds) {
  let best = null;
  let bestTime = -Infinity;
  for (const id of sessionIds ?? []) {
    const filePath = findTranscriptPath(claudeDir, id);
    if (!filePath) continue;
    let time;
    try {
      time = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (time > bestTime) {
      bestTime = time;
      best = filePath;
    }
  }
  return best;
}

// Convenient all-in-one path for the route: find the file, read it,
// calculate. `sessionIds` are all the IDs under which the same tmux session
// may have run its conversation (see chooseTranscript).
export function contextForSession(claudeDir, sessionIds, modelEntry) {
  const empty = { tokens: null, percent: null, contextWindow: windowFromModelEntry(modelEntry), model: null };
  const filePath = chooseTranscript(claudeDir, Array.isArray(sessionIds) ? sessionIds : [sessionIds]);
  if (!filePath) return empty;
  let tokens, model;
  try {
    ({ tokens, model } = contextFromTranscript(readTranscriptTail(filePath)));
    // Nothing in the tail: a long subagent run can fill it entirely with
    // sidechain lines, which contextFromTranscript skips - the main
    // session's last entry then lies before the chunk. `tokens` decides,
    // not `model`: a found entry may legitimately name no model, and
    // testing that would re-read the whole file for no reason.
    if (tokens === null) {
      ({ tokens, model } = contextFromTranscript(fs.readFileSync(filePath, 'utf8')));
    }
  } catch {
    return empty;
  }
  // resolveContext does the math, the model name is only passed along: it
  // says nothing about the window size (the JSONL doesn't know the 1M
  // marker).
  return { ...resolveContext({ tokens, modelEntry }), model };
}
