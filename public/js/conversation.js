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
  conversationStopEl,
  conversationWorkingEl,
  conversationModeEl,
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
      // The queue entry a take-back was aimed at, until a tail read shows
      // whether it is gone. Per session for the same reason `pending` is:
      // the box it is reported in is the one element every session shares.
      takeBack: null,
      // The mode that stood on the badge when the switch was last asked for.
      // A Shift+Tab leaves no line in the transcript, so this is the only
      // way the badge can say that what it shows may be out of date.
      modeAsked: null,
      // The two halves of the card that answers an open box: what the pane
      // says is on screen (readDialog's reading, so the KEYS), and what the
      // hook reported about it (the CONTENT). Both `null` for "not read
      // yet" - an unread pane must not hide the composer, and an unread
      // hook must not take a title away. `answered` is the lock while a
      // keystroke is on its way (see answer).
      dialog: null,
      held: null,
      answered: null,
      // Whether the route still knows this session. It belongs here and not
      // on the composer's `hidden`, because three places set that flag and
      // only one of them can find this out: entering the tab decides from
      // the carrier alone, and a vanished session still has a carrier.
      gone: false,
    });
    forgetOldStates(carrier);
  }
  return stateBySession.get(carrier);
}

// How many sessions' loaded windows the page keeps. One per carrier ever
// visited grew for the life of the page - each holding up to 200 events with
// a 4000-character result and a 20-hunk patch apiece - where the precedent
// this map was built on (lastDirectory in files.js) holds a string.
//
// The number is what a session switch costs when it misses: one tail read.
const MAX_KEPT_STATES = 8;

