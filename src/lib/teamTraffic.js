// Which agents the main session has just sent something to. The other
// direction needs nothing from here: an agent messaging back does it with a
// SendMessage tool call in its own transcript, which the watcher already
// reports as its current tool.
//
// Verified against this host's own transcripts: a spawn is a `tool_use` named
// Agent carrying the agent's name in `input.name`, and a later message is one
// named SendMessage carrying the recipient in `input.to`.
//
// Its own offset over the session transcript rather than sharing the one in
// resolvedIds.js: the two collect different things from the same file, and
// one incremental read each is a few kilobytes per pass, while a shared
// scanner would be a module that knows about both.
import { readAppendedLines } from './jsonlReader.js';

// The lead has no window to send a pulse to.
const LEAD = 'team-lead';

export function createTrafficTracker() {
  const offsets = new Map();

  return {
    // The names messaged since the previous call for this transcript. A pulse
    // stands for one message, so each is reported once - reporting it again
    // every pass would leave an idle line flashing.
    messagedSince(transcriptPath) {
      const names = new Set();
      let text;
      try {
        const result = readAppendedLines(transcriptPath, offsets.get(transcriptPath) ?? 0);
        offsets.set(transcriptPath, result.offset);
        text = result.text;
      } catch {
        // No transcript yet, or read mid-write.
        return names;
      }
      for (const rawLine of text.split('\n')) {
        if (!rawLine.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(rawLine);
        } catch {
          continue;
        }
        const content = entry?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type !== 'tool_use') continue;
          const name = part.name === 'Agent' ? part.input?.name : (part.name === 'SendMessage' ? part.input?.to : null);
          if (typeof name === 'string' && name !== LEAD) names.add(name);
        }
      }
      return names;
    },
  };
}
