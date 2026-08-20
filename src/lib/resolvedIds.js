// Which `Task` tool_use ids a transcript has already resolved. Split out
// from subagentWatcher.js because answering that needs its own reading
// strategy - the id can sit anywhere in a file that only grows, so the
// answer is accumulated across passes rather than derived from one read.
import fs from 'node:fs';
import { readAppendedLines } from './jsonlReader.js';

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

export function createResolvedTracker() {
  const perFile = new Map();

  return {
    idsFor(transcriptPath) {
      let entry = perFile.get(transcriptPath);
      if (!entry) {
        entry = { offset: 0, ids: new Set() };
        perFile.set(transcriptPath, entry);
      }
      // The reader restarts on a shorter file by itself; what it cannot
      // know is that the ids collected from the previous file no longer
      // apply, so that part stays here.
      if (fs.statSync(transcriptPath).size < entry.offset) {
        entry.offset = 0;
        entry.ids.clear();
      }
      const { text, offset } = readAppendedLines(transcriptPath, entry.offset);
      entry.offset = offset;
      for (const id of resolvedToolUseIds(text)) entry.ids.add(id);
      return entry.ids;
    },
  };
}
