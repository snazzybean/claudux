import fs from 'node:fs';
import path from 'node:path';

// Read only the tail chunk: the sidebar reads every .jsonl in the project
// folder, and a full readFileSync per file blocks the event loop. The title
// almost always comes from the most recently written `last-prompt` entry,
// which by definition sits at the end of the file.
const TAIL_READ_BYTES = 64 * 1024;

// Backwards, because Claude Code writes `ai-title` and `last-prompt` to the
// end of the file again on every turn – what's wanted is the most recently
// written one. Both in ONE pass, so a large file isn't scanned backwards
// twice.
function findLastEntries(lines) {
  let aiTitle = null;
  let lastPrompt = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (aiTitle && lastPrompt) break;
    try {
      const entry = JSON.parse(lines[i]);
      if (!aiTitle && entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
      if (!lastPrompt && entry.type === 'last-prompt' && entry.lastPrompt) lastPrompt = entry.lastPrompt;
    } catch {
      // Line not parseable – skip
    }
  }
  return { aiTitle, lastPrompt };
}

// Same wording as in sessionList.js: a session whose file so far only holds
// control markup is in the same state as a started session with no file yet.
const NO_PROMPT = '(no prompt yet)';

// Slash commands that only control the session and say nothing about the
// conversation. Deliberately a short list rather than "anything starting
// with /": `/goal` and similar ones ARE the session's content and belong on
// screen as the title.
const CONTROL_COMMANDS = new Set(['/clear', '/compact']);

// The caveat block precedes every locally executed command in the history.
// Non-greedy and back-referenced through the tag name, so only the block
// itself disappears instead of everything up to the message's last closing
// tag.
const LOCAL_COMMAND_BLOCK = /<local-command-([a-z-]+)>[\s\S]*?<\/local-command-\1>/g;

// A message with an image or file attachment arrives as a list of parts
// instead of a string, and those parts still carry the text.
function textFrom(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ');
}

// null means "this message doesn't work as a title" – the search then moves
// on to the next one.
function titleFrom(text) {
  // A slash command shows up as control markup in the history. Without this
  // handling, `<command-name>/goal</command-name>` plus its argument block
  // ended up as the title in the list.
  const command = text.match(/<command-name>(.*?)<\/command-name>/);
  if (command) {
    const name = command[1].trim();
    return CONTROL_COMMANDS.has(name) ? null : name;
  }
  return text.replace(LOCAL_COMMAND_BLOCK, '').trim() || null;
}

// Fallback when there's no last-prompt entry: the session's first user
// message. It sits at the START of the file, a tail chunk structurally
// cannot contain it – so this always needs the full file.
//
// Pure control entries are skipped rather than shown: after a `/clear` the
// new file starts with the caveat block and the command itself, and until
// the first ai-title there is nothing else in it.
function findFirstUserTitle(lines) {
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' || !entry.message?.content) continue;
      const title = titleFrom(textFrom(entry.message.content));
      if (title) return title;
    } catch {
      // ignore
    }
  }
  return null;
}

// `ai-title` first: Claude Code assigns it on the first prompt and leaves it
// in place. `last-prompt` moves on every turn and only serves as a fallback
// for sessions that haven't been given a title yet.
function describeContent(jsonlContent) {
  const lines = jsonlContent.trim().split('\n').filter(Boolean);
  const { aiTitle, lastPrompt } = findLastEntries(lines);
  return {
    title: aiTitle ?? lastPrompt ?? findFirstUserTitle(lines) ?? NO_PROMPT,
    lastPrompt,
  };
}

// openSync/readSync instead of readFileSync, so the whole file doesn't have
// to move into memory just to take the last chunk from it.
function readTailChunk(fullPath, fileSize) {
  const readSize = Math.min(TAIL_READ_BYTES, fileSize);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(fullPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, readSize, fileSize - readSize);
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

// The sidebar tick pulls every project every 15 seconds and reads every
// JSONL in it, while in practice a single file changes between two ticks -
// the running session. All the others are finished conversations whose
// title can no longer change, so their tail gets read and parsed again for
// nothing.
//
// Key is size AND mtime: Claude Code writes continuously, and two writes
// within the same millisecond move the size but not necessarily the clock.
// The path has to be the full one - two projects can hold a file of the
// same name.
//
// No eviction: an entry is two strings, and the map is bounded by the
// number of transcripts that have ever been listed. Deleted sessions leave
// theirs behind until the process restarts.
const describeCache = new Map();

function describeFile(fullPath, stat) {
  const cached = describeCache.get(fullPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.result;
  }
  const result = readDescription(fullPath, stat.size);
  describeCache.set(fullPath, { size: stat.size, mtimeMs: stat.mtimeMs, result });
  return result;
}

function readDescription(fullPath, fileSize) {
  if (fileSize <= TAIL_READ_BYTES) {
    return describeContent(fs.readFileSync(fullPath, 'utf8'));
  }

  const tailBuffer = readTailChunk(fullPath, fileSize);
  // The chunk boundary doesn't land on a line boundary – discard the
  // truncated first line, or JSON.parse fails on a fragment.
  const firstNewline = tailBuffer.indexOf(0x0a);
  const tailText = firstNewline === -1 ? '' : tailBuffer.subarray(firstNewline + 1).toString('utf8');
  const tailLines = tailText.trim().split('\n').filter(Boolean);

  const { aiTitle, lastPrompt } = findLastEntries(tailLines);
  // A missing ai-title does NOT trigger a full scan: both entries are
  // written in the same turn, so a last-prompt without an ai-title means
  // "this session doesn't have one", not "it sits further back".
  if (aiTitle || lastPrompt) return { title: aiTitle ?? lastPrompt, lastPrompt };

  // Neither one in the tail chunk: either a very long last line fills the
  // whole chunk, or the session has neither. The full scan covers both
  // cases, including the user-message fallback.
  return describeContent(fs.readFileSync(fullPath, 'utf8'));
}

export function encodeProjectPath(absPath) {
  return absPath.replace(/\//g, '-');
}

export function listSessions(claudeHome, projectPath) {
  const dir = path.join(claudeHome, 'projects', encodeProjectPath(projectPath));
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return {
        id: f.replace(/\.jsonl$/, ''),
        ...describeFile(full, stat),
        mtimeMs: stat.mtimeMs,
        // The sidebar's sort key. For a finished session, that's the time of
        // the FIRST prompt, not the process start – Claude Code only creates
        // the file at that point. Sorting by mtime instead would mean every
        // reply reorders the list. birthtimeMs isn't populated on every
        // filesystem.
        startMs: stat.birthtimeMs || stat.mtimeMs,
      };
    })
    .sort((a, b) => b.startMs - a.startMs);
}
