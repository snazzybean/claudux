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
  conversationAttachEl,
} from './dom.js';
import { checkResponse, showError, showToast } from './messages.js';
import { fillAlertIcons } from './icons.js';
import { pasteTextIntoTerminal, sendKey } from './terminal.js';

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
      // What was sent from here and has not shown up in the transcript yet,
      // one entry per card (see send). Per session, not per module: the cards
      // hang in the one stream element every session shares, and a switch has
      // to take them off the screen without losing them.
      pending: [],
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
// Every read that is started gets the next number. A card remembers the last
// one handed out before it was made, and only a read past that may answer for
// it (see reconcilePending) - a read in flight when the message went out
// carries a picture of the file from before it.
let readNo = 0;
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

// `keep` is what stays under the notice, and it is passed in rather than
// picked out of the dom: the cards for what was sent belong to one session's
// state, and scraping them off the screen would carry the previous session's
// into the next one's empty view.
function showNotice(text, keep = []) {
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
  conversationStreamEl.replaceChildren(notice, ...keep);
}

// An empty transcript in its two states. The second sentence exists because
// the first one would contradict a card standing right underneath it: the
// file really is empty, and what was sent is on its way there.
function emptyNotice(state) {
  return state.pending.length
    ? 'Nothing in the transcript yet - what was sent stands below.'
    : 'No conversation yet - send the first message.';
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
//
// `pending` are the cards for what was sent and is not in the transcript yet.
// They travel through here rather than being appended past it: this function
// removes whatever it did not want, so a card appended beside it would live
// exactly until the next poll.
function syncStream(events, pending) {
  const stream = conversationStreamEl;
  const existing = new Map();
  const inDom = new Map();
  for (const node of stream.children) {
    // A card carries no uuid and answers to no event, so it must not be
    // offered as a node one of them could reuse.
    if (node.dataset.pending) continue;
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
  // Last, and in the order they were sent: they are the newest thing on
  // screen until the transcript catches up with them.
  wanted.push(...pending);

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
  if (!state.events.length && !state.pending.length) {
    showNotice(emptyNotice(state));
    return;
  }
  const held = conversationStreamEl.scrollHeight - conversationStreamEl.scrollTop;
  // Set BEFORE the mutation, in both directions, so nothing has to guess
  // when a screen reader looks: only what is appended while following gets
  // announced, and a bulk build - a first look, a re-read, a window paged in
  // above - is not a whole transcript to read out.
  conversationStreamEl.setAttribute('aria-live', announce ? 'polite' : 'off');
  syncStream(state.events, state.pending.map((entry) => entry.node));
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
  return sameView(carrier, state) && state[field] === cursor;
}

// The half of that question a write without a cursor can ask - sending has no
// byte offset it started from, but it does have a session and a state object,
// and a restart replaces the latter without touching the former.
function sameView(carrier, state) {
  return carrierOf(session) === carrier && stateBySession.get(carrier) === state;
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
  showNotice(
    state.gone ? 'This session is gone - pick another one in the list.' : emptyNotice(state),
    state.pending.map((entry) => entry.node),
  );
}

// The first look, and the same read again later. `first` decides only how the
// view moves: a re-read runs while the reader sits at the end, so it must not
// force a scroll there that a finger has meanwhile moved away.
async function loadTail({ first = true } = {}) {
  const carrier = carrierOf(session);
  const state = stateFor(carrier);
  const readAt = readNo + 1;
  readNo = readAt;
  state.reading = true;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/conversation?tail=1`);
    // Nothing switched tabs or sessions while the request was in flight, and
    // no restart replaced the state this read belongs to? Every return below
    // checks both, because they all write into the shared stream element -
    // and because a card can be held by two state objects at once while a
    // restart carries it over, so settling one from the abandoned side would
    // stop the clock of a card that is still on screen.
    if (!sameView(carrier, state)) return;
    if (res.status === 404) {
      // Stamped here too, or `tailIsDue` is true on every tick from now on
      // and this read runs every couple of seconds for as long as the tab
      // stays open.
      state.tailAt = Date.now();
      const body = await res.json().catch(() => null);
      if (!sameView(carrier, state)) return;
      sessionMissing(body, state);
      return;
    }
    const data = await (await checkResponse(res)).json();
    if (!sameView(carrier, state)) return;
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
    reconcilePending(state, readAt);
    // Only a tail read carries the queue, and it is the other place a sent
    // message can turn up.
    markQueued(state);
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
// `keepPending` decides what happens to a card for something sent that the
// transcript had not shown yet, and the caller is the only one who knows: a
// window cut at the event cap says nothing about that message, a transcript
// that has been replaced says it was processed (see poll).
async function restart(carrier, { keepPending = false } = {}) {
  const held = stateBySession.get(carrier)?.pending ?? [];
  // Dropped cards have their clocks stopped here - a timer left running would
  // put a receipt on a node that belongs to no view any more.
  if (!keepPending) for (const entry of held) clearTimeout(entry.timer);
  stateBySession.delete(carrier);
  if (keepPending) stateFor(carrier).pending.push(...held);
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
  const readAt = readNo + 1;
  readNo = readAt;
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
  //
  // They differ in one thing, and a card for something just sent hangs off it:
  // a different transcript means a /clear did what it was asked, so that
  // message is accounted for and a card left standing would only go on to
  // claim it never arrived. The other two are this view's own trouble and say
  // nothing at all about the message - so the cards come along, and can still
  // find their turn in the window that comes back.
  if (data.transcriptId !== state.transcriptId
    || data.from !== sent
    || data.events.length >= MAX_WINDOW_EVENTS) {
    await restart(carrier, { keepPending: data.transcriptId === state.transcriptId });
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
  reconcilePending(state, readAt);
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
        // Marked for where they came from: these bytes precede the cursor this
        // view already had, and a message just sent cannot be in them. Without
        // the mark, scrolling up would hand reconcilePending a matching turn
        // from any point in the conversation - and a card for a message that
        // never arrived would come off the screen.
        for (const event of data.events) event.pagedIn = true;
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
  // flight, so coming back to this tab doesn't blank it first. A card for
  // something sent counts as loaded: it is the only trace of that message
  // until the transcript has it.
  if (state.events.length || state.pending.length) render(state, { scroll: 'end' });
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

// ---------- sending, and saying so when it did not arrive ----------

// How long a card waits for its own line before it says nothing came back.
// Longer than the tail budget on purpose: a message sent into a running turn
// goes into Claude Code's queue, the queue is only in the transcript as a
// queue line - which produces no event - and it only travels on a tail read.
// Anything shorter would call a perfectly queued message unconfirmed, which
// is the far more common case. What is left for the receipt after the two
// booleans below have caught "no terminal" and "not ready" is a pane with no
// live claude behind it, and nothing about that is urgent.
const PENDING_TIMEOUT_MS = 40_000;
// How much of the longer key the shorter one has to be for containment to
// count as the same message (see keyMatches).
const MIN_KEY_SHARE = 0.5;
// And how long a key has to be at all before being found INSIDE a longer turn
// says anything: "ok" sits in "Look", "go" in "gone". A short message does not
// need containment anyway - it renders as itself, so equality carries it.
const MIN_CONTAIN_KEY = 12;
// Mirrors MAX_QUEUE_CHARS in src/lib/sessionTranscript.js. Copied rather than
// imported for the same reason MAX_WINDOW_EVENTS above is: this file runs in
// the browser, which cannot reach a module under src/, and the repo has no
// build step to inline one. It is the only reason a queue entry can be
// shorter than the message it carries (see queueMatches).
const MAX_QUEUE_CHARS = 1000;
// A second look for the queue, shortly after the first: Claude Code writes
// its queue line a moment after the Enter, so the tail read that sending
// triggers can be just too early for it.
const QUEUE_LOOK_MS = 1500;
// What counts as a command rather than as text that happens to start with a
// slash: the name shapes real transcripts show are letters, digits and `-_:`
// after it, and nothing else. A path is what this rules out - the composer
// inserts an uploaded image as `/tmp/claudux-uploads/…`, and a message that is
// nothing but that path would otherwise take a command's receipt instead of
// the one an ordinary message gets.
const COMMAND_RE = /^\/[a-z\d][a-z\d:_-]*$/i;

let sending = false;

// The transcript comes back as html rendered from markdown, so it carries
// neither the asterisks that were typed nor the line breaks. Letters and
// digits are what survives both sides, and comparing on those is what lets a
// formatted message still recognise itself.
//
// A message with no letters or digits in it at all - a single emoji is the
// one that gets typed on a phone - would leave nothing to compare on. Then
// the text itself carries the key, whitespace out: there is no markdown in it
// for the rendering to have changed.
function compareKey(text) {
  const letters = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return letters || String(text ?? '').replace(/\s+/gu, '');
}

function turnText(html) {
  // Into a template, for the same reason markdownNode uses one: its content
  // is inert, so no image in the turn issues a request just to be read.
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');
  return template.content.textContent ?? '';
}

// Equality first, and for a short message that is the whole rule. Beyond it
// the two directions are different questions:
//
// The turn is LONGER - it carries the message and something else. A short key
// found inside it is no evidence at all, hence the floor; above the floor it
// still has to be most of the turn.
//
// The turn is SHORTER - rendering dropped something that was typed, a code
// fence's language tag being the case that occurs. Then what is left has to be
// most of the message, and there is no floor: the loss is small by nature.
//
// This branch is deliberately kept although it can be fooled - a foreign turn
// "thanks" answers for a sent "ok thanks". Nothing in the text separates that
// from the case the branch exists for (`jsfoo` against `foo`): same distance,
// same suffix. So one of the two has to give, and this is the cheaper way
// round - the false positive now needs a foreign user turn arriving AFTER the
// send that carries most of what was sent, which means someone typing into the
// terminal in the same moment, while dropping the branch would make every code
// block sent from here read "Not confirmed".
function keyMatches(sentKey, turnKey) {
  if (!sentKey || !turnKey) return false;
  if (sentKey === turnKey) return true;
  if (turnKey.length > sentKey.length) {
    return sentKey.length >= MIN_CONTAIN_KEY
      && turnKey.includes(sentKey)
      && sentKey.length >= turnKey.length * MIN_KEY_SHARE;
  }
  return sentKey.includes(turnKey) && turnKey.length >= sentKey.length * MIN_KEY_SHARE;
}

// A slash command is a different kind of message and takes a different test.
// Claude Code does not write it into the transcript as it was typed: it wraps
// it, and the wrapper can bring the whole expanded prompt along - many times
// the length of what was typed, which no share of a normalised key survives.
// What every one of them does carry is the command itself, verbatim and with
// its slash, and that is the stronger test anyway: nothing but this message
// puts "/handoff" in a turn.
function turnAnswers(entry, text, key) {
  if (entry.command) return text.includes(entry.command);
  return keyMatches(entry.key, key);
}

// The queue is a stricter question and gets a stricter rule - on the RAW text,
// not on a normalised key: a queue entry is the message as it was typed,
// nothing reformats it, and the server only ever cuts it at MAX_QUEUE_CHARS.
// So equality, or - for a message that was cut - the sent text starting with
// what survived, where only a genuine cut is allowed to be shorter and a cut
// is exactly that long. Containment anywhere would let one of Claude Code's
// own queued notifications claim the card of a short answer, and that card's
// clock stops when it is marked.
function queueMatches(entry, content) {
  const waiting = String(content ?? '').trim();
  if (!waiting) return false;
  if (entry.text === waiting) return true;
  // capText cuts one character short of the cap when the last one would be
  // half a surrogate pair.
  return waiting.length >= MAX_QUEUE_CHARS - 1 && entry.text.startsWith(waiting);
}

function uuidsOf(events) {
  return new Set(events.map((event) => event.uuid));
}

// Its line is in the transcript, so the card has done its job.
function settlePending(state, at) {
  clearTimeout(state.pending[at].timer);
  state.pending.splice(at, 1);
}

// Two things have to hold of a turn before it may answer for a card, and each
// one closes a hole of its own:
//
// - It was not in the baseline the card took when the message went out: what
//   stood on screen, plus what the file itself held a moment earlier (see
//   readBaseline). That baseline rides with the CARD and not with the state,
//   because the state object is exactly what a restart throws away - and after
//   a restart the fresh tail read hands back the whole end of the file, where
//   every old turn would otherwise look newly arrived.
// - It came from a read that STARTED after the message went out. A read
//   already in flight carries a picture of the file from before the message,
//   however late it lands, and with nothing loaded yet - a big transcript, the
//   tab just entered - its whole window would count as new.
// - It was not paged in from before the cursor. A message just sent cannot be
//   in bytes that precede the cursor this view already had, so nothing from a
//   `before` read is a candidate at all (see loadOlder).
//
// A turn that matches nothing leaves every card standing, deliberately: a
// `user` turn is not always a person's message - Claude Code queues
// notifications of its own - and taking the oldest card away for any turn
// that arrives would hide a message that is still waiting. A card that stays
// and says "not confirmed" is a wrong sentence on screen; a card that
// disappears is the same wrongness with nothing left to see.
function reconcilePending(state, readAt) {
  // Before anything is matched: a read that started BEFORE a card and only
  // landed now shows what the file held before that message went out - turns
  // written while this view was away included, which the window on screen
  // never had, and a whole tail window where nothing had been read yet. They
  // join the card's baseline; none of them is an answer to it.
  for (const entry of state.pending) {
    if (readAt > entry.readAt) continue;
    for (const event of state.events) entry.known.add(event.uuid);
  }
  for (const event of state.events) {
    if (event.kind !== 'user' || event.pagedIn || !state.pending.length) continue;
    const text = turnText(event.html);
    const key = compareKey(text);
    const at = state.pending.findIndex((entry) => readAt > entry.readAt
      && !entry.known.has(event.uuid)
      && turnAnswers(entry, text, key));
    if (at !== -1) settlePending(state, at);
  }
}

// A message the transcript has taken into its queue is not unaccounted for -
// it is waiting, which is a different sentence and stops the clock. The turn
// that follows once it is processed takes the card away.
//
// And back again, which is the half that is easy to miss: an entry can leave
// the queue without ever becoming a turn - an interrupt drops what was
// waiting. "Waiting in the queue." would then stand there for good, a sentence
// in the present tense about something that is not happening. So a card whose
// entry is gone goes back to waiting for a turn, clock and all.
//
// Only ever called where the queue is actually known (a tail read); a null
// queue means unread, not empty, and must not un-queue anything.
function markQueued(state) {
  if (!state.pending.length || !state.queue) return;
  const waiting = state.queue.waiting ?? [];
  for (const entry of state.pending) {
    const marked = entry.node.dataset.pending === 'queued';
    const queued = waiting.some((item) => queueMatches(entry, item?.content));
    if (queued === marked) continue;
    clearTimeout(entry.timer);
    entry.node.dataset.pending = queued ? 'queued' : 'true';
    entry.hint.textContent = queued ? 'Waiting in the queue.' : '';
    if (!queued) entry.timer = setTimeout(entry.expire, PENDING_TIMEOUT_MS);
  }
}

// The message as typed rather than rendered: what stands here is the field's
// content on its way out, and running it through a renderer would show
// something other than what was sent.
function pendingCard(text) {
  const node = document.createElement('div');
  node.className = 'conversation-event conversation-user';
  node.dataset.pending = 'true';
  const hint = document.createElement('div');
  hint.className = 'conversation-hint';
  node.append(document.createTextNode(text), hint);
  return { node, hint };
}

// The second watchman. The status this view knows can be two seconds old -
// Claude Code writes it, the watcher reads it every 2000ms - and inside that
// window a box can have opened: free text into one lands in its selection
// field and does something other than intended. So the pane is asked again,
// right before the keystrokes go out.
//
// What that answer can say today is whether the session is still there at
// all, which the route checks against tmux itself. `dialog` joins the same
// answer in the next step (readDialog on the server); an absent key reads as
// "no box open", which is the only way round a guard like this may fail.
async function refuseSend(carrier) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/pane`);
    if (res.status === 404) return 'This session is gone - pick another one in the list.';
    if (!res.ok) return null;
    const pane = await res.json();
    if (pane.dialog?.open) return 'The session is asking something - answer that card first.';
    return null;
  } catch {
    // A check that cannot be made must not stop the send: the two booleans
    // and the receipt below still cover the send itself.
    return null;
  }
}

