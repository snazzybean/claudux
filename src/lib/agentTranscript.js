// What one subagent has done, as blocks a window can show. Claude Code
// writes the agent its own transcript (see subagentWatcher.js's header for
// the layout); this reduces that to the two things worth showing - what the
// agent said, and which tool it reached for - and leaves out what it only
// thought.
import { readAppendedLines } from './jsonlReader.js';
import { renderMarkdown } from './fileRender.js';

// A single tool_result can be megabytes. The window shows the first lines
// as a hint of what came back, never the whole thing.
export const MAX_RESULT_CHARS = 600;
// A first read of a long-running agent returns its whole history; past this
// many blocks only the most recent are kept, since the window scrolls from
// the bottom anyway.
export const MAX_BLOCKS = 200;

// The argument worth showing per tool, in the order Claude Code's own tools
// name them. Same idea as toolLine() in public/js/subagents.js, which shows
// one argument next to the tool name.
const DETAIL_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'description'];

function detailOf(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of DETAIL_KEYS) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

// A tool_result's content is a string for most tools and an array of blocks
// for the ones that can return an image.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('\n');
}

export function agentBlocks(jsonlText) {
  const blocks = [];
  // A tool call and its result arrive on separate lines, so the call has to
  // stay findable once its result shows up.
  const byToolUseId = new Map();
  for (const rawLine of String(jsonlText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      // These files are read mid-write; a fragment is not an error.
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        blocks.push({ kind: 'text', html: renderMarkdown(part.text) });
      } else if (part?.type === 'tool_use' && typeof part.name === 'string') {
        const block = { kind: 'tool', name: part.name, detail: detailOf(part.input), result: null };
        if (typeof part.id === 'string') byToolUseId.set(part.id, block);
        blocks.push(block);
      } else if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        const block = byToolUseId.get(part.tool_use_id);
        // A result whose call was read in an earlier pass has nowhere to go
        // - the window already has that block on screen.
        if (block) block.result = resultText(part.content).slice(0, MAX_RESULT_CHARS);
      }
    }
  }
  return blocks.slice(-MAX_BLOCKS);
}

export function readAgentBlocks(filePath, after = 0) {
  const { text, offset } = readAppendedLines(filePath, after);
  return { blocks: agentBlocks(text), offset };
}
