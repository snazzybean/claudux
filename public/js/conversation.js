// The conversation view: a second client on the same session. It reads the
// transcript through /api/sessions/:id/conversation and sends input through
// the very ttyd iframe the keyboard uses - so an entry from here is
// indistinguishable from a typed one. There is no second driver; the claude
// process in tmux stays the only one.
import {
  conversationPanelEl,
  conversationStreamEl,
  conversationJumpEl,
  conversationDialogEl,
  conversationQueueEl,
  conversationComposerEl,
  conversationInputEl,
} from './dom.js';
import { checkResponse, showError } from './messages.js';
import { fillAlertIcons } from './icons.js';

// One state per session, so a tab switch comes back where it left off - the
// same idea as lastDirectory in files.js. Keyed on the CARRIER, which is
// what the route is keyed on too: after a /clear the conversation continues
// under a new Claude id while the tmux session - and with it the name this
// view asks under - keeps its own.
const stateBySession = new Map();

// The open session, kept whole rather than as an id: the route needs its
// carrier, and the status stream hands out both names.
let session = null;

function carrierOf(row) {
  return row?.carrier ?? row?.id ?? null;
}

function stateFor(carrier) {
  if (!stateBySession.has(carrier)) {
    stateBySession.set(carrier, {
      events: [],
      // The loaded window as byte offsets: `offset` is where a poll carries
      // on, `from` where paging further back begins. `chainAnchor` belongs
      // to the TOPMOST window - a poll doesn't walk the tree and reports
      // null for it, so it must never be written from one.
      from: null,
      offset: null,
      atStart: false,
      chainAnchor: null,
      transcriptId: null,
      // Only a tail read carries these, and where they cannot be trusted it
      // leaves the keys out entirely - so a poll must not write a null over
      // them. Keeping them fresh is what the occasional tail read below is
      // for; `null` here means "not read yet", not "empty".
      queue: null,
      permissionMode: null,
      // When the last tail read landed, plus the two reads that must not
      // overlap: a tail re-read replaces the whole loaded window, so it can
      // neither run into the first look nor into a window being paged in
      // above it.
      tailAt: 0,
      reading: false,
      loadingOlder: false,
      // Whether the route still knows this session. It belongs here and not
      // on the composer's `hidden`, because three places set that flag and
      // only one of them can find this out: entering the tab decides from
      // the carrier alone, and a vanished session still has a carrier.
      gone: false,
    });
  }
  return stateBySession.get(carrier);
}

// ---------- what one event looks like ----------

// Server-rendered and sanitized by the same renderer the Files tab uses
// (src/lib/fileRender.js), hence the same class - only its page-sized
// padding has to go, a turn in a conversation is not a document.
//
// Three things the renderer leaves to the client, and this view can only do
// the first: the alert icon it inserts the same way the Files tab does.
//
// The other two go back to being the text they came from, which is what the
// renderer itself does with an image it cannot resolve. A `data-file-path`
// anchor has nothing to resolve against here - a transcript is rendered
// without a project - so it would look live and do nothing. And no image is
// loaded at all, not just the relative one that would ask the raw route for
// project `undefined`: unlike the Files tab, which renders one file someone
// opened, this view renders a whole window of machine-appended turns by
// itself and re-renders it, so one image url in one turn would become a
// request to a foreign host per render. An attached image arrives as its own
// event kind, not as markdown, so nothing the session produces is lost.
function markdownNode(html) {
  // Parsed into a <template> rather than into the node itself: a template's
  // content is inert, so the image dropped below never issues its request.
  // Assigned to a live element, the src goes out before the loop can reach
  // it - one 404 per render, exactly the one being cleaned up here.
  const template = document.createElement('template');
  template.innerHTML = html;
  fillAlertIcons(template.content);
  for (const link of template.content.querySelectorAll('a[data-file-path]')) {
    link.replaceWith(document.createTextNode(link.textContent));
  }
  for (const image of template.content.querySelectorAll('img')) {
    image.replaceWith(document.createTextNode(image.alt));
  }
  const body = document.createElement('div');
  body.className = 'markdown-body';
  body.append(template.content);
  return body;
}