// In insertion order, so the oldest visit goes first - and only entries with
// nothing waiting on them. A state carrying a card for something sent, or a
// lock over keys that are already out, IS the receipt for those: dropping it
// would take a pending card's clock away and put a button back inside the
// window it must not be in (the same reasoning restart() carries them for).
function forgetOldStates(keep) {
  for (const [carrier, state] of stateBySession) {
    if (stateBySession.size <= MAX_KEPT_STATES) return;
    if (carrier === keep || state.pending.length || state.answered || state.takeBack) continue;
    stateBySession.delete(carrier);
  }
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

// The calls stay foldouts of their own inside the run, so opening it changes
// nothing about how a single call reads. The names are deduplicated because a
// run of eight greps is one tool, and "8 tool calls · Bash" says more than the
// same word eight times.
function toolRunNode(event) {
  const names = [...new Set(event.calls.map((call) => call.name))];
  const body = document.createElement('div');
  body.className = 'conversation-tool-run-body';
  body.append(...event.calls.map(toolNode));
  const node = foldout(`${event.calls.length} tool calls · ${names.join(', ')}`, body);
  node.classList.add('conversation-tool-run');
  return node;
}

// A run of tool calls is most of what a long turn puts on screen, and a
// command wrapped over three lines makes the run unreadable on a phone. Its
// own class rather than the shared summary rule: a tool's title is the one
// foldout label that is a command line - thinking, a result and a diff all
// carry a short label a clamp could only ever cut wrongly.
function toolNode(event) {
  const node = toolFoldout(event);
  node.classList.add('conversation-tool-call');
  return node;
}

function toolFoldout(event) {
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

// ---------- a subagent's own conversation ----------

// Fetched on the first open and kept: a transcript runs to tens of kilobytes
// and most cards are never opened. Keeping it is worth something only
// because the node survives a poll - syncStream reuses it as long as the
// event's mark is unchanged, which is what contentMark below is about.
//
// The answer says whether it may be kept. One thing in it can still change:
// a nested card whose transcript is not on disk yet. Nothing re-reads a
// loaded body, so that one goes unlatched and the next open asks again - an
// unattributable one does not, since no later write settles it.
async function loadAgentBlocks(carrier, agentId, target) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/agents/${encodeURIComponent(agentId)}`);
  if (carrierOf(session) !== carrier) return false;
  // The meta file that names the agent is written before its transcript, so
  // there is a moment in which the card is offered and the file is not there.
  if (res.status === 404) {
    target.replaceChildren(noteNode('This subagent has not written anything yet.'));
    return false;
  }
  const data = await (await checkResponse(res)).json();
  if (carrierOf(session) !== carrier) return false;
  target.replaceChildren(...data.blocks.map(agentBlockNode));
  // Only a spawning call carries the key at all, and only an unresolved one
  // carries it as null.
  return data.blocks.every((block) => block.agentId !== null || block.agentAmbiguous);
}

function toolLineNode(text) {
  const line = document.createElement('div');
  line.className = 'conversation-agent-block conversation-agent-tool';
  line.textContent = text;
  return line;
}

function agentBlockNode(block) {
  if (block.kind === 'text') {
    const body = markdownNode(block.html);
    body.classList.add('conversation-agent-block');
    return body;
  }
  const title = `${block.name}${block.detail ? ` · ${block.detail}` : ''}`;
  if (block.agentId === undefined) {
    return toolLineNode([title, block.result].filter(Boolean).join('\n'));
  }
  // A call that spawned an agent of its own, and the only place one can be
  // reached from: the spawning call of a nested agent stands in this
  // transcript and in no other, the session's own included.
  const card = agentCard({ ...block, description: block.detail, name: block.agentName });
  // What the agent handed back to its caller, beside the card rather than
  // inside it - the card holds the agent's own conversation, and this is the
  // one line of it addressed to the transcript around it.
  if (!block.result) return card;
  const pair = document.createDocumentFragment();
  pair.append(card, toolLineNode(block.result));
  return pair;
}

// Flat and unopenable where the server could not name a transcript, and it
// says which of the two reasons it was: nothing on disk answers to this call,
// or several do. The second is not the absence of a transcript, so it must
// not read as one. A foldout onto nothing would be worse than either - it
// says there is something to see.
function agentCard({ agentId, agentAmbiguous, agentType, description, name }) {
  const title = ['Subagent', agentType, name, description].filter(Boolean).join(' · ');
  if (!agentId) {
    return noteNode(agentAmbiguous
      ? `${title} - several agents ran under this name; which one this is is not on disk.`
      : `${title} - no transcript on disk names this one.`);
  }
  // Taken now rather than when the card is opened: the card was rendered
  // into one session's stream and belongs to it, whatever is on screen by
  // the time a finger reaches it.
  const carrier = carrierOf(session);
  const body = document.createElement('div');
  body.className = 'conversation-agent-blocks';
  const card = foldout(title, body);
  card.addEventListener('toggle', () => {
    // `loading` as well as `loaded`, because the latch is only set once an
    // answer is in: open-shut-open in quick succession would otherwise put
    // two requests on the way for the same body.
    if (!card.open || body.dataset.loaded === 'true' || body.dataset.loading === 'true') return;
    body.dataset.loading = 'true';
    body.replaceChildren(noteNode('Loading…'));
    loadAgentBlocks(carrier, agentId, body)
      .then((keep) => { if (keep) body.dataset.loaded = 'true'; })
      .catch((err) => body.replaceChildren(noteNode(err.message)))
      .finally(() => { delete body.dataset.loading; });
  });
  return card;
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
  } else if (event.kind === 'toolRun') {
    node.append(toolRunNode(event));
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
    node.append(agentCard(event));
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

// The open row again, from app.js's own refresh of the list. `session` is
// otherwise the object this view was entered with, and its `activity` is
// what isBusy falls back on below - a snapshot that never gets newer. Guarded
// on the carrier, so a row arriving for another session cannot switch this
// view onto it.
export function noteSessionRow(row) {
  if (!session || !row || carrierOf(row) !== carrierOf(session)) return;
  session = row;
}

// `busy` is the only one of the four that means "producing". `waiting` and
// `idle` both wait on a person, `shell` on a background command. The row's
// own collapsed activity is the fallback until the first change arrives, and
// it is a snapshot from when this tab was entered - which is why it comes
// last.
//
// One reader for both the poll cadence and the Stop button: two copies of
// this expression would drift, and they would then disagree about whether
// the session is producing anything.
//
// The fallback is only as fresh as the last list fetch, which is what
// noteSessionRow above keeps up - with the stream down it is all there is.
function isBusy() {
  const raw = statusById.get(carrierOf(session)) ?? statusById.get(session?.id);
  if (raw) return raw === 'busy';
  return session?.activity === 'working';
}

function pollWait() {
  return isBusy() ? BUSY_MS : IDLE_MS;
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
// The agent id is part of it because it arrives late: the meta file that
// names a subagent's transcript is written a moment after the line that
// spawned it, so the first render of a card is regularly the one that cannot
// open. Only a rebuild turns it into one that can, and nothing is lost -
// what it replaces is a card with nothing in it.
//
// And the ambiguity beside it, because a card can move from one closed state
// to the other with the id staying null the whole way: a second agent of the
// same name appearing turns "nothing has been written" into "cannot be
// attributed", and without this the card would keep the first sentence.
function contentMark(event) {
  if (event.kind === 'toolRun') return `toolRun|${event.calls.map(contentMark).join(';')}`;
  return `${event.kind}|${event.resultLoaded ? 1 : 0}|${(event.result ?? '').length}|${(event.html ?? '').length}|${event.agentId ?? ''}|${event.agentAmbiguous ? 1 : 0}`;
}

// A run of finished tool calls becomes ONE event before the dom is brought in
// line with the list, rather than a container the reconciler below has to
// learn about: it keys nodes on a uuid, a container has none of its own, and
// keying it by its first member would mean a second reconciler inside the
// first. Grouped here, the run is an event like any other - one uuid, one
// mark, one node.
//
// Three, not two: a pair costs two lines and reads as what it is, while a run
// of ten is what buries a conversation on a phone.
const TOOL_RUN_MIN = 3;

// Only calls that have RETURNED. What the session is doing right now stays on
// screen by itself and joins the run when it is done, which is also what keeps
// the run's mark still while a call spins.
function groupToolRuns(events) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= TOOL_RUN_MIN) {
      out.push({
        kind: 'toolRun',
        uuid: run[0].uuid,
        parentUuid: run[0].parentUuid,
        entrypoint: run[0].entrypoint,
        calls: run,
      });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const event of events) {
    if (event.kind === 'tool' && event.resultLoaded) {
      run.push(event);
      continue;
    }
    flush();
    out.push(event);
  }
  flush();
  return out;
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
  for (const event of groupToolRuns(events)) {
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
    // A rebuilt node must not close what someone has open: a run's mark changes
    // every time the session finishes another call, so without this a run being
    // read would shut itself. The outer foldout only - an inner one is a
    // different call each time the run grows, and matching them up by position
    // would be a guess.
    if (kept) {
      const before = kept.querySelector(':scope > details');
      const after = node.querySelector(':scope > details');
      if (before && after) after.open = before.open;
    }
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
//
// And gone while a box is open, which is the third of those states: free text
// into an open dialog lands in its selection field and does something other
// than intended. Here the sentence Task 7 settled is stronger still - there IS
// a way to answer from this tab, and it is the card standing where the
// composer was. That swap is also what pays for the card: the column is fully
// subscribed, and these two are never on screen at the same time.
function showComposer(state) {
  conversationComposerEl.hidden = !state || state.gone || dialogIsOpen(state);
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
    // message can turn up. settleTakeBack goes after it, not before: the card
    // has to see the withdrawal that markQueued turns into its own sentence.
    markQueued(state);
    settleTakeBack(state, readAt);
    // Before the render, not after: the mode badge and the queue box change
    // the height of what sits below the transcript, and on a narrow screen
    // the badge appearing is what moves the composer onto a second row. That
    // height comes off the stream, so a render that scrolls to the end first
    // and loses it afterwards opens the view short of the end.
    renderControls(state);
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

// A tail read now, for a caller that has to act on what it brings back rather
// than on the budget - the queue is the only thing that travels on it, and
// the one destructive control in this view aims at an entry in that queue.
//
// The three conditions from tailIsDue and not its budget: those three are what
// makes a tail read safe to run at all, and none of them is a clock. Where one
// of them holds the answer is `false` rather than a wait - a read that is in
// flight lands within the moment, and refusing says so where racing it would
// put two whole-window writes in the air at once.
async function freshQueue(state) {
  if (!stickToBottom || state.loadingOlder || state.reading) return false;
  state.tailAt = 0;
  try {
    await loadTail({ first: false });
  } catch {
    // Reported by the caller rather than here: this runs from a click and
    // the answer to it is that nothing was sent, which is the caller's
    // sentence. A poll failing on its own stays silent, as it does elsewhere.
    return false;
  }
  return true;
}

// Everything on screen is dropped and the end of the file read afresh.
// Clearing the state object is what makes every read still in flight discard
// itself rather than write into the new view (see stillCurrent).
// `keepPending` decides what happens to a card for something sent that the
// transcript had not shown yet, and the caller is the only one who knows: a
// window cut at the event cap says nothing about that message, a transcript
// that has been replaced says it was processed (see poll).
async function restart(carrier, { keepPending = false } = {}) {
  const previous = stateBySession.get(carrier);
  const held = previous?.pending ?? [];
  // Dropped cards have their clocks stopped here - a timer left running would
  // put a receipt on a node that belongs to no view any more.
  if (!keepPending) for (const entry of held) clearTimeout(entry.timer);
  stateBySession.delete(carrier);
  const state = stateFor(carrier);
  if (keepPending) state.pending.push(...held);
  // The box in the terminal is not part of the transcript and survives all
  // three reasons to start over. Dropped with the rest it would take the card
  // off the screen for a tick, drop the receipt for a keystroke on its way,
  // and leave the buttons drawn from the old box comparing against nothing.
  //
  // The take-back lock is the same kind of thing and travels for the same
  // reason: it covers keys that are already out. Dropped, the button comes
  // back inside the window the pane needs to redraw, and a second press would
  // pass its gate on the picture from before the first one - which is exactly
  // what the lock exists to prevent.
  if (previous) {
    state.dialog = previous.dialog;
    state.held = previous.held;
    state.answered = previous.answered;
    state.takeBack = previous.takeBack;
  }
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
  // Before the read, and on every tick: what Stop shows comes off the event
  // stream, and the box has a lateness of its own to report - neither waits
  // for an answer, and poll() has several paths that return without one.
  const carrier = carrierOf(session);
  if (carrier) renderControls(stateFor(carrier));
  // Beside renderControls and for the same reason: what the card says comes
  // off the pane and the hook, neither of which the transcript read touches.
  refreshDialog().catch(() => {});
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
  // Leaving the end is what makes the queue box a picture of an older
  // moment, so it is redrawn here rather than waiting for the next tick -
  // and only when that actually changed, since a scroll fires per frame.
  const state = stateBySession.get(carrierOf(session));
  if (state && queueActionable !== null && queueActionable !== queueIsActionable(state)) renderQueue(state);
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
  // Entering the tab means following again: the view opens at the end, so
  // there is nothing left to jump to.
  stickToBottom = true;
  hideJump();
  // The Stop lockout belongs to the session that received the Escape. Left
  // standing, the first tap on the next session would be answered with
  // "already sent" about an interrupt that session never got.
  stopSentAt = 0;
  const carrier = carrierOf(session);
  const state = carrier ? stateFor(carrier) : null;
  // Before the branch below and with a null state too, so no session's queue,
  // Stop or mode is left standing over the next one - all three read the
  // state and hide themselves when there is none. One writer, like the
  // composer beside them.
  renderControls(state);
  // The card the same way, and from the state rather than hidden outright: a
  // session re-entered with a box still standing would otherwise get a frame
  // with neither a composer nor anything in its place. The fresh reading is a
  // request away (below); this is what was true when the tab was left.
  renderDialog(state);
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
  // Straight away rather than on the first tick: that is up to five seconds
  // out, and a box already standing is the reason someone opened this tab.
  refreshDialog().catch(() => {});
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
    // What was written, when the server sends it: rendered text loses
    // whatever the renderer draws rather than writes, and a numbered list then
    // reads "Not confirmed" with its own line right there. The rendered text
    // stays as the fallback for a turn read before that field existed.
    const text = event.text ?? turnText(event.html);
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
// the queue without ever becoming a turn - being taken back is exactly that,
// and it is what the button in the queue box does. "Waiting in the queue."
// would then stand there for good, a sentence in the present tense about
// something that is not happening. So a card whose entry is gone goes back to
// waiting for a turn, clock and all - unless it is gone because it was
// withdrawn from here, which has its own sentence below.
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
    // An entry that left the queue because it was taken back from here is
    // accounted for, and the clock must not start again over it: "nothing in
    // the transcript for it" is exactly what was asked for.
    const taken = !queued && withdrawn(state, entry);
    entry.node.dataset.pending = queued ? 'queued' : (taken ? 'taken' : 'true');
    if (queued) entry.hint.textContent = 'Waiting in the queue.';
    else entry.hint.textContent = taken ? 'Taken back out of the queue.' : '';
    if (!queued && !taken) entry.timer = setTimeout(entry.expire, PENDING_TIMEOUT_MS);
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
// The answer carries `dialog` from readDialog on the server, and an absent
// key reads as "no box open" - the only way round a guard like this may fail,
// so an older server or a failed read lets the send through rather than
// blocking it.
async function refuseSend(carrier) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/pane`);
    if (res.status === 404) return 'This session is gone - pick another one in the list.';
    if (!res.ok) return null;
    const pane = await res.json();
    if (pane.dialog?.open) return 'The session is asking something - answer it in the terminal tab.';
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

// ---------- the three controls beside the composer ----------

// Stop, the queue box and the mode badge all say something about the SESSION
// rather than about the window that is loaded, so they are refreshed on the
// poll's tick rather than on a read: the status Stop reads arrives on the
// event stream, and a read can be several seconds away or not come at all.

// How long a take-back waits before the box says the keystrokes went nowhere.
// It has to outlast the two tail reads the press triggers - the queue travels
// on nothing else - and the second of those is deliberately late enough for
// Claude Code to have written its line.
const TAKEBACK_GRACE_MS = 6000;
// The two things a take-back can be waiting for. `checked` is set by the tail
// read that lands after it, so everything below turns on evidence rather than
// on a clock: while it is unset, no read has looked yet.
const takeBackPending = (state) => Boolean(state?.takeBack) && !state.takeBack.checked;
// Ignoring a second Stop for this long. Escape twice in a row is a control of
// its own in Claude Code - it opens the history picker - and the button stays
// on screen for a moment after a successful interrupt, because the status it
// hides on arrives from the event stream a beat later.
const STOP_LOCKOUT_MS = 2500;

let takingBack = false;
let stopSentAt = 0;
// How the box was last drawn, so a scroll redraws it only when leaving or
// reaching the end actually changed that - `scroll` fires per frame.
let queueActionable = null;

function waitingOf(state) {
  // A null queue is "not read yet", not "empty" - only a tail read carries
  // one, and nothing may be shown or acted on from the absence.
  return state?.queue?.waiting ?? [];
}

// Gone from the queue is the only thing that says the take-back went through:
// an entry leaves it either as a turn or without one, and this view cannot
// see which from the queue alone. Three answers, and the third is why this
// does not test the queue's LENGTH: a queue that drained a turn boundary is
// shorter too, and reading that as success puts "Taken back" on screen about
// a message that was sent. So the aimed-at ENTRY has to be gone - one fewer
// entry carrying its text, since two entries can carry the same one and
// removing one of a pair must not read as a failure. An entry whose enqueue
// line carried no content has no text to count, and for that one there is
// nothing to compare: `null` is this view saying it cannot tell.
function takeBackDone(state) {
  const waiting = waitingOf(state);
  const { content, count } = state.takeBack;
  if (content === null) return null;
  return waiting.filter((item) => item?.content === content).length < count;
}

// Whether this card's message is the one a take-back was aimed at. Same rule
// the queue uses to claim a card in the first place (see queueMatches), so a
// card can never be marked withdrawn by a queue entry that was never its own.
function withdrawn(state, entry) {
  return Boolean(state.takeBack) && queueMatches(entry, state.takeBack.content);
}

// A tail read has landed, which is the evidence a take-back waits for. Gone
// from the queue means it went through and there is nothing left to say; still
// there means the button comes back so it can be tried again, and the hint
// takes over once the grace has passed on top of that.
//
// But only a read that STARTED after the keys went out may answer for it - the
// same rule a pending card carries (see reconcilePending), and for the same
// reason: a read already in flight holds a picture of the queue from before
// them, however late it lands. Releasing the lock on one of those puts the
// button back inside the very window the pane needs to redraw, which is the
// window the lock exists for.
//
// A read that came too late to count zeroes the tail budget instead, so the
// next tick fetches one that can answer - otherwise the answer this one just
// stamped would hold the lock for a whole budget.
//
// Only ever called where the queue is known, right after markQueued has had
// its look at the same answer.
function settleTakeBack(state, readAt) {
  if (!state.takeBack) return;
  if (readAt <= state.takeBack.readAt) {
    state.tailAt = 0;
    return;
  }
  const done = takeBackDone(state);
  if (done === true) {
    state.takeBack = null;
    return;
  }
  state.takeBack.checked = true;
  // Carried on the lock rather than recomputed in the renderer: it decides
  // which sentence the box says, and the two differ in what they claim - one
  // says the keys went nowhere, the other says this view cannot see whether
  // they did.
  state.takeBack.unsure = done === null;
}

function queueEntryNode(entry) {
  const node = document.createElement('div');
  node.className = 'conversation-event conversation-waiting';
  // An enqueue line need not carry a `content` KEY at all, and never carries
  // an empty one, so `??` is the operator that fires here. Saying that
  // something waits beats inventing its text.
  node.textContent = entry?.content ?? 'One waiting message';
  return node;
}

function takeBackButton() {
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn-surface btn-lift conversation-takeback';
  back.textContent = 'Take the last one back';
  back.addEventListener('click', takeBack);
  return back;
}

function hintNode(text) {
  const hint = document.createElement('div');
  hint.className = 'conversation-hint';
  hint.textContent = text;
  return hint;
}

// Whether the queue can be worked from where the view currently stands.
//
// Away from the end of the conversation it cannot: the queue travels on a tail
// read alone, and a tail read only runs while the view sits at the end - so up
// there the box is a picture of an older moment, and taking "the last one"
// back would aim at whatever has since taken its place.
//
// Nor while a take-back is still unanswered. That is the lock, and it is the
// pane's own delay that makes it necessary: a second press would read the pane
// before the first press's keystrokes had redrawn it, pass the gate on that
// stale picture, and send Arrow-Up into a line the first press had just filled.
// Tied to the read rather than to a duration, because the read is what makes
// the box true again - and it is immediate, since a take-back zeroes the tail
// budget.
function queueIsActionable(state) {
  return stickToBottom && !state?.gone && !takeBackPending(state);
}

// What waits, and whether it can be worked. The box is rebuilt only when its
// content changes: it carries a button, and replacing that under a thumb on
// the poll's tick would swallow the tap.
function renderQueue(state) {
  const waiting = waitingOf(state);
  const actionable = queueIsActionable(state);
  // Only once a read has actually looked and still found the entry, and only
  // where the box is current. On the clock alone this fired after a take-back
  // that worked, because away from the end no tail read runs to settle it -
  // the absence of a read reported as the failure of the keystrokes. And even
  // with a read behind it the sentence has no place up there, directly above a
  // line saying the box is a picture of an older moment: two statements that
  // disagree are worse than either alone.
  const settled = actionable && Boolean(state?.takeBack) && state.takeBack.checked;
  // No grace in front of this one, unlike the sentence below it: the grace is
  // there to give a slow keystroke time to show, and no amount of waiting
  // resolves an entry that carries no text to look for.
  const unsure = settled && Boolean(state.takeBack.unsure);
  const late = settled && !unsure && Date.now() - state.takeBack.at > TAKEBACK_GRACE_MS;
  const mark = JSON.stringify([
    carrierOf(session), waiting.map((item) => item?.content ?? null),
    actionable, late, unsure, takeBackPending(state),
  ]);
  conversationQueueEl.hidden = waiting.length === 0;
  queueActionable = waiting.length === 0 ? null : actionable;
  if (!waiting.length || conversationQueueEl.dataset.mark === mark) return;
  conversationQueueEl.dataset.mark = mark;
  conversationQueueEl.dataset.stale = actionable ? 'false' : 'true';
  // The entries scroll, the button does not: a ceiling over the whole box cuts
  // the button off and leaves the one control this box has reachable only by
  // scrolling inside the box.
  const list = document.createElement('div');
  list.className = 'conversation-queue-list';
  list.append(...waiting.map(queueEntryNode));
  const nodes = [list];
  if (late) nodes.push(hintNode('Sent, and it is still waiting - the terminal took those keys somewhere else.'));
  if (unsure) nodes.push(hintNode('Sent - the waiting message carries no text, so this view cannot tell whether it went. The terminal tab shows what is left.'));
  // A locked-out button is replaced by the reason, never left there to be
  // tapped into nothing: what the box says is what it is doing.
  if (actionable) nodes.push(takeBackButton());
  else if (takeBackPending(state)) nodes.push(hintNode('Taken back - waiting for the transcript to confirm it.'));
  else nodes.push(hintNode('Scroll to the end to work the queue - up here it is a picture of an older moment.'));
  conversationQueueEl.replaceChildren(...nodes);
}

// Interrupting is worth offering only while something is running: `busy` is
// the one of the four states that means the session is producing. The label
// says what Escape does with a queue, because it reaches further than the word
// "stop" suggests.
// Claude Code's own status line, mirrored from the pane: it says what it is
// doing and for how long, in its own words, and afterwards how long it took.
// A line the app wrote itself could only ever say less.
//
// Always there, never hidden: the height is reserved even while the text is
// empty, so the conversation above does not jump every time a turn starts and
// ends. An absent reading leaves the last line standing rather than blanking
// it - the same rule the card follows for a read that failed.
function renderStatus(status) {
  conversationWorkingEl.textContent = status?.text ?? '';
  conversationWorkingEl.dataset.working = status?.working ? 'true' : 'false';
}

function renderStop(state) {
  const waiting = waitingOf(state);
  conversationStopEl.hidden = !state || state.gone || !isBusy();
  conversationStopEl.textContent = waiting.length ? 'Stop · sends the queue' : 'Stop';
  conversationStopEl.dataset.queued = waiting.length ? 'true' : 'false';
}

// The mode the transcript names, which is the mode the LAST submitted prompt
// ran under - a switch writes no line of its own. So after the button has
// been pressed the badge shows a value that may already be wrong, and it says
// so by being dimmed until a different one arrives. The terminal's own status
// line has the current one immediately.
function renderMode(state) {
  const mode = state?.permissionMode ?? null;
  conversationModeEl.hidden = !mode || Boolean(state?.gone);
  if (!mode) return;
  const stale = state.modeAsked === mode;
  conversationModeEl.textContent = mode;
  conversationModeEl.dataset.stale = stale ? 'true' : 'false';
  // "at the last message" in both branches: the keybar's own Shift+Tab can
  // switch the mode without this view hearing anything, so even unasked the
  // value is only as current as the last prompt. The attribute carries the one
  // thing more that is known - that a switch was asked for since.
  conversationModeEl.title = stale
    ? `Permission mode at the last message: ${mode}, and a switch has been asked for since. Tap to switch one further.`
    : `Permission mode at the last message: ${mode}. Tap to switch one further.`;
  conversationModeEl.setAttribute('aria-label', conversationModeEl.title);
  if (!stale) state.modeAsked = null;
}

function renderControls(state) {
  renderStop(state);
  renderMode(state);
  renderQueue(state);
}

// The pane, read for one question: is the terminal's input line empty. Its
// own reader rather than refuseSend's, because the two want the opposite
// thing from a check they could not make - a send that goes out unchecked is
// at worst a message into an open box, while the keys below edit whatever
// happens to be on that line.
async function promptIsClear(carrier) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/pane`);
    if (res.status === 404) return 'gone';
    if (!res.ok) return 'unknown';
    const pane = await res.json();
    // An open box has no input line at all, and this is the reason the pane
    // can name, so it comes first.
    if (pane.dialog?.open) return 'dialog';
    // No input line and no box either - a full-screen state, or a server too
    // old to send the field. Both are "cannot tell", and neither is the line
    // being occupied: "clear that line" would send someone looking for text
    // that is not there.
    if (typeof pane.promptEmpty !== 'boolean') return 'unknown';
    return pane.promptEmpty ? 'empty' : 'busy';
  } catch {
    return 'unknown';
  }
}

// The one destructive thing this view can do, so it is the one place where a
// check that cannot be made refuses rather than waves through.
//
// Arrow-Up reaches the queue only from an empty first row: with anything on
// that line it walks history or moves the cursor instead, and the Ctrl+U
// after it would then clear a stranger's text to the line start. Claude Code
// also writes prompt SUGGESTIONS onto that line, which look exactly like
// something typed - so the gate cannot tell them apart and errs towards
// refusing.
//
// Both keys, not just the Arrow-Up that empties the queue: the Arrow-Up
// leaves the withdrawn message sitting on the input line, and the next send
// from here pastes into that same line - the two would go out as one message.
async function takeBack() {
  const carrier = carrierOf(session);
  // Read, never created, the same rule the Stop handler beside it follows: a
  // click on a control the view never showed must not put an entry in the map.
  const state = stateBySession.get(carrier);
  if (!carrier || !state || takingBack) return;
  if (!waitingOf(state).length) return;
  takingBack = true;
  try {
    // The box first, and only then the target. What is on screen travels on a
    // tail read and on nothing else, and that read has a 30 s budget - so even
    // at the end of the conversation, where the button is offered, the box can
    // be half a minute behind, and a queue drains at every turn boundary. The
    // entry aimed at would then be one that has already gone out, and the keys
    // would take whatever has since taken its place.
    if (!(await freshQueue(state))) {
      showError('The conversation could not be read just now - nothing was sent. Try again in a moment.');
      return;
    }
    if (!sameView(carrier, state)) return;
    const waiting = waitingOf(state);
    const target = waiting.at(-1);
    if (!target) {
      showToast('Nothing is waiting any more - the queue has gone out.');
      return;
    }
    const gate = await promptIsClear(carrier);
    // The session can have been swapped while that was in flight, and the
    // iframe with it - the keys would land in another session's terminal.
    if (!sameView(carrier, state)) return;
    if (gate === 'gone') {
      showError('This session is gone - pick another one in the list.');
      return;
    }
    if (gate === 'dialog') {
      showError('The session is asking something - answer it in the terminal tab.');
      return;
    }
    if (gate === 'busy') {
      showError('The terminal input line is not empty - open the terminal tab, clear that line, then try again.');
      return;
    }
    if (gate === 'unknown') {
      showError('The terminal could not be read just now - nothing was sent. Try again in a moment.');
      return;
    }
    if (!sendKey('ArrowUp')) {
      showError('The terminal is not ready yet - open the terminal tab once, then try again.');
      return;
    }
    // Its own sentence: the Arrow-Up has already put the withdrawn message on
    // the input line, and without the Ctrl+U it stays there - where the next
    // send from here would paste into it.
    if (!sendKey('u', true)) {
      showError('Only half of it went out - the message is on the terminal input line now. Clear it there.');
      return;
    }
    const content = target.content ?? null;
    state.takeBack = {
      content,
      // How many entries carried that text when the keys went out, so one of
      // a pair going is a withdrawal rather than a puzzle (see takeBackDone).
      count: waiting.filter((item) => (item?.content ?? null) === content).length,
      at: Date.now(),
      // The last read handed out before the keys left, so a read already in
      // flight cannot answer for this one (see settleTakeBack).
      readAt: readNo,
      checked: false,
    };
    // Straight away, so the button is gone before a second tap can reach it -
    // the queue itself only changes with the tail read below.
    renderQueue(state);
    // The queue travels on a tail read and on nothing else, so the box would
    // otherwise keep the withdrawn entry until the budget came round.
    refreshConversation();
    setTimeout(() => {
      if (carrierOf(session) === carrier) refreshConversation();
    }, QUEUE_LOOK_MS);
  } finally {
    takingBack = false;
  }
}

conversationStopEl.addEventListener('click', () => {
  // Read, never created: this runs from a click, and a click on a control the
  // view never showed must not put an entry in the map.
  const waiting = waitingOf(stateBySession.get(carrierOf(session))).length;
  // Escape twice in a row opens Claude Code's history picker, and this button
  // outlives its own effect by the moment the status takes to arrive.
  if (Date.now() - stopSentAt < STOP_LOCKOUT_MS) {
    showToast('Escape already sent - a second one opens the history picker.');
    return;
  }
  // Escape does not leave the queue alone - what waits is due to go next, not
  // to be cancelled, which is the opposite of what the word "Stop" suggests.
  // So with a queue it is asked about rather than taken at face value.
  if (waiting > 0 && !window.confirm(
    `Escape interrupts the running turn. The ${waiting} waiting message(s) are not cancelled by it - they are due to be sent next. Continue?`,
  )) return;
  if (!sendKey('Escape')) {
    showError('The terminal is not ready yet - open the terminal tab once, then try again.');
    return;
  }
  stopSentAt = Date.now();
});

// One step, never a jump to a named mode: Shift+Tab cycles, and where it
// landed is said by the next permission-mode line rather than by counting
// steps against a list of modes that can change.
conversationModeEl.addEventListener('click', () => {
  const state = stateBySession.get(carrierOf(session));
  if (!sendKey('Tab', false, true)) {
    showError('The terminal is not ready yet - open the terminal tab once, then try again.');
    return;
  }
  if (state) state.modeAsked = state.permissionMode;
  renderMode(state);
});

// ---------- the card that answers an open box ----------

// Two sources, one card, and neither can do the other's job. The hook says
// WHAT is being asked - the question with its options, the whole plan, the
// tool and its arguments - and it fires for all three kinds of box. The pane
// says which KEY picks which option, which the payload cannot: the box carries
// options the model never offered ("Type something.", "allow reading from …
// during this session").
//
// Three layers and none of them needs the one above it. Without the hook the
// mirrored box still stands and its keys still work; without a recognised
// numbering the raw keys still go out; and either way the terminal keeps its
// own box, because the hook answers `escalate`.
//
// `permission_suggestions` is deliberately nowhere on the card. It is ABSENT
// rather than empty for a question and for a plan confirmation - the concept
// does not apply there - so anything showing it would have to say something
// about a field it must not read as "none were offered"; and where it does
// exist, the box already carries it as an option, verbatim and next to the key
// that picks it.

// How long an answer waits for the box to change before the card says the keys
// went nowhere. The pane redraws seconds late, so a shorter clock would call a
// keystroke that did arrive a failure.
const DIALOG_GRACE_MS = 6000;
// And the earliest second look worth taking after one, for the same reason: a
// capture straight after a keypress still shows the state from before it.
const DIALOG_LOOK_MS = 1500;
// What of a tool's arguments fits on one line of a title. A Bash command runs
// to whatever was written; all of it is in the mirror below.
const MAX_TITLE_DETAIL = 160;
// What is offered when the pane's numbering came back empty - an open box this
// module recognised nothing in. Bare keys and no labels, because a label here
// would be an invention: a box numbers its options from 1, and one it has no
// option for is one it ignores.
const RAW_KEYS = ['1', '2', '3'];

let refreshingDialog = false;
let answering = false;
// The same idea as readNo above, for this view's other read: only a look that
// STARTED after the keys went out may report on them (see settleAnswer).
let dialogReadNo = 0;

function dialogIsOpen(state) {
  return Boolean(state?.dialog?.open) && !state.gone;
}

// The box's identity, and deliberately not its text: `mirrored` is the whole
// pane and changes with every spinner frame, so it can say nothing about
// whether this is still the same box. What can: whether one is open at all,
// what it offers, and when the hook last reported one. The last of those is
// what tells two identical boxes apart - a denied Read the model retries
// produces the same options twice, and without it an answer to the first would
// hold the card locked over the second.
//
// A label is folded out of the pane at whatever width the pane had, so the same
// box at two widths marks differently. That is the identity being right about
// what it can see, not too strict: the answer is to keep the card young, which
// is what the look on a resize below is for.
function dialogMark(state) {
  return JSON.stringify([
    Boolean(state?.dialog?.open),
    (state?.dialog?.options ?? []).map((option) => [option.key, option.label]),
    state?.held?.at ?? null,
  ]);
}

// A keystroke is on its way until the box changes - or until the grace has
// passed with a look behind it, which is the evidence and not the clock: while
// no read has landed, nothing has been checked. Same shape as the take-back
// lock above, and necessary for the same reason: the pane's delay would let a
// second tap pass the gate on the picture from before the first one.
const answerLate = (state) => Boolean(state?.answered?.checked)
  && Date.now() - state.answered.at > DIALOG_GRACE_MS;
const answerPending = (state) => Boolean(state?.answered) && !answerLate(state);

function settleAnswer(state, readAt) {
  const lock = state.answered;
  if (!lock) return;
  // A different box, or none at all: the keys did what they were sent for and
  // there is nothing left to say.
  if (dialogMark(state) !== lock.mark) {
    state.answered = null;
    return;
  }
  if (readAt > lock.readAt) lock.checked = true;
}

// A tool's name on its own says nothing about what is being asked, so the one
// argument that identifies the call travels beside it. The keys and their
// order mirror DETAIL_KEYS in src/lib/toolDetail.js, which answers the same
// question for the tool cards a few pixels above this one - copied rather
// than imported because the browser cannot reach a module under src/, and
// named differently because this one does something that belongs to a title
// and not to the shared question: it cuts.
const DETAIL_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'description'];
// The two whose informative end is the LAST one. Cutting a path from the back
// leaves the directory and drops the file name - the one thing the title
// exists to say - while a command says what it is in its first word.
const TAIL_KEYS = ['file_path', 'path'];

function titleDetail(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value !== 'string' || !value) continue;
    if (value.length <= MAX_TITLE_DETAIL) return value;
    return TAIL_KEYS.includes(key)
      ? `…${value.slice(-MAX_TITLE_DETAIL)}`
      : `${value.slice(0, MAX_TITLE_DETAIL)}…`;
  }
  return null;
}

// From the hook and never from the pane: no rule for where the question sits
// holds across the box shapes, which is why readDialog returns no question at
// all. With no hook payload the sentence says only what the pane itself proves
// - that something is being asked - and the mirror below says what.
function dialogTitle(held) {
  if (!held) return 'The session is asking for confirmation';
  if (held.toolName === 'AskUserQuestion') {
    // The first question and no attempt at the rest: whether the tool ever
    // sends several, and whether the box then shows them one after another or
    // together, is unmeasured - and a title assembled for a shape nobody has
    // seen would be a guess where the mirror below is the fact.
    return held.toolInput?.questions?.[0]?.question ?? 'A question';
  }
  if (held.toolName === 'ExitPlanMode') return 'Ready to execute this plan';
  const detail = titleDetail(held.toolInput);
  return detail ? `${held.toolName} · ${detail}` : held.toolName;
}

// The plan as it was written, not as it is rendered: this is markdown from the
// payload and there is no server render for it here, and inventing one in the
// browser would put an unsanitized document on the page.
function planOf(held) {
  if (held?.toolName !== 'ExitPlanMode') return null;
  return typeof held.toolInput?.plan === 'string' ? held.toolInput.plan : null;
}

// The key and the box it was read off travel together: a card can stand for
// five seconds after its box has been answered elsewhere, and the next box
// numbers its own options - so a button says which box it is the answer to,
// and answer() refuses if that is no longer the one standing.
function dialogButton(key, label, className, mark) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => { answer(key, mark).catch(() => {}); });
  return button;
}

// One writer for the card, like renderQueue beside it, and it rebuilds only
// when what it says changes: the card carries the buttons that answer the box,
// and replacing those under a thumb on the poll's tick would swallow the tap.
function renderDialog(state) {
  const open = dialogIsOpen(state);
  conversationDialogEl.hidden = !open;
  if (!open) {
    delete conversationDialogEl.dataset.mark;
    conversationDialogEl.replaceChildren();
    return;
  }
  const locked = answerPending(state);
  const late = answerLate(state);
  const title = dialogTitle(state.held);
  const plan = planOf(state.held);
  // What waits behind the box, because nothing else on screen says it any
  // more: the queue box is hidden for as long as this card stands, and Stop -
  // which task 10 relied on to carry the same signal - is hidden too, since a
  // session holding a box open is `waiting` rather than `busy`. So the count
  // moves onto the card that displaced them.
  const waiting = waitingOf(state).length;
  const boxMark = dialogMark(state);
  const mark = JSON.stringify([carrierOf(session), boxMark, title, plan, locked, late, waiting]);
  if (conversationDialogEl.dataset.mark === mark) return;
  conversationDialogEl.dataset.mark = mark;
  // Set here rather than in the markup: the element is shared with nothing
  // else, but it is empty and nameless whenever no box is open.
  conversationDialogEl.setAttribute('role', 'group');
  conversationDialogEl.setAttribute('aria-label', 'What the session is asking');

  const heading = document.createElement('div');
  heading.className = 'conversation-dialog-title';
  heading.textContent = title;

  const options = state.dialog.options;
  // The card's height depends on nothing but the ceiling on this box: neither
  // a foldout opened inside it nor a title four lines long moves the rows
  // below, which is why the title sits in here rather than pinned above.
  const body = document.createElement('div');
  body.className = 'conversation-dialog-body';
  // What is being asked scrolls separately from what answers it, and the two
  // shares add up to that ceiling. Sharing one scroller, the answers are what
  // leaves the screen: the explanation is the part whose length varies, and a
  // plan or a long path is enough to push every button past the bottom edge.
  // So the fixed share is the explanation's and the rest is theirs.
  const explain = document.createElement('div');
  explain.className = 'conversation-dialog-explain';
  explain.append(heading);
  if (plan) {
    const planNode = document.createElement('pre');
    planNode.className = 'conversation-dialog-plan';
    planNode.textContent = plan;
    explain.append(planNode);
  }
  // Always mirrored, never only interpreted - but folded away once the keys
  // are known, because then it is the safety net rather than the content, and
  // this column has no height for both. A box nothing was recognised in has
  // nothing else to show, so there it stands open.
  const mirror = document.createElement('pre');
  mirror.className = 'conversation-dialog-mirror';
  mirror.textContent = state.dialog.mirrored;
  if (options.length) {
    const details = foldout('Show the box as it stands in the terminal', mirror);
    // The box is at the BOTTOM of the pane, under whatever else is on screen.
    // On the toggle rather than at build time: a closed <details> has no laid
    // out height to scroll to, so the card would open at the start banner.
    details.addEventListener('toggle', () => { explain.scrollTop = explain.scrollHeight; });
    explain.append(details);
  } else {
    explain.append(mirror);
  }
  body.append(explain);

  // Enter and Esc last and outside the scroller: whatever the box turns out to
  // be, confirming the selection and backing out of it are the two things it
  // answers to - a plan confirmation advertises neither and does both.
  const escapes = document.createElement('div');
  escapes.className = 'conversation-dialog-keys';
  // Marked like the numbered buttons, and for the same reason: Enter confirms
  // whatever box is standing, so out of a card that has gone stale it is the
  // one key with no label to give the mistake away.
  escapes.append(
    dialogButton('Enter', 'Enter', 'btn-quiet conversation-dialog-key', boxMark),
    dialogButton('Escape', 'Esc', 'btn-quiet conversation-dialog-key', boxMark),
  );

  // A locked-out button is replaced by the reason, never left there to be
  // tapped into nothing - the rule the queue box follows too. Which is why the
  // numbered buttons are built here and not with the explanation above: built
  // there they would ride out the lock unreachable by that rule but perfectly
  // tappable.
  const nodes = [body];
  // Before the rows that are tapped, so those stay at the bottom edge where a
  // thumb reaches them.
  if (waiting) nodes.push(hintNode(`${waiting} message(s) waiting behind this box.`));
  if (locked) {
    nodes.push(hintNode('Answered - waiting for the terminal to confirm it.'));
  } else {
    const list = document.createElement('div');
    list.className = 'conversation-dialog-options';
    const keys = options.length ? options : RAW_KEYS.map((key) => ({ key, label: null }));
    for (const { key, label } of keys) {
      list.append(dialogButton(
        key,
        label === null ? key : `${key} · ${label}`,
        'btn-surface btn-lift conversation-dialog-option',
        boxMark,
      ));
    }
    body.append(list);
    nodes.push(escapes);
  }
  if (late) nodes.push(hintNode('Sent, and the box is still standing - the terminal took those keys somewhere else.'));
  conversationDialogEl.replaceChildren(...nodes);
  // A box nothing was recognised in has its whole text on screen and the keys
  // under it; the interesting end of a pane is the bottom one.
  if (!options.length) explain.scrollTop = explain.scrollHeight;
}

// The pane, read for the card. Its own reader beside refuseSend's and
// promptIsClear's, because it is the only one of the three that wants the
// reading itself rather than a verdict - and because the card and the buttons
// on it have to be looking at the same answer.
async function readPaneDialog(carrier) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/pane`);
    if (res.status === 404) return { gone: true };
    if (!res.ok) return {};
    const pane = await res.json();
    // An absent key reads as "no box open", the same way refuseSend takes it:
    // an older server without the field must not put a card on the screen.
    return {
      dialog: pane.dialog ?? { open: false, options: [], mirrored: '' },
      // `null` is an answer (an idle pane says nothing), `undefined` is not -
      // an older server without the field must leave the line as it stands.
      status: 'status' in pane ? pane.status : undefined,
    };
  } catch {
    return {};
  }
}

