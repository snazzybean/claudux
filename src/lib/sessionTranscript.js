// The session's own conversation, as events a document view can render.
// Sibling of agentTranscript.js rather than an extension of it: that one
// condenses for a 200px window (no thinking, results cut at 600 chars),
// which are the wrong calls for a page you read.
import { renderMarkdown } from './fileRender.js';

// A tool result can be megabytes. Four times what a subagent window shows,
// because here it is the content, not a hint.
export const MAX_RESULT_CHARS = 4000;
// The view scrolls from the bottom and pages upwards on demand.
export const MAX_EVENTS = 200;
// A structuredPatch is returned uncut by the CLI - a single Write hunk can
// run to thousands of lines, and the parsed object skips the character cap
// above entirely. Capped the same way, just on hunks and lines instead of
// characters, so one event can't turn into hundreds of kilobytes on the
// most expensive place in the whole view: a phone.
export const MAX_PATCH_HUNKS = 20;
export const MAX_PATCH_LINES_PER_HUNK = 200;
// A one-line summary next to the tool name - a heredoc-style Bash command
// would otherwise become one giant line and break the row instead of
// summarizing it.
export const MAX_DETAIL_CHARS = 300;

// Line types that are control markup rather than conversation. `system`
// lines are deliberately not here: they carry uuid/parentUuid for the
// parent index but produce no event, which the fallthrough below already
// does on its own.
const SKIP_TYPES = new Set([
  'last-prompt', 'ai-title', 'atis-latch', 'mode', 'permission-mode',
  'file-history-snapshot', 'file-history-delta', 'queue-operation',
  'attachment', 'summary',
]);

// The argument worth showing per tool, in the order Claude Code's own tools
// name them. Same idea as agentTranscript.js.
const DETAIL_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'description'];

// A plain slice() can cut a surrogate pair in half at the boundary, leaving
// a lone high surrogate at the end of the string. Back off by one code unit
// when that happens instead.
function capText(text, max) {
  if (text.length <= max) return text;
  let end = max;
  const before = text.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function detailOf(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of DETAIL_KEYS) {
    if (typeof input[key] === 'string') return capText(input[key], MAX_DETAIL_CHARS);
  }
  return '';
}

// A tool_result's content is a string for most tools and an array of blocks
// for the ones that can return an image.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n');
}

function capResult(content) {
  return capText(resultText(content), MAX_RESULT_CHARS);
}

function base(entry) {
  return {
    uuid: typeof entry.uuid === 'string' ? entry.uuid : null,
    parentUuid: typeof entry.parentUuid === 'string' ? entry.parentUuid : null,
    entrypoint: typeof entry.entrypoint === 'string' ? entry.entrypoint : null,
  };
}

// Caps hunks-per-patch and lines-per-hunk, and says so in the data rather
// than pretending a cut patch is complete.
function capPatch(patch) {
  let truncated = patch.length > MAX_PATCH_HUNKS;
  const hunks = (truncated ? patch.slice(0, MAX_PATCH_HUNKS) : patch).map((hunk) => {
    if (!Array.isArray(hunk?.lines) || hunk.lines.length <= MAX_PATCH_LINES_PER_HUNK) return hunk;
    truncated = true;
    return { ...hunk, lines: hunk.lines.slice(0, MAX_PATCH_LINES_PER_HUNK) };
  });
  return { patch: hunks, patchTruncated: truncated };
}