// The body goes into one box rather than straight into the <details>: the
// ceiling in css sits on that box, and a patch of twenty hunks would
// otherwise get twenty separately scrolling ones.
function foldout(summaryText, ...body) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = summaryText;
  const box = document.createElement('div');
  box.className = 'conversation-foldout-body';
  box.append(...body);
  details.append(summary, box);
  return details;
}

// Its own class rather than a bare `pre`: a code block inside a rendered
// turn is a `.markdown-body pre` and has to keep the styling the Files tab
// gives it, which a `.conversation-event pre` rule would override.
function preNode(text) {
  const pre = document.createElement('pre');
  pre.className = 'conversation-pre';
  pre.textContent = text;
  return pre;
}

function noteNode(text) {
  const note = document.createElement('div');
  note.className = 'conversation-note';
  note.textContent = text;
  return note;
}

function toolNode(event) {
  const title = `${event.name}${event.detail ? ` · ${event.detail}` : ''}`;
  // No result means the call has not come back yet - it is running. It
  // cannot mean "not loaded": a result always follows its call in the file,
  // so it is never in an older window than the call, and this view starts at
  // the end and pages upwards.
  if (!event.resultLoaded) return foldout(title, noteNode('Still running…'));
  // Returned, but through a diff that arrived in a later window than the
  // call - the diff carries the change, not the call's own one-line text
  // (see pairToolResults), so an empty result box would be the wrong shape.
  if (event.resultFromDiff) return foldout(title, noteNode('Applied - the change is in the diff.'));
  return foldout(title, preNode(event.result ?? ''));
}

// Folded like a tool result, and for the same reason: the server caps a
// result at 4000 characters but a patch at 4000 lines, so the diff is the
// larger of the two by far - open, one of them would be the whole
// conversation on a phone.
function diffNode(event) {
  const body = (event.patch ?? []).map((hunk) => preNode((hunk?.lines ?? []).join('\n')));
  // A shortened patch says so rather than reading as the whole change.
  if (event.patchTruncated) body.push(noteNode('Diff shortened.'));
  return foldout(event.filePath || 'Diff', ...body);
}

function todoListNode(todos) {
  const list = document.createElement('ul');
  list.className = 'conversation-todo-list';
  for (const todo of todos ?? []) {
    const item = document.createElement('li');
    item.dataset.status = todo?.status ?? '';
    item.textContent = todo?.content ?? '';
    list.append(item);
  }
  return list;
}

function eventNode(event) {
  const node = document.createElement('div');
  node.className = `conversation-event conversation-${event.kind}`;
  if (event.uuid) node.dataset.uuid = event.uuid;
  if (event.entrypoint) node.dataset.entrypoint = event.entrypoint;

  if (event.kind === 'user' || event.kind === 'assistant') {
    node.append(markdownNode(event.html));
  } else if (event.kind === 'thinking') {
    node.append(foldout('Thinking', markdownNode(event.html)));
  } else if (event.kind === 'tool') {
    node.append(toolNode(event));
  } else if (event.kind === 'toolResult') {
    // Its call sits above the loaded window, so the result stands alone.
    node.append(foldout('Tool result', preNode(event.result ?? '')));
  } else if (event.kind === 'diff') {
    node.append(diffNode(event));
  } else if (event.kind === 'image') {
    node.append(noteNode('Image attached'));
  } else if (event.kind === 'task') {
    const parts = ['Subagent', event.agentType, event.description].filter(Boolean);
    node.append(noteNode(parts.join(' · ')));
  } else if (event.kind === 'todos') {
    node.append(todoListNode(event.todos));
  }
  return node;
}

// ---------- pairing a call with its result ----------

// The server pairs a tool_use with its tool_result only INSIDE one read, and
// it reads byte windows: live, a call arrives in one poll and its result in
// the next. Re-pairing here is what keeps a card from reading "Still
// running…" once its output is in, and it produces exactly the shape a
// single window would have produced - a plain result folds into its call, a
// diff keeps the card of its own that the server gives it too.
//
// Runs after every change to the array, because both directions occur: a
// result arrives below its call while following, and a call arrives above a
// standing result when a window is paged in.
function pairToolResults(events) {
  const callFor = new Map();
  for (const event of events) {
    if (event.kind === 'tool' && event.toolUseId) callFor.set(event.toolUseId, event);
  }
  const kept = [];
  for (const event of events) {
    const call = event.toolUseId ? callFor.get(event.toolUseId) : null;
    if (event.kind === 'toolResult' && call) {
      call.result = event.result;
      call.resultLoaded = true;
      continue;
    }
    // A diff line IS the tool_result of the Edit or Write it belongs to, but
    // it does not carry that result's own text - so the call is marked as
    // returned and points at the diff instead of showing an empty box.
    if (event.kind === 'diff' && call && !call.resultLoaded) {
      call.resultLoaded = true;
      call.resultFromDiff = true;
    }
    kept.push(event);
  }
  return kept;
}