// What the hook reported, if it fired. A read that fails leaves the last
// payload standing rather than clearing it: no answer means unknown, not "no
// content for this box", and the card would otherwise lose its title to one
// missed request.
//
// A 404 is not one of those. It says this server holds no permission state
// for this session at all - a session it never started, which therefore never
// had a hook - and that is an answer: no payload, rather than none that could
// be read. The difference decides whether a key may go out at all, since
// answering refuses on a payload it could not refresh (see answer) and the
// box's own keys work without a hook by design.
async function readHeldDialog(carrier) {
  try {
    const res = await fetch(`/api/permission/${encodeURIComponent(carrier)}`);
    if (res.status === 404) return { held: null };
    if (!res.ok) return {};
    return { held: (await res.json()).dialog ?? null };
  } catch {
    return {};
  }
}

// Both sources on every tick, with no session status in front of them. The box
// is exactly what the registry calls `waiting`, so gating on that status would
// be cheaper - but a status this view has not been told about would then leave
// the card off the screen for the one control that cannot be worked around
// from this tab, and nothing on screen would say so. The cost of the other way
// round is one capture-pane per tick while this tab is open and in front.
async function refreshDialog() {
  const carrier = carrierOf(session);
  if (!carrier) return;
  const state = stateFor(carrier);
  if (refreshingDialog) return;
  refreshingDialog = true;
  const readAt = dialogReadNo + 1;
  dialogReadNo = readAt;
  try {
    const [pane, hook] = await Promise.all([readPaneDialog(carrier), readHeldDialog(carrier)]);
    if (!sameView(carrier, state)) return;
    // Silent, like the poll's own non-404 path: a banner over the conversation
    // for one missed tick would be worse than the tick. A session that has
    // gone away is reported by the transcript read instead, which has the more
    // careful rule for saying so - and which runs on the same tick.
    // Before the early return below: a read that came back without a dialog
    // still came back, and the line has nothing to do with the card.
    if (pane.status !== undefined) renderStatus(pane.status);
    if (!pane.dialog) return;
    state.dialog = pane.dialog;
    if ('held' in hook) state.held = hook.held;
    // The store holds at most the box that is standing. Nothing else clears
    // it: a dialog answered in the terminal leaves the hook's payload behind,
    // and the next box the hook fails to report would then be drawn with the
    // previous one's title. Done here and not when a key goes out, because a
    // key can miss and the box then stays.
    if (!state.dialog.open && state.held) {
      state.held = null;
      fetch(`/api/permission/${encodeURIComponent(carrier)}`, { method: 'DELETE' }).catch(() => {});
    }
    settleAnswer(state, readAt);
    renderDialog(state);
    showComposer(state);
  } finally {
    refreshingDialog = false;
  }
}

