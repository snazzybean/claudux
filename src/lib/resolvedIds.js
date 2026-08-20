// Which `Task` tool_use ids a transcript has already resolved. Split out
// from subagentWatcher.js because answering that needs its own reading
// strategy - the id can sit anywhere in a file that only grows, so the
// answer is accumulated across passes rather than derived from one read.
import fs from 'node:fs';

// The reliable "it's done" signal wherever a toolUseId exists: the caller
// recording a tool_result for the Task call. Collected from every user-role
// line, not just the last one: several subagents can resolve in one tick.
export function resolvedToolUseIds(transcriptText) {
  const ids = new Set();
  for (const rawLine of String(transcriptText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (entry?.type !== 'user') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

// One megabyte per read: enough that a first scan of a multi-megabyte
// transcript takes a handful of passes, small enough that neither the peak
// nor the blocked event loop is noticeable.
const SCAN_CHUNK_BYTES = 1024 * 1024;

// Remembers, per transcript file, every tool_use_id that file has ever
// resolved - and how far into it that answer is already known.
//
// A tail read cannot answer the question: an agent's tool_result lands
// wherever the session happened to be when it returned, which on a long
// session is megabytes before the end (measured on this host: 46 of 46
// finished agents in one session were resolvable from the full transcript,
// 0 of 46 from its last 64 kB - so they all showed up as forever-running).
// Re-reading megabytes every two seconds is the other extreme, so each
// file is read once and after that only where it grew.
export function createResolvedTracker() {
  const perFile = new Map();

  function scan(entry, transcriptPath, size) {
    const fd = fs.openSync(transcriptPath, 'r');
    // Buffers rather than strings for the boundary arithmetic: a chunk
    // border falls inside a multi-byte character often enough, and
    // decoding the halves separately would corrupt exactly the line the
    // scan is after.
    let carry = Buffer.alloc(0);
    try {
      while (entry.offset < size) {
        const want = Math.min(SCAN_CHUNK_BYTES, size - entry.offset);
        const buffer = Buffer.alloc(want);
        const read = fs.readSync(fd, buffer, 0, want, entry.offset);
        if (read <= 0) break;
        entry.offset += read;
        const block = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
        const lastNewline = block.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          carry = Buffer.from(block);
          continue;
        }
        for (const id of resolvedToolUseIds(block.subarray(0, lastNewline).toString('utf8'))) entry.ids.add(id);
        carry = Buffer.from(block.subarray(lastNewline + 1));
      }
    } finally {
      fs.closeSync(fd);
    }
    // Claude Code appends while this reads, so the file regularly ends
    // mid-line. That line stays unread: winding the offset back to the
    // last complete one is what makes the next pass see it whole.
    entry.offset -= carry.length;
  }

  return {
    idsFor(transcriptPath) {
      let entry = perFile.get(transcriptPath);
      if (!entry) {
        entry = { offset: 0, ids: new Set() };
        perFile.set(transcriptPath, entry);
      }
      const size = fs.statSync(transcriptPath).size;
      // A transcript only ever grows, so a shorter file is a different
      // file under the same path - reading it from the old offset would
      // never find anything again.
      if (size < entry.offset) {
        entry.offset = 0;
        entry.ids.clear();
      }
      if (size > entry.offset) scan(entry, transcriptPath, size);
      return entry.ids;
    },
  };
}