// ---------- the stream ----------

// Poll rather than a second SSE stream: only the open tab needs this, the
// server keeps no per-client state, and what a poll asks for is a byte range
// - the cheapest question this route answers.
const BUSY_MS = 1500;
const IDLE_MS = 5000;
// A poll deliberately neither carries a queue nor walks the tree, so it can
// correct neither a message queued since the first look nor a turn the
// session has taken back. A `?tail=1` is the only thing that corrects
// either, and it re-reads up to half a megabyte - so it runs on a clock of
// its own rather than on every poll.
const TAIL_EVERY_MS = 30_000;
// The most events one read can ever return, mirroring MAX_EVENTS in
// src/lib/sessionTranscript.js. Copied rather than imported: this file runs
// in the browser, which cannot reach a module under src/, and the repo has
// no build step to inline one. A window that legitimately holds exactly this
// many costs one unnecessary re-read - cheaper than the hole it guards
// against (see poll).
const MAX_WINDOW_EVENTS = 200;
// Far enough from the end to mean "left it" rather than "a line arrived".
const BOTTOM_SLACK = 40;
// Where paging upwards starts: about a thumb's width from the top edge.
const TOP_TRIGGER = 80;

let timer = null;
let stickToBottom = true;
let newCount = 0;
// Until when a scroll event is this module's own. Restoring the position
// after a prepend fires `scroll` exactly like a finger does, and the handler
// would then page on to the next window in the same gesture. A deadline
// rather than a flag cleared in a callback: a tab that goes away between the
// two runs no frame callback, and a flag left standing would kill the scroll
// handler for as long as the view lives.
let ownScrollUntil = 0;

// The raw four-value session state (busy/idle/waiting/shell), which exists
// only on the event stream: what the session list carries is already
// collapsed to working/waiting. Keyed on both names, like the dots in
// app.js - after a /clear the row is named differently from its carrier.
const statusById = new Map();

// From app.js's existing status handler, never by importing it back. The
// stream publishes a CHANGE only, so a session that was already working when
// this page loaded is never reported at all - which is what the row's own
// collapsed activity covers below until the first change arrives.
export function noteSessionStatus({ tmuxSession, sessionId, state }) {
  for (const id of [tmuxSession, sessionId]) if (id) statusById.set(id, state);
}

// `busy` is the only one of the four that means "producing". `waiting` and
// `idle` both wait on a person, `shell` on a background command.
function pollWait() {
  const raw = statusById.get(carrierOf(session)) ?? statusById.get(session?.id);
  if (raw) return raw === 'busy' ? BUSY_MS : IDLE_MS;
  return session?.activity === 'working' ? BUSY_MS : IDLE_MS;
}

function showNotice(text) {
  // Muted first: the stream is a live region, and a notice replacing a
  // transcript is not something to read out.
  conversationStreamEl.setAttribute('aria-live', 'off');
  const standing = conversationStreamEl.firstElementChild;
  // A session without a transcript gets this notice from every poll (see
  // there). Rebuilding the same sentence each time would be dom churn for
  // as long as that session goes unanswered.
  if (standing?.className === 'conversation-notice' && standing.textContent === text) return;
  const notice = document.createElement('div');
  notice.className = 'conversation-notice';
  notice.textContent = text;
  conversationStreamEl.replaceChildren(notice);
}

// What a node has to be rebuilt for: a signature of what the renderer reads,
// not a list of the fields thought likely to change. A key can pass from a
// dropped event to a different one - a standalone result folds into its call
// as soon as that call is paged in, and the events after it shift one place
// up - so a text turn would otherwise be able to reuse the node of a tool
// card, or of the turn before it.
function contentMark(event) {
  return `${event.kind}|${event.resultLoaded ? 1 : 0}|${(event.result ?? '').length}|${(event.html ?? '').length}`;
}

