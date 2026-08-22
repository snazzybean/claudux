// Which bytes of a transcript to read. The module next door turns lines
// into a document; this one decides which lines, and what identity the file
// they came from has. A transcript is appended to while it is read, so a
// byte offset is the only mark a client can hold on to: `tail` for the first
// look, `after` for what has come since, `before` for paging upwards.
import fs from 'node:fs';
import path from 'node:path';
import { readAppendedLines, readWindow } from './jsonlReader.js';
import { conversationView } from './sessionTranscript.js';
import { subagentIndex, agentIdFor, spawnCallCounter } from './subagentIndex.js';
import { subagentsDirFor } from './subagentWatcher.js';

// Half a megabyte: a first screen with room to spare, and a big transcript
// in steps a reader can follow. Its ceiling is MAX_EVENTS next door - these
// windows are disjoint byte ranges, so an event that cap cuts from one is in
// no other window either. Above roughly 800 KB that starts happening, and
// nothing on the wire would say so.
export const TAIL_BYTES = 512 * 1024;

// The file name IS the Claude session id, and a /clear starts a new file.
// The client compares it: a changed id means "different conversation",
// which is not something an offset can express.
export function transcriptIdOf(filePath) {
  return path.basename(filePath, '.jsonl');
}

// The session's mode rather than the document's, which is why it lives out
// here: only the read layer knows whether it saw the end of the file, and
// nowhere else does the value mean anything. The substring is the matcher,
// not a fast path in front of one - and it can match nothing but real
// structure, because a `"` inside a JSON string is always escaped.
export function permissionModeOf(jsonlText) {
  let mode = null;
  for (const rawLine of String(jsonlText ?? '').split('\n')) {
    if (!rawLine.includes('"type":"permission-mode"')) continue;
    try {
      const entry = JSON.parse(rawLine);
      if (entry?.type === 'permission-mode' && typeof entry.permissionMode === 'string') {
        mode = entry.permissionMode;
      }
    } catch {
      // Read mid-write: a fragment is not an error.
    }
  }
  return mode;
}

// A window of whole lines ending at `to`, and the offset to continue from.
// Two cuts have to be undone: `readWindow` drops the partial line its start
// caught, and the file itself regularly ends mid-line while Claude Code
// appends - leaving that fragment unread is what makes the next `after` call
// see the line whole instead of starting inside it. A window can land inside
// one line and come back with nothing usable either way, which is what the
// widening is for: unbounded, since such a line can be megabytes and a
// window with no text would show an empty conversation.
function windowUpTo(filePath, to, windowBytes) {
  let width = Math.max(1, windowBytes);
  for (;;) {
    const start = Math.max(0, to - width);
    const window = readWindow(filePath, start, to);
    const lastNewline = window.text.lastIndexOf('\n');
    const text = lastNewline === -1 ? '' : window.text.slice(0, lastNewline + 1);
    if (text !== '' || start === 0) {
      // Capped at the window's end because the byte count is taken from a
      // decoded string, where an invalid byte would have grown into a
      // replacement character.
      const offset = Math.min(to, window.from + Buffer.byteLength(text));
      return { text, from: window.from, offset };
    }
    width *= 2;
  }
}

// Where a line begins: byte 0, or a newline right in front of it.
function startsLine(filePath, at, size) {
  if (at === 0) return true;
  if (at > size) return false;
  const fd = fs.openSync(filePath, 'r');
  const byte = Buffer.alloc(1);
  try {
    return fs.readSync(fd, byte, 0, 1, at - 1) === 1 && byte[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

// What the file grew by since `after`. A cursor off a line boundary is not a
// cursor into this file - a transcript rewritten in place is a different
// conversation at the same path - so the read starts over rather than
// carrying on inside a line and skipping it. Which is why `from` is derived:
// it is not always the `after` that was asked for.
function windowAfter(filePath, after, size) {
  const appended = readAppendedLines(filePath, startsLine(filePath, after, size) ? after : 0);
  return {
    text: appended.text,
    from: Math.max(0, appended.offset - Buffer.byteLength(appended.text)),
    offset: appended.offset,
  };
}

// Which of the three, in the route's own precedence: they have no combined
// meaning, and no window asked for is the first look. The bounds are clamped
// rather than trusted - the route rejects a negative one, a second caller
// might not.
function selectWindow(filePath, size, { wantTail, wantBefore, after, before, windowBytes }) {
  if (wantTail) return windowUpTo(filePath, size, windowBytes);
  if (wantBefore) return windowUpTo(filePath, Math.min(Math.max(0, before), size), windowBytes);
  return windowAfter(filePath, Math.max(0, after), size);
}

// Which agent transcript each subagent card may open, resolved here because
// this is the only layer holding both the events and the path they came
// from - the module next door is handed text alone, and a route is HTTP
// only. `null` where the disk does not say, which is a card that stays shut.
// The directory is only read when a window actually carries a card, so a
// poll usually pays nothing.
function nameAgents(filePath, events) {
  const cards = events.filter((event) => event.kind === 'task');
  if (cards.length === 0) return;
  const index = subagentIndex(subagentsDirFor(filePath));
  // Deferred: the whole transcript is scanned only if a card gets as far as
  // needing the count, and then once for all of them.
  const callCounts = spawnCallCounter(filePath);
  for (const card of cards) {
    // Two shapes of "cannot open", and the card has to tell them apart:
    // nothing on disk carries this name, or something does and it cannot be
    // said which.
    const { agentId, ambiguous } = agentIdFor(index, callCounts, card);
    card.agentId = agentId;
    card.agentAmbiguous = ambiguous;
  }
}

export function readConversation(filePath, {
  tail = false, after = null, before = null, anchor = null, windowBytes = TAIL_BYTES,
} = {}) {
  const size = fs.statSync(filePath).size;
  const wantTail = tail || (after === null && before === null);
  // One predicate for both decisions below - which window is read, and
  // whether it may filter. Two would let a `before` beside an `after` hand
  // the older window's filter to a poll window.
  const wantBefore = !wantTail && after === null;
  const { text, from, offset } = selectWindow(filePath, size, { wantTail, wantBefore, after, before, windowBytes });

  // Only a tail read may walk the tree on its own: it starts at the last
  // uuid-bearing line of the FILE, so it can never prove a retraction a
  // whole-file read would not. Every other window walks from the anchor the
  // one below it handed back and filters nothing without one - its own last
  // line is the wrong place to start, for an append as much as for a window
  // paged past the root, and what it drops there sits in bytes the client
  // never asks for again.
  const walkFrom = wantBefore ? anchor : null;
  const view = wantTail
    ? conversationView(text)
    : conversationView(text, { anchor: walkFrom, filtered: walkFrom !== null });
  nameAgents(filePath, view.events);

  return {
    events: view.events,
    abandoned: view.abandoned,
    segmentStarts: view.segmentStarts,
    segmentStart: view.segmentStart,
    // From the walk, never from the events: the oldest chain member is
    // regularly a `system` or `attachment` line that produces none. A window
    // that began at byte 0 has nothing older to anchor to, whatever parent
    // its first line names.
    chainAnchor: from === 0 ? null : view.chainAnchor,
    anchored: view.anchored,
    from,
    offset,
    atStart: from === 0,
    transcriptId: transcriptIdOf(filePath),
    // Only a first look at the end of the file can be trusted with these: a
    // window above it sees a dequeue whose enqueue is out of sight and names
    // no mode at all. Left out rather than nulled - absent says "unknown",
    // where a null would read as "empty queue, no mode".
    ...(wantTail ? { queue: view.queue, permissionMode: permissionModeOf(text) } : {}),
  };
}