// What the transcript holds right now, asked BEFORE the Enter goes out: every
// turn in that answer predates this message by construction. Nothing else can
// tell a turn written while this view was away - the tab was elsewhere, the
// cursor stood still, and the next poll hands all of it over at once - from an
// answer to what is being sent. The window on screen cannot say it, and the
// order of the reads cannot either: that poll legitimately starts after the
// message and still carries what came before it.
//
// Runs beside the pane check rather than after it, so it costs no extra wait,
// and its answer is only read - the poll's cursor stays where it was, so
// nothing here takes events away from the view.
async function readBaseline(carrier, offset) {
  try {
    const window = offset === null ? 'tail=1' : `after=${offset}`;
    const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/conversation?${window}`);
    if (!res.ok) return null;
    return uuidsOf((await res.json()).events ?? []);
  } catch {
    // No baseline is still better than a blocked send: what is left is the
    // window on screen plus the read order, which cover the common cases.
    return null;
  }
}

// Out through the very iframe the on-screen keyboard uses: term.paste plus a
// synthetic Enter. A channel of its own would be a second driver beside the
// claude process, and it could not carry a slash command - this lane can,
// because nothing on the way can tell it from something typed.
async function send() {
  // A second tap while the pane is being read would send the same text twice
  // and leave two cards that answer for one turn.
  if (sending) return;
  const text = conversationInputEl.value;
  // Said rather than ignored: a field holding two rows of spaces does not look
  // empty, and the button next to it would otherwise be the one control here
  // that visibly does nothing. A toast and not the banner - nothing is wrong,
  // there is just nothing to send.
  if (!text.trim()) {
    showToast('Nothing to send yet.');
    return;
  }
  const carrier = carrierOf(session);
  if (!carrier) return;
  const state = stateFor(carrier);
  const cursor = state.offset;
  sending = true;
  try {
    const [refusal, baseline] = await Promise.all([refuseSend(carrier), readBaseline(carrier, cursor)]);
    // The session can have been swapped while that was in flight, and the
    // iframe with it - the paste would land in another session's terminal.
    // The state object is checked along with it, the same pair every read on
    // this path checks: a restart inside this one session leaves the carrier
    // untouched, and the card would go into a state nothing renders from.
    if (!sameView(carrier, state)) return;
    if (refusal) {
      showError(refusal);
      return;
    }
    if (!pasteTextIntoTerminal(text)) {
      showError('No terminal for this session yet - open the terminal tab once, then send.');
      return;
    }
    if (!sendKey('Enter')) {
      // The text got in and the Enter did not, so it is sitting in the
      // terminal's input line. Clearing the field here would leave it
      // nowhere to be seen but there.
      showError('The terminal did not take the Enter - the text is in the terminal input.');
      return;
    }
    const { node, hint } = pendingCard(text);
    const trimmed = text.trim();
    const first = trimmed.split(/\s/)[0];
    const command = COMMAND_RE.test(first) ? first : null;
    // A message that is nothing but a slash command gets a different sentence
    // when the clock runs out, because the alarming one would not be true: the
    // keystrokes went out - both halves said so - and whether the command
    // leaves a line in the transcript is the command's own business. `/clear`
    // writes one, `/cost` opens a panel and writes nothing at all, and which
    // is which cannot be known from here; a list of the commands that write
    // turns would be a list that rots. So the receipt keeps its alarm for an
    // ordinary message, where a missing turn does mean something went wrong,
    // and says what it actually knows for this one.
    const bareCommand = command !== null && command === trimmed;
    const entry = {
      key: compareKey(text),
      // The message as typed, for the two comparisons that must not go through
      // a normalised key: the queue entry and a slash command.
      text: trimmed,
      // The command as typed, for a message that is one (see turnAnswers).
      command,
      // The picture the transcript has to differ from before a turn may answer
      // for this card: what is on screen, plus what the file itself held a
      // moment ago, plus the number of the last read that had started.
      known: new Set([...uuidsOf(state.events), ...(baseline ?? [])]),
      readAt: readNo,
      node,
      hint,
      timer: null,
      // A named function rather than an inline one: the clock is armed here and
      // armed again when a card comes back out of the queue (see markQueued).
      expire: () => {
        node.dataset.pending = bareCommand ? 'sent' : 'stale';
        hint.textContent = bareCommand
          ? 'Sent - not every slash command leaves a line in the transcript.'
          : 'Not confirmed - nothing in the transcript for it. Check the terminal.';
      },
    };
    entry.timer = setTimeout(entry.expire, PENDING_TIMEOUT_MS);
    state.pending.push(entry);
    conversationInputEl.value = '';
    fitInput();
    // Sending is an act of returning to the end. Without this the view still
    // counts as having left it, and the tail read below - which is gated on
    // sitting at the end - would not run at all.
    stickToBottom = true;
    hideJump();
    render(state, { scroll: 'end' });
    // The queue and a transcript that has just been created are both things
    // only a tail read sees, and sending changes both.
    refreshConversation();
    setTimeout(() => {
      if (carrierOf(session) === carrier) refreshConversation();
    }, QUEUE_LOOK_MS);
  } finally {
    sending = false;
  }
}

// The handler is needed whether or not it sends: an unhandled submit
// navigates the page away and takes the terminal iframe, and with it every
// open terminal, along with it.
conversationComposerEl.addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});

// The desktop sends on Enter and breaks the line on Shift+Enter; a touch
// keyboard has no comfortable Shift+Enter, so there Enter breaks the line and
// the button sends. Keyed on the pointer rather than on the window width: a
// narrow window on a desktop still has a real keyboard, and the same media
// query already decides this field's font size in styles.css. A tablet with a
// keyboard attached lands on the button side, which is the harmless one.
conversationInputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  // Mid-composition, Enter belongs to the input method: it picks a candidate.
  if (event.isComposing) return;
  if (window.matchMedia('(pointer: coarse)').matches) return;
  event.preventDefault();
  send();
});

// The route's own allowlist (src/routes/uploads.js), so the picker cannot
// offer a file it will reject.
const ATTACH_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

// The same call the terminal's paste handler makes: the route takes the raw
// image body with its own content type, not a form field.
async function attachImage(file) {
  try {
    const res = await fetch('/api/uploads/image', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    await checkResponse(res);
    const { path: uploadedPath } = await res.json();
    // The path goes into the field as text, exactly what the paste handler
    // does with it: Claude Code reads an image from a path, and an attachment
    // is part of the message being written rather than a message of its own.
    const value = conversationInputEl.value;
    const start = conversationInputEl.selectionStart ?? value.length;
    const end = conversationInputEl.selectionEnd ?? start;
    const insert = `${uploadedPath} `;
    conversationInputEl.value = `${value.slice(0, start)}${insert}${value.slice(end)}`;
    conversationInputEl.focus();
    conversationInputEl.setSelectionRange(start + insert.length, start + insert.length);
    // Assigning `value` fires no input event, so the field would keep the
    // height of the shorter text.
    fitInput();
  } catch (err) {
    showError(`Image upload failed: ${err.message}`);
  }
}

conversationAttachEl.addEventListener('click', () => {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = ATTACH_TYPES;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file) attachImage(file);
  });
  picker.click();
});