// The dom brought in line with state.events, node by node, instead of
// rebuilt: at poll cadence a rebuild would close a foldout while someone
// reads it and drop the scroll position every couple of seconds.
//
// A uuid is not a unique key - one transcript line can carry a thinking part
// and a text part, and both events name that line. Counting repeats on both
// sides, in the same order, is what makes the key unique.
function syncStream(events) {
  const stream = conversationStreamEl;
  const existing = new Map();
  const inDom = new Map();
  for (const node of stream.children) {
    if (!node.classList.contains('conversation-event')) continue;
    const uuid = node.dataset.uuid ?? '';
    const nth = (inDom.get(uuid) ?? 0) + 1;
    inDom.set(uuid, nth);
    existing.set(`${uuid}#${nth}`, node);
  }

  const seen = new Map();
  const wanted = [];
  for (const event of events) {
    const uuid = event.uuid ?? '';
    const nth = (seen.get(uuid) ?? 0) + 1;
    seen.set(uuid, nth);
    const mark = contentMark(event);
    const kept = existing.get(`${uuid}#${nth}`);
    if (kept && kept.dataset.mark === mark) {
      wanted.push(kept);
      continue;
    }
    const node = eventNode(event);
    node.dataset.mark = mark;
    wanted.push(node);
  }

  // A keyed patch: after each insert the node sits at `index`, so one
  // already in place costs nothing and anything left over is pushed behind
  // the last wanted node, where the loop below takes it out - the notice
  // node included.
  let index = 0;
  for (const node of wanted) {
    const current = stream.children[index];
    if (current !== node) stream.insertBefore(node, current ?? null);
    index += 1;
  }
  while (stream.children.length > wanted.length) stream.lastElementChild.remove();
}

function atBottom() {
  const stream = conversationStreamEl;
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < BOTTOM_SLACK;
}

// A scrollTop set from here fires `scroll` like a finger does, one frame
// later at the latest - 50ms covers that at any frame rate a phone reaches,
// and is short enough that the next real gesture is not swallowed with it.
function scrollTo(top) {
  ownScrollUntil = Date.now() + 50;
  conversationStreamEl.scrollTop = top;
}

function hideJump() {
  newCount = 0;
  conversationJumpEl.hidden = true;
}

function showJump() {
  conversationJumpEl.textContent = `${newCount} new`;
  conversationJumpEl.hidden = false;
}

// Three ways the stream can move after a change, one per caller: a first
// look and a tail re-read open at the end, an appended turn follows only
// while the reader has not left it, and a window loaded above must not move
// the view at all.
function render(state, { announce = false, scroll = 'end' } = {}) {
  if (!state.events.length) {
    showNotice('No conversation yet - send the first message.');
    return;
  }
  const held = conversationStreamEl.scrollHeight - conversationStreamEl.scrollTop;
  // Set BEFORE the mutation, in both directions, so nothing has to guess
  // when a screen reader looks: only what is appended while following gets
  // announced, and a bulk build - a first look, a re-read, a window paged in
  // above - is not a whole transcript to read out.
  conversationStreamEl.setAttribute('aria-live', announce ? 'polite' : 'off');
  syncStream(state.events);
  if (scroll === 'hold') scrollTo(conversationStreamEl.scrollHeight - held);
  else if (scroll === 'end' || stickToBottom) scrollTo(conversationStreamEl.scrollHeight);
}

// ---------- reading ----------

// Whether a read coming back is still the one the view waits for. The
// carrier check alone cannot answer that: a race INSIDE one session leaves
// `carrierOf(session)` untouched, so every one of those checks passes while
// the answer is already stale - two polls, started over one in-flight fetch
// by a visibilitychange, would both append the same turns and every one of
// them would stand twice. What does change is the cursor the read started
// from, and the state object itself, which starting over replaces.
function stillCurrent(carrier, state, field, cursor) {
  return carrierOf(session) === carrier
    && stateBySession.get(carrier) === state
    && state[field] === cursor;
}

