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
  return foldout(title, event.resultLoaded
    ? preNode(event.result ?? '')
    : noteNode('Still running…'));
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

// ---------- the stream ----------

function showNotice(text) {
  const notice = document.createElement('div');
  notice.className = 'conversation-notice';
  notice.textContent = text;
  conversationStreamEl.replaceChildren(notice);
}

function render() {
  const state = stateFor(carrierOf(session));
  if (!state.events.length) {
    showNotice('No conversation yet - send the first message.');
    return;
  }
  conversationStreamEl.replaceChildren(...state.events.map(eventNode));
  // Opens at the end, like the terminal does: the newest turn is the one
  // being waited for.
  conversationStreamEl.scrollTop = conversationStreamEl.scrollHeight;
}

async function loadTail() {
  const carrier = carrierOf(session);
  const res = await fetch(`/api/sessions/${encodeURIComponent(carrier)}/conversation?tail=1`);
  // Nothing switched tabs or sessions while the request was in flight? Every
  // return below checks, because both write to the shared stream element.
  if (carrier !== carrierOf(session)) return;
  if (res.status === 404) {
    // No transcript yet, or the session is gone from the store. Either way
    // there is nothing to show, and the first message is what creates it.
    showNotice('No conversation yet - send the first message.');
    return;
  }
  const data = await (await checkResponse(res)).json();
  if (carrier !== carrierOf(session)) return;
  const state = stateFor(carrier);
  state.events = data.events;
  state.from = data.from;
  state.offset = data.offset;
  state.atStart = data.atStart;
  state.chainAnchor = data.chainAnchor;
  state.transcriptId = data.transcriptId;
  render();
}

export function showConversation(nextSession) {
  session = nextSession;
  conversationPanelEl.hidden = false;
  conversationJumpEl.hidden = true;
  conversationDialogEl.hidden = true;
  conversationQueueEl.hidden = true;
  const carrier = carrierOf(session);
  // No session, no composer. Hidden rather than disabled: a disabled Send
  // still claims there is a way to answer from here and it is merely
  // unavailable, while there is nothing to answer until a session is picked
  // - and the notice below already says so.
  conversationComposerEl.hidden = !carrier;
  if (!carrier) {
    showNotice('No session open - pick one in the list.');
    return;
  }
  // What was loaded before stays on screen while the fresh read is in
  // flight, so coming back to this tab doesn't blank it first.
  if (stateFor(carrier).events.length) render();
  else showNotice('Loading the conversation…');
  loadTail().catch((err) => showError(err.message));
}

export function leaveConversation() {
  conversationPanelEl.hidden = true;
  session = null;
}

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