// A resize is not one more tick, it is the event that makes the card wrong: the
// terminal resizes with the window, tmux with the terminal, and Claude Code
// redraws the box at the new width - where readDialog folds a wrapped label at
// a different place and the same box marks differently (see dialogMark). Left
// to the poll, someone who turns the phone to read a long path taps a key that
// is still exactly right and is told the card is out of date. So the redraw is
// followed instead of waited out.
//
// A few of them rather than one at a chosen moment: the chain leaves the
// browser and comes back on a capture, so any single delay is a guess at how
// long tmux and Claude Code take - and a look that is early reads the old
// width and settles nothing. The spread is covered instead, out to the delay a
// keystroke waits, with the poll as the backstop behind it. Rearmed from the
// LAST resize, because a rotation fires a whole run of them.
//
// Only while a card stands, so a dragged window costs a capture-pane in no
// other state. The other way the width moves has no event here at all: a
// second client on the same session changes it through
// `tmux window-size latest`, and for that the poll is all there is.
const DIALOG_RESIZE_LOOKS_MS = [250, 750, 1500];
let resizeLooks = [];

function cardStands() {
  return dialogIsOpen(stateBySession.get(carrierOf(session)));
}

window.addEventListener('resize', () => {
  for (const look of resizeLooks) clearTimeout(look);
  resizeLooks = DIALOG_RESIZE_LOOKS_MS.map((ms) => setTimeout(() => {
    if (cardStands()) refreshDialog().catch(() => {});
  }, ms));
});