// Hidden whenever there is nothing to answer: no session picked, or one the
// route no longer knows. Derived here and nowhere else - one place decides
// what `hidden` means and the three that set it read this.
//
// Hidden rather than disabled, the reasoning Task 7 settled: a disabled Send
// still claims there is a way to answer from here and it is merely
// unavailable.
function showComposer(state) {
  conversationComposerEl.hidden = !state || state.gone;
}

// Any answer at all is proof the session is still there to be answered. Both
// read paths report it, not just the tail read: gated on that one alone, a
// single 404 would leave the view unanswerable until the next tail read came
// due, a whole budget away.
function sessionAnswered(state) {
  state.gone = false;
  showComposer(state);
}

// A 404 means one of two things, and they need different sentences: no
// transcript yet, or no meta entry at all - the session gone from the store,
// ended on another device or reaped (dropConversationSession covers only the
// two local ways).
//
// The route says which of the two on the wire, so that is what decides. The
// local test stays as the fallback under it, and earns its place by being
// true on its own: a history on screen proves this transcript existed, so a
// 404 over one is never "nothing here yet", whatever the body says or fails
// to say.
function sessionMissing(body, state) {
  state.gone = body?.error === 'Unknown session' || state.events.length > 0;
  showComposer(state);
  // What was read stays readable - a dead session's conversation is still
  // its conversation.
  if (state.events.length) return;
  showNotice(state.gone
    ? 'This session is gone - pick another one in the list.'
    : 'No conversation yet - send the first message.');
}