// One content part, in isolation - shared by the plain per-line loop and
// the structuredPatch branch, so a stray part on a diff line gets the same
// treatment instead of being dropped along with the tool_result it rides
// with.
function pushPart(events, byToolUseId, entry, part) {
  if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
    events.push({
      kind: entry.type === 'assistant' ? 'assistant' : 'user',
      ...base(entry),
      html: renderMarkdown(part.text),
    });
  } else if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
    events.push({ kind: 'thinking', ...base(entry), html: renderMarkdown(part.thinking) });
  } else if (part?.type === 'image') {
    events.push({ kind: 'image', ...base(entry) });
  } else if (part?.type === 'tool_use' && typeof part.name === 'string') {
    const toolUseId = typeof part.id === 'string' ? part.id : null;
    if (part.name === 'Task') {
      events.push({
        kind: 'task', ...base(entry), toolUseId,
        agentType: typeof part.input?.subagent_type === 'string' ? part.input.subagent_type : '',
        description: typeof part.input?.description === 'string' ? part.input.description : '',
      });
    } else if (part.name === 'TodoWrite') {
      events.push({
        kind: 'todos', ...base(entry),
        todos: Array.isArray(part.input?.todos) ? part.input.todos : [],
      });
    } else {
      const event = {
        kind: 'tool', ...base(entry), name: part.name,
        detail: detailOf(part.input), toolUseId, result: null, resultLoaded: false,
      };
      if (toolUseId) byToolUseId.set(toolUseId, event);
      events.push(event);
    }
  } else if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
    const call = byToolUseId.get(part.tool_use_id);
    const text = capResult(part.content);
    if (call) {
      call.result = text;
      call.resultLoaded = true;
    } else {
      // Its call sits before this window. Dropping it would lose
      // output; showing it alone is honest.
      events.push({ kind: 'toolResult', ...base(entry), toolUseId: part.tool_use_id, result: text });
    }
  }
}

export function conversationEvents(jsonlText) {
  const events = [];
  // A call and its result arrive on separate lines, so the call has to stay
  // findable once its result shows up.
  const byToolUseId = new Map();

  for (const rawLine of String(jsonlText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      // Read mid-write: a fragment is not an error.
      continue;
    }
    if (SKIP_TYPES.has(entry?.type)) continue;
    // Subagents have their own display; their lines would double the
    // conversation here.
    if (entry?.isSidechain === true || entry?.isMeta === true) continue;

    const patch = entry?.toolUseResult?.structuredPatch;
    if (Array.isArray(patch) && patch.length > 0) {
      // This line IS the tool_result for the Edit/Write call it belongs to
      // (its message.content carries a matching tool_use_id) - resolve
      // that call before pushing the diff, or it is stuck reading "Result
      // not loaded" even though the result did arrive. The same id travels
      // on the diff event itself: the view polls in windows, a call and
      // its diff can land in different responses, and only an id lets the
      // client re-pair them once both are in.
      const contentParts = Array.isArray(entry?.message?.content) ? entry.message.content : [];
      const resultPart = contentParts.find((p) => p?.type === 'tool_result' && typeof p.tool_use_id === 'string');
      if (resultPart) {
        const call = byToolUseId.get(resultPart.tool_use_id);
        if (call) {
          call.result = capResult(resultPart.content);
          call.resultLoaded = true;
        }
      }
      const { patch: cappedPatch, patchTruncated } = capPatch(patch);
      events.push({
        kind: 'diff',
        ...base(entry),
        filePath: typeof entry.toolUseResult.filePath === 'string' ? entry.toolUseResult.filePath : '',
        toolUseId: resultPart ? resultPart.tool_use_id : null,
        patch: cappedPatch,
        patchTruncated,
      });
      // A stray part beside the tool_result (text, an unrelated tool_use)
      // still gets its normal event instead of being lost with it.
      for (const part of contentParts) {
        if (part !== resultPart) pushPart(events, byToolUseId, entry, part);
      }
      continue;
    }

    const content = entry?.message?.content;
    if (typeof content === 'string') {
      if (!content.trim()) continue;
      events.push({ kind: entry.type === 'assistant' ? 'assistant' : 'user', ...base(entry), html: renderMarkdown(content) });
      continue;
    }
    if (!Array.isArray(content)) continue;

    // A user line can hold text and a tool_result at once; both are worth
    // showing, so every part gets its own pass.
    for (const part of content) {
      pushPart(events, byToolUseId, entry, part);
    }
  }
  return events;
}