// A keypress can land nowhere, and it can land somewhere else: the box may
// have been answered in the terminal since the card was drawn, and the next
// one may already be standing in its place - a session with a box open is
// `waiting` rather than busy, so the card carries the buttons it was drawn
// with for as long as the idle tick. So the pane is read again right before
// the keys go out, and a check that cannot be made refuses here the way the
// take-back does - a key sent into no box lands on the input line as a
// character, and the next send from here pastes into that same line.
//
// `mark` is the box the tapped button was drawn for (see dialogButton). It is
// the half of the question that "is a box open" cannot answer: a `1` meant for
// "Blau" grants a permission that was not on screen when the thumb came down.
async function answer(key, mark) {
  const carrier = carrierOf(session);
  // Read, never created: a click on a control the view never showed must not
  // put an entry in the map.
  const state = stateBySession.get(carrier);
  // The lock as well as the flag: the flag covers the read this call makes,
  // the lock covers the redraw the terminal still owes. Checked here and not
  // only in the renderer, because a node built before the lock went up is
  // still a node that can be tapped.
  if (!carrier || !state || answering || answerPending(state)) return;
  answering = true;
  try {
    // Both sources, the same pair refreshDialog reads - and that is the point
    // of the pair here. The mark is three things, and the payload's timestamp
    // is the one of them that tells two boxes with the same options apart.
    // Read the pane alone and two thirds of the mark are fresh while that
    // third is whatever the last tick left behind, which for a session with a
    // box open is the idle cadence: a box answered in the terminal and
    // replaced by its own retry would compare equal, and the key would go into
    // the box nobody read.
    const [read, hook] = await Promise.all([readPaneDialog(carrier), readHeldDialog(carrier)]);
    // The session can have been swapped while that was in flight, and the
    // iframe with it - the keys would land in another session's terminal.
    if (!sameView(carrier, state)) return;
    if (read.gone) {
      showError('This session is gone - pick another one in the list.');
      return;
    }
    if (!read.dialog) {
      showError('The terminal could not be read just now - nothing was sent. Try again in a moment.');
      return;
    }
    state.dialog = read.dialog;
    if (!read.dialog.open) {
      // Answered in the terminal meanwhile. The card goes, and the key does
      // not: it would be typed into whatever the box left behind.
      state.answered = null;
      renderDialog(state);
      showComposer(state);
      showToast('Already answered in the terminal.');
      return;
    }
    // Only with the box still standing, so the payload is never cleared from
    // here: refreshDialog owns that half - it clears the store as well as the
    // state, and it does so on the evidence that no box is open.
    if (!('held' in hook)) {
      // Unlike the failed read above, this one leaves the payload standing
      // (see readHeldDialog) - so refusing is the only way to say that the
      // discriminator could not be refreshed. A key sent on an unrefreshed one
      // is exactly the send this pair exists to prevent.
      showError('The terminal could not be read just now - nothing was sent. Try again in a moment.');
      return;
    }
    state.held = hook.held;
    if (dialogMark(state) !== mark) {
      // The card is not this box any more - either another one is standing,
      // or this one was redrawn at a width that folds its labels differently.
      // The pane cannot tell those two apart and neither can this; what it can
      // say is that the card the thumb came down on is out of date, which is
      // true of both. The payload goes with it - kept, it would put the old
      // question's title over the new box's buttons - and the tick started
      // here brings back whatever holds, the same payload included if the box
      // never changed.
      state.held = null;
      renderDialog(state);
      showToast('The card was out of date - nothing was sent. Check it and tap again.');
      refreshDialog().catch(() => {});
      return;
    }
    if (!sendKey(key)) {
      showError('The terminal is not ready yet - open the terminal tab once, then try again.');
      return;
    }
    state.answered = {
      mark: dialogMark(state),
      at: Date.now(),
      // The last look handed out before the keys left, so one already in
      // flight cannot answer for them (see settleAnswer).
      readAt: dialogReadNo,
      checked: false,
    };
    // Straight away, so the buttons are gone before a second tap can reach
    // them - the pane says the box is answered a redraw later, if at all.
    renderDialog(state);
    setTimeout(() => {
      if (carrierOf(session) === carrier) refreshDialog().catch(() => {});
    }, DIALOG_LOOK_MS);
  } finally {
    answering = false;
  }
}