// The first look, and the same read again later. `first` decides only how the
// view moves: a re-read runs while the reader sits at the end, so it must not
// force a scroll there that a finger has meanwhile moved away.
async function loadTail({ first = true } = {}) {
  const carrier = carrierOf(session);
  const state = stateFor(carrier);
  state.reading = true;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/conversation?tail=1`);
    // Nothing switched tabs or sessions while the request was in flight?
    // Every return below checks, because both write to the shared stream
    // element.
    if (carrier !== carrierOf(session)) return;
    if (res.status === 404) {
      // Stamped here too, or `tailIsDue` is true on every tick from now on
      // and this read runs every couple of seconds for as long as the tab
      // stays open.
      state.tailAt = Date.now();
      const body = await res.json().catch(() => null);
      if (carrier !== carrierOf(session)) return;
      sessionMissing(body, state);
      return;
    }
    const data = await (await checkResponse(res)).json();
    if (carrier !== carrierOf(session)) return;
    sessionAnswered(state);
    state.events = pairToolResults(data.events);
    state.from = data.from;
    state.offset = data.offset;
    state.atStart = data.atStart;
    state.chainAnchor = data.chainAnchor;
    state.transcriptId = data.transcriptId;
    // Present on a tail read only. Absent elsewhere means unknown, so the
    // test is for the key rather than for a value.
    if ('queue' in data) state.queue = data.queue;
    if ('permissionMode' in data) state.permissionMode = data.permissionMode;
    state.tailAt = Date.now();
    render(state, { scroll: first ? 'end' : 'follow' });
  } finally {
    state.reading = false;
  }
}

// A tail re-read replaces the loaded window, which is exactly what someone
// paging upwards must not lose - hence only while the view sits at the end.
// The pages above are dropped with it and fetched again on the next scroll
// up; at the end that is invisible, since only the height above the viewport
// changes.
function tailIsDue(state) {
  if (!stickToBottom || state.loadingOlder || state.reading) return false;
  return Date.now() - state.tailAt >= TAIL_EVERY_MS;
}

// Everything on screen is dropped and the end of the file read afresh.
// Clearing the state object is what makes every read still in flight discard
// itself rather than write into the new view (see stillCurrent).
async function restart(carrier) {
  stateBySession.delete(carrier);
  stickToBottom = true;
  hideJump();
  await loadTail();
}

// Whether entering the tab re-reads the end of the file or leaves that to
// the poll. A tab switch is one thumb movement and this read is half a
// megabyte, so ten switches in ten seconds must not be ten of them - the
// same budget the poll keeps for it. Nothing loaded yet always reads; a read
// already in flight is the one that will land.
function entryNeedsTail(state) {
  if (state.reading) return false;
  if (!state.events.length) return true;
  return Date.now() - state.tailAt >= TAIL_EVERY_MS;
}

// For whoever sends a message from this view: the queue and a freshly
// created transcript are both things only a tail read sees, and both change
// the moment something is sent. Zeroing the budget rather than reading from
// here keeps every read on the one path that carries the guards.
export function refreshConversation() {
  const carrier = carrierOf(session);
  if (!carrier) return;
  stateFor(carrier).tailAt = 0;
  pollNow();
}

async function poll() {
  const carrier = carrierOf(session);
  if (!carrier) return;
  const state = stateFor(carrier);
  // A read is in flight: its cursor is the one that will count.
  if (state.reading) return;
  // No cursor at all means the first look found no transcript - a session
  // whose first message has not been sent yet. The file appears with that
  // message, so the poll keeps asking for a first look instead of giving up
  // on the session for good; on the tail budget, because every one of those
  // asks is a 404 and nothing about it is urgent. Whoever sends from here
  // calls refreshConversation() to make the first one immediate.
  if (state.offset === null) {
    if (Date.now() - state.tailAt >= TAIL_EVERY_MS) await loadTail();
    return;
  }
  if (tailIsDue(state)) {
    await loadTail({ first: false });
    return;
  }
  const sent = state.offset;
  const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/conversation?after=${sent}`);
  // Handled here as well as in the tail read, not left to it: a session that
  // goes away is answered with 404 on every tick, and waiting for the tail
  // read to notice would leave a composer over it for a whole budget.
  if (res.status === 404) {
    const body = await res.json().catch(() => null);
    if (stillCurrent(carrier, state, 'offset', sent)) sessionMissing(body, state);
    return;
  }
  // Any other failure stays silent: a banner over the conversation for one
  // missed tick would be worse than the tick.
  if (!res.ok || !stillCurrent(carrier, state, 'offset', sent)) return;
  const data = await res.json();
  if (!stillCurrent(carrier, state, 'offset', sent)) return;
  sessionAnswered(state);
  // Three ways an answer is not the append it was asked for, and each one
  // means the view starts over rather than stack something under what is on
  // screen:
  //
  // - another transcript id: a /clear began a new file under the same tmux
  //   name, and this cursor belongs to the old one.
  // - `from` other than the offset that was sent: the server could not use
  //   it as a cursor and started over at byte 0. A transcript rewritten in
  //   place leaves it off a line boundary, and the id cannot show that -
  //   the file name did not change.
  // - as many events as a read can return: the window was cut at that cap,
  //   which keeps the NEWEST of a window, so what is missing are the oldest
  //   - a hole in the middle of the conversation with nothing on the wire
  //   to mark it.
  //
  // None of the three leaves a scroll position worth holding: the turns it
  // pointed at are not in the window that comes back.
  if (data.transcriptId !== state.transcriptId
    || data.from !== sent
    || data.events.length >= MAX_WINDOW_EVENTS) {
    await restart(carrier);
    return;
  }
  // The offset and nothing else. A poll does not walk the tree, so
  // chainAnchor, anchored, abandoned and segmentStart come back empty - and
  // `from` and `atStart` are worse than empty: a cursor that missed a line
  // boundary makes the server read from byte 0 and report atStart, which
  // would end paging upwards for good. Reading `from` is what the check
  // above does with it; writing it is the part that would break paging.
  state.offset = data.offset;
  if (!data.events.length) return;
  // What the array grew by, not what the answer carried: a poll that brings
  // only a tool result folds it into a card that is already on screen, and
  // "1 new" over a button that jumps to nothing new is a lie.
  const before = state.events.length;
  state.events = pairToolResults([...state.events, ...data.events]);
  const added = state.events.length - before;
  if (!stickToBottom && added > 0) {
    newCount += added;
    showJump();
  }
  render(state, { announce: true, scroll: 'follow' });
}

// No timer while the tab is hidden and none while this view is closed - the
// listener at the bottom of the file is what arms it again.
function pollNow() {
  clearTimeout(timer);
  timer = null;
  if (!session) return;
  poll().catch(() => {}).finally(schedule);
}

function schedule() {
  clearTimeout(timer);
  timer = null;
  if (!session || document.hidden) return;
  timer = setTimeout(pollNow, pollWait());
}

