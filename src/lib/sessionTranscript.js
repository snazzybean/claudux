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
// What is queued is not always something a person typed: Claude Code queues
// its own task notifications, which are XML blobs. Long enough for any
// prompt anyone types, short enough that one of those cannot fill the view.
export const MAX_QUEUE_CHARS = 1000;

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

// Every uuid-bearing line names its parent, so a transcript is a tree and
// Claude Code follows a PATH through it when it resumes - not the file. File
// order alone shows branches the session has abandoned (a rewind does that
// without any handover involved); the path alone hides everything before a
// second root, which is real conversation. Hence neither: file order is the
// ground, and a turn goes only where the fork it hangs off can be seen.

// One place for the lines: every function below walks the same ones, and a
// transcript read mid-write ends in a fragment rather than an error.
function* entries(jsonlText) {
  for (const rawLine of String(jsonlText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    yield entry;
  }
}

// The tree, taken from the raw lines rather than from the events: `system`
// and `attachment` lines carry uuid and parentUuid while producing no event
// at all, and they are regularly both the last uuid-bearing line of a file
// and the tree's root - an index built from events would break the chain at
// both ends.
function parentIndex(jsonlText) {
  const parents = new Map();
  const order = [];
  // Which request wrote a line, and whether it is a marker rather than a
  // turn: the fork test below needs both to tell a fork in the tree from a
  // fork in the conversation.
  const requests = new Map();
  const markers = new Set();
  for (const entry of entries(jsonlText)) {
    if (typeof entry?.uuid !== 'string') continue;
    parents.set(entry.uuid, typeof entry.parentUuid === 'string' ? entry.parentUuid : null);
    order.push(entry.uuid);
    if (typeof entry.requestId === 'string') requests.set(entry.uuid, entry.requestId);
    if (entry.isMeta === true) markers.add(entry.uuid);
  }
  return { parents, order, requests, markers };
}

// The path the session is on, walked backwards from the last uuid-bearing
// line. `anchor` is what makes that work on a byte window: a window in the
// middle of a file has no last line of its own to start from, so the caller
// hands over the uuid its previous walk was still looking for.
export function activeChain(jsonlText, { anchor = null } = {}) {
  const { parents, order, requests, markers } = parentIndex(jsonlText);
  const start = anchor ?? order.at(-1) ?? null;
  const chain = new Set();
  let cursor = start !== null && parents.has(start) ? start : null;
  const anchored = cursor !== null;
  let segmentStart = null;
  // Parents whose fork the walk cannot judge. Two of them: the line it
  // started from, because nothing here says how the chain arrived there - on
  // a byte window that line is an anchor handed over by the caller. And any
  // parent it reached through a marker line, because a marker points back at
  // where the session left off rather than at the turn before it, so the
  // work done in between hangs off that same parent. Either way a branch
  // beside it is not a branch that was taken back.
  const blindForks = new Set(cursor === null ? [] : [cursor]);
  // The guard is the loop bound, not a fear of cycles: a transcript read
  // mid-write can name a parent that is not in the file yet.
  while (cursor && parents.has(cursor) && !chain.has(cursor)) {
    chain.add(cursor);
    const parent = parents.get(cursor);
    if (parent === null) {
      segmentStart = cursor;
      break;
    }
    if (markers.has(cursor)) blindForks.add(parent);
    cursor = parent;
  }
  // A turn counts as taken back only where the fork it hangs off is visible
  // right here: its parent sits on the path, or its parent was taken back
  // already. Off the path is not enough on a byte window - the walk reaches
  // no further than this window's lines, and a parent link can name a line
  // further down the file, so everything it could not traverse would read as
  // abandoned. The same rule keeps what predates a compact: that stretch has
  // no parent on the live path either.
  const retracted = new Set();
  for (const uuid of order) {
    if (chain.has(uuid)) continue;
    const parent = parents.get(uuid);
    if (parent == null) continue;
    if (chain.has(parent)) {
      // One request's tool calls arrive as a line each and their results
      // come back in whatever order they finish, so the call that lost the
      // race sits beside the path rather than on it. Same request, same
      // turn - and both ids have to be real, or lines carrying none would
      // excuse each other.
      const request = requests.get(uuid);
      if (request && request === requests.get(parent)) continue;
      if (blindForks.has(parent)) continue;
      retracted.add(uuid);
    } else if (retracted.has(parent)) retracted.add(uuid);
  }
  // Where the walk stopped is what the next window needs. On a root there
  // is nothing older left to judge. Out of parents: the missing one is where
  // the next window carries on. Anchor never found: hand the same one back,
  // since the window behind this one is where it most likely sits - nulling
  // it would switch the filter off for the whole rest of the scrollback.
  let chainAnchor = null;
  if (!anchored) chainAnchor = anchor;
  else if (segmentStart === null && cursor && !parents.has(cursor)) chainAnchor = cursor;
  return { chain, retracted, segmentStart, chainAnchor, anchored };
}

// The roots, in file order. A null parent on a line with no uuid of its own
// is not one - it has no identity to be a root with.
export function segmentStarts(jsonlText) {
  const starts = [];
  for (const entry of entries(jsonlText)) {
    if (typeof entry?.uuid === 'string' && entry.parentUuid == null) starts.push(entry.uuid);
  }
  return starts;
}

// Takes what `activeChain` returned, and drops only the turns it could
// prove were taken back - a window whose fork point lies outside it keeps
// them. Showing a turn that was taken back is the honest direction; hiding
// real conversation is the failure this filter exists to prevent.
export function markAbandoned(events, { retracted = new Set(), anchored = true }) {
  // An anchor that is not in this text leaves nothing to judge against.
  if (!anchored) return { events: [...events], abandoned: 0 };
  const kept = [];
  let abandoned = 0;
  for (const event of events) {
    if (event.uuid && retracted.has(event.uuid)) {
      abandoned += 1;
      continue;
    }
    kept.push(event);
  }
  return { events: kept, abandoned };
}

// Claude Code logs every queue move. enqueue and remove carry the text,
// dequeue does not - it always takes the head.
export function queueState(jsonlText) {
  const waiting = [];
  for (const entry of entries(jsonlText)) {
    if (entry?.type !== 'queue-operation') continue;
    const content = typeof entry.content === 'string' ? capText(entry.content, MAX_QUEUE_CHARS) : null;
    if (entry.operation === 'enqueue') waiting.push({ content });
    else if (entry.operation === 'dequeue') waiting.shift();
    else if (entry.operation === 'popAll') waiting.length = 0;
    else if (entry.operation === 'remove') {
      // Nothing to remove means the enqueue is outside the text being read.
      // Dropping the head instead would delete a message still waiting.
      const at = waiting.findIndex((e) => e.content === content);
      if (at !== -1) waiting.splice(at, 1);
    }
  }
  return { waiting };
}

// `filtered: false` is for a window paged past the root of the live segment:
// everything older is conversation, and walking the tree anyway would anchor
// the next window's filter on this one's last uuid - a branch nobody asked
// about.
export function conversationView(jsonlText, { anchor = null, filtered = true } = {}) {
  const all = conversationEvents(jsonlText);
  const walk = filtered ? activeChain(jsonlText, { anchor }) : null;
  const { events, abandoned } = walk ? markAbandoned(all, walk) : { events: all, abandoned: 0 };
  return {
    events: events.slice(-MAX_EVENTS),
    abandoned,
    segmentStarts: segmentStarts(jsonlText),
    queue: queueState(jsonlText),
    // Where the walk ended: the live segment's first turn, or null.
    segmentStart: walk ? walk.segmentStart : null,
    // For the next, older window: which uuid to anchor on, and whether the
    // one just passed in was found. An unfiltered call hands its anchor back
    // rather than dropping it.
    chainAnchor: walk ? walk.chainAnchor : anchor,
    anchored: walk ? walk.anchored : false,
  };
}