async function loadOlder() {
  const carrier = carrierOf(session);
  if (!carrier) return;
  const state = stateFor(carrier);
  if (state.atStart || !state.from || state.loadingOlder || state.reading) return;
  state.loadingOlder = true;
  try {
    // Up to four windows in one go: a window can hold nothing but lines that
    // produce no event at all - a `system` line carries a uuid and no
    // message - and stopping on one of those would leave paging stuck until
    // the next finger movement.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const sent = state.from;
      const anchor = state.chainAnchor ? `&anchor=${encodeURIComponent(state.chainAnchor)}` : '';
      const url = `/api/sessions/${encodeURIComponent(carrier)}/conversation?before=${sent}${anchor}`;
      const res = await fetch(url);
      if (!stillCurrent(carrier, state, 'from', sent)) return;
      const data = await (await checkResponse(res)).json();
      // Checked before anything is written, not after: a tail read that
      // landed meanwhile has already replaced the window this offset
      // belonged to.
      if (!stillCurrent(carrier, state, 'from', sent)) return;
      // A /clear while paging: the route now resolves a different file, and
      // this byte offset means nothing in it. The poll resets the view.
      if (data.transcriptId !== state.transcriptId) return;
      state.from = data.from;
      state.atStart = data.atStart;
      state.chainAnchor = data.chainAnchor;
      if (data.events.length) {
        state.events = pairToolResults([...data.events, ...state.events]);
        render(state, { scroll: 'hold' });
        return;
      }
      if (state.atStart) return;
    }
  } finally {
    state.loadingOlder = false;
  }
}

conversationStreamEl.addEventListener('scroll', () => {
  if (Date.now() < ownScrollUntil) return;
  stickToBottom = atBottom();
  if (stickToBottom) hideJump();
  if (conversationStreamEl.scrollTop < TOP_TRIGGER) loadOlder().catch(() => {});
});

conversationJumpEl.addEventListener('click', () => {
  stickToBottom = true;
  hideJump();
  scrollTo(conversationStreamEl.scrollHeight);
});

export function showConversation(nextSession) {
  session = nextSession;
  conversationPanelEl.hidden = false;
  conversationDialogEl.hidden = true;
  conversationQueueEl.hidden = true;
  // Entering the tab means following again: the view opens at the end, so
  // there is nothing left to jump to.
  stickToBottom = true;
  hideJump();
  const carrier = carrierOf(session);
  const state = carrier ? stateFor(carrier) : null;
  // From the state, never from the carrier alone: a session the route has
  // forgotten still has one, and deciding here would show a composer over it
  // again on every tab entry - the read that found it gone is not repeated,
  // because it is inside its own budget.
  showComposer(state);
  if (!state) {
    clearTimeout(timer);
    timer = null;
    showNotice('No session open - pick one in the list.');
    return;
  }
  // What was loaded before stays on screen while the fresh read is in
  // flight, so coming back to this tab doesn't blank it first.
  if (state.events.length) render(state, { scroll: 'end' });
  else showNotice('Loading the conversation…');
  if (entryNeedsTail(state)) loadTail().catch((err) => showError(err.message));
  schedule();
}

export function leaveConversation() {
  clearTimeout(timer);
  timer = null;
  conversationPanelEl.hidden = true;
  session = null;
}

// A hidden tab follows nothing: the timer stops rather than ticking behind a
// backgrounded browser, and coming back reads straight away instead of
// waiting out one more interval.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
    timer = null;
    return;
  }
  pollNow();
});

// One row that grows with what is typed, up to the ceiling in css. Without
// this a multi-line message is written through a single scrolling line.
// `border-box` is set globally, so scrollHeight - which excludes the border -
// would come out one border short and leave the field permanently scrolled.
//
// Exported because assigning `value` fires no `input` event: whoever clears
// the field after sending has to call this, or the field keeps the height of
// the message that is already gone.
export function fitInput() {
  const border = conversationInputEl.offsetHeight - conversationInputEl.clientHeight;
  conversationInputEl.style.height = 'auto';
  conversationInputEl.style.height = `${conversationInputEl.scrollHeight + border}px`;
}
conversationInputEl.addEventListener('input', fitInput);

// Nothing sends yet - that is the next step. The handler is needed
// regardless: an unhandled submit navigates the page away and takes the
// terminal iframe, and with it every open terminal, along with it.
conversationComposerEl.addEventListener('submit', (event) => event.preventDefault());
