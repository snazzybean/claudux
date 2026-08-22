// Everything Claudux does directly to the ttyd iframe - and that's more than
// it looks: xterm.js runs there in its own document which, while
// same-origin, knows nothing about its surroundings. Every function here
// therefore reaches in deliberately instead of using an interface that
// doesn't exist.
import { focusHolderEl, keybarEl, keybarMoreBtnEl, terminalFrameEl } from './dom.js';
import { checkResponse, showError, showToast } from './messages.js';
import { attachPathLinks } from './terminalLinks.js';

// xterm.js' fit addon hooks into a ResizeObserver on its container, not a
// window resize listener. A synthetic `resize` event therefore does
// NOTHING: a ResizeObserver only reacts to actual element size changes, and
// without one the terminal doesn't reach the right edge.
//
// So we nudge the iframe's own box size for a moment (1px narrower, then
// back) - a real, if tiny, reflow. Right after `load` this often isn't
// enough, because the surrounding layout hasn't finished settling yet;
// hence a second attempt after the next frame.
export function forceTerminalReflow() {
  const el = terminalFrameEl;
  if (el.style.display === 'none') return;
  const prevWidth = el.style.width;
  el.style.width = 'calc(100% - 1px)';
  requestAnimationFrame(() => {
    el.style.width = prevWidth;
  });
}

// Detaches this device from the session without ending it: the iframe loads
// an empty document, ttyd's websocket closes, and tmux loses this client.
// The tmux session and the conversation inside it keep running.
//
// Why this is more than cleanup: tmux sizes the pane after the most
// recently USED client (`window-size latest`). If phone and laptop are
// attached to the same session at once, its width flips on every device
// switch - and Claude Code rebuilds its history on every size change, which
// gets more expensive the longer the conversation runs. Releasing a device
// is the way out; without this button the only options were closing the
// tab or opening a different session.
export function releaseTerminal() {
  stopReconnectWatcher(); // otherwise the watchdog immediately sends an Enter and reattaches
  terminalFrameEl.src = 'about:blank';
}

// Whether ttyd's xterm is really up in there. Not `term` alone: the object
// shows up before its buffer does, and a caller acting on it that early sees a
// terminal that has not been fitted yet.
export function terminalIsAttached() {
  return Boolean(terminalFrameEl.contentWindow?.term?.buffer);
}

terminalFrameEl.addEventListener('load', () => {
  const doc = terminalFrameEl.contentDocument;
  // After releasing, an empty document loads here: nothing to measure, no
  // handlers to attach, and no xterm element the reconnect watchdog could
  // ever find.
  //
  // We check the address, not the content: ttyd builds its document with
  // Preact at runtime, so testing for a specific element would have been
  // tied to its timing - and a failed check would have silently disabled
  // paste, copy, swipe, and the watchdog along with it.
  if (doc?.location.href === 'about:blank') return;
  forceTerminalReflow();
  requestAnimationFrame(forceTerminalReflow);
  attachImagePasteHandler();
  if (doc) {
    attachCopyShortcut(doc);
    lockTerminalGestures(doc);
    attachTouchScroll(doc);
    attachReconnectWatcher(doc);
    attachPathLinksWhenReady();
  }
});

// ---------- Mobile: more terminal columns on narrow screens ----------
// xterm.js' default font (15px) gets only about 40 columns on a phone in
// portrait - Claude Code's borders, tables, and diffs wrap unreadably at
// that width. Smaller font = more columns at the same pixel width.
//
// Deliberately client-side instead of ttyd's own `-t fontSize=` flag: a
// single ttyd process serves laptop and phone at once, so an option set
// there would hit both - and would need a Claudux restart, which disrupts
// every open terminal.
const MOBILE_BREAKPOINT = '(max-width: 720px)'; // matches the media query in styles.css
const MOBILE_FONT_SIZE = 11;
const DESKTOP_FONT_SIZE = 15; // xterm.js default; ttyd doesn't set its own value
const mobileQuery = window.matchMedia(MOBILE_BREAKPOINT);

export function terminalFontSize() {
  return mobileQuery.matches ? MOBILE_FONT_SIZE : DESKTOP_FONT_SIZE;
}

// ---------- Terminal in the palette color ----------
//
// CSS doesn't reach across the iframe boundary: `--term-bg` only colors the
// frame. The background INSIDE the terminal belongs to xterm, and its theme
// option is the only way to reach it.
//
// This always happens, not just when the toggle is on: without this path,
// ttyd's own gray stayed in the terminal while the frame around it carried
// a different tone - visible as soon as no terminal was loaded. The toggle
// only decides WHICH color both carry together.
//
// The colors are read from the CSS variables rather than tracked here -
// which ones currently apply is decided jointly by the palette and the
// terminal toggle, and that resolution happens in styles.css.
//
// Background and foreground only: the sixteen ANSI colors stay ttyd's own.
// Claude Code colors its output through exactly those, and a palette would
// have to supply all of them to avoid becoming less readable than before.
function terminalColors() {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue('--term-bg').trim();
  const foreground = style.getPropertyValue('--term-fg').trim();
  if (!background || !foreground) return null;
  return { background, foreground };
}

// Recolors an already-open terminal without reloading it - a reload would
// reattach tmux and cost a rebuild of the history.
// Access point is the same as for font size: the `window.term` ttyd
// exposes.
//
// Existing values are carried over, not replaced: `options.theme` also
// carries the ANSI colors, and an assignment without them would fall back
// to xterm's defaults.
export function applyTerminalColors() {
  const term = terminalFrameEl.contentWindow?.term;
  const colors = terminalColors();
  if (!term || !colors) return;
  term.options.theme = { ...term.options.theme, ...colors };
}

// Besides `arg`, ttyd reads arbitrary further query parameters as client
// options and applies them through its own fit addon - the intended way to
// set these per client, without reaching into the iframe DOM. `-a` forwards
// only the parameter named `arg` as a command-line argument, so none of
// these reach attach.sh.
//
// `scrollback=0` isn't a memory-saving measure but the only way to get rid
// of the stripe on the right of the terminal: xterm's fit addon reserves
// scrollbar width whenever scrollback is on and calculates columns against
// what's left. Nothing is lost by it - Claude Code occupies the alternate
// screen, where there's no xterm viewport to scroll anyway (see
// NAMED_KEY_CODES for how its own history is paged instead).
//
// The ORDER of the parameters is load-bearing, not a matter of taste:
// ttyd's applyPreferences() walks the options in insertion order and calls
// `fitAddon.fit()` only for names starting with "font". It sets
// `scrollback` silently, without recalculating the columns. If scrollback
// came after fontSize, the one and only fit() run would still account for
// the reserved scrollbar, and the gain would only show up at the next real
// size change (rotating the device).
//
// `theme` gets along with this: ttyd recognizes from the existing option
// that an object is expected, parses it with JSON.parse, and layers it over
// the existing theme - so the ANSI colors survive this path too.
export function withTerminalOptions(url) {
  const separator = url.includes('?') ? '&' : '?';
  const colors = terminalColors();
  const theme = colors ? `&theme=${encodeURIComponent(JSON.stringify(colors))}` : '';
  return `${url}${separator}scrollback=0&fontSize=${terminalFontSize()}${theme}`;
}

// Rotating the device changes the viewport width and thus the fitting font
// size. Reloading the iframe for that would reattach tmux - no content
// loss, but a visible flicker. Instead we change the option directly on the
// terminal instance ttyd exposes (`window.term`, the same access point as
// in pasteTextIntoTerminal()) and then trigger a real size change via
// forceTerminalReflow(): xterm's fit addon hangs off a ResizeObserver (see
// its comment above), recalculates columns/rows against the new cell
// dimensions, and reports the geometry to tmux over the ttyd websocket.
mobileQuery.addEventListener('change', () => {
  const term = terminalFrameEl.contentWindow?.term;
  if (!term) return; // no terminal open, or iframe not usable yet
  term.options.fontSize = terminalFontSize();
  forceTerminalReflow();
  requestAnimationFrame(forceTerminalReflow);
});

// ---------- Swiping through history with a finger ----------
//
// Claude Code has mouse event reporting active and scrolls its own
// conversation history as soon as it gets mouse wheel events. That's why
// the wheel has long worked on a laptop - nothing happens on a phone,
// because xterm.js doesn't translate swipe gestures into wheel events on
// its own while an application occupies the alternate screen (there's no
// viewport to scroll there, see the PageUp/PageDown keys in index.html).
//
// This gap gets closed here: swiping in the terminal iframe is translated
// into `wheel` events, which xterm.js then turns into SGR sequences for
// Claude Code just like a real mouse wheel. Same approach as sendKey() and
// the image paste handler - synthetic events aimed deliberately at the
// same-origin iframe, instead of reaching past ttyd's internals.
//
// Direction deliberately "natural": dragging a finger down brings earlier
// content into view, same as scrolling anywhere else on a phone.
const TOUCH_SCROLL_THRESHOLD = 12; // px of finger travel before a wheel event fires

// The touchmove guard in app.js stops at the iframe boundary, so the
// terminal document gets its own rule. `manipulation` rather than `none`:
// pinch zoom is worth most on 11px terminal text, and only double-tap zoom
// was in the way. New document on every `load`, hence re-run there like the
// paste handler.
function lockTerminalGestures(doc) {
  const style = doc.createElement('style');
  style.textContent = 'html, body { touch-action: manipulation; overscroll-behavior: none; }';
  doc.head?.appendChild(style);
}

export function attachTouchScroll(doc) {
  let lastY = null;

  doc.addEventListener(
    'touchstart',
    (event) => {
      // Single-finger gestures only: two fingers means zoom/select, and a
      // synthetic scroll has no business there.
      lastY = event.touches.length === 1 ? event.touches[0].clientY : null;
    },
    { passive: true },
  );

  doc.addEventListener(
    'touchmove',
    (event) => {
      if (lastY === null || event.touches.length !== 1) return;
      // Before the threshold, not after it: the browser claims a gesture on
      // the first movement, and from then on it pans the whole app around
      // the keyboard no matter what happens here.
      event.preventDefault();
      const y = event.touches[0].clientY;
      const dy = lastY - y;
      // Ignore small movements, otherwise a mere tremor on tap would
      // trigger a scroll.
      if (Math.abs(dy) < TOUCH_SCROLL_THRESHOLD) return;
      lastY = y;
      // xterm.js attaches its wheel listener to the terminal element;
      // `bubbles` makes sure the event still reaches it even if it sits one
      // level above the target chosen here.
      const target = doc.querySelector('.xterm-screen') || doc.querySelector('.xterm') || doc.body;
      target.dispatchEvent(
        new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }),
      );
    },
    { passive: false },
  );

  doc.addEventListener('touchend', () => { lastY = null; }, { passive: true });
  doc.addEventListener('touchcancel', () => { lastY = null; }, { passive: true });
}

// ttyd builds `window.term` asynchronously via Preact after fetching its
// token - the same reason attachReconnectWatcher() below polls for `.xterm`
// instead of checking once. `term` typically exists slightly earlier than
// the DOM element does (it's constructed before being rendered), but there
// is no guarantee it's already there exactly at `load`, so this polls too
// rather than risk silently registering nothing on a slow connection.
function attachPathLinksWhenReady() {
  const term = terminalFrameEl.contentWindow?.term;
  if (term) return attachPathLinks(term);
  let attempts = 0;
  const poll = window.setInterval(() => {
    const t = terminalFrameEl.contentWindow?.term;
    if (t) {
      window.clearInterval(poll);
      attachPathLinks(t);
    } else if ((attempts += 1) > 25) {
      window.clearInterval(poll); // give up after 5s, same cap as the reconnect watchdog
    }
  }, 200);
}

// xterm.js can't process images from the clipboard on its own. The paste
// event is therefore intercepted directly IN the iframe document, not in
// the parent - the paste happens with focus in the terminal. Every `load`
// creates a new iframe document, so re-registering on each `load` is
// necessary; the old listener disappears with the old document.
//
// IMPORTANT: the capture phase (`true`) is the actual trick here. xterm.js
// registers its own paste listener on the xterm-helper-textarea and calls
// `stopPropagation()` in it - a listener on `document` in the bubble phase
// would NEVER see the event. The capture phase runs the other way, from
// document down to the target and before its own listeners. On an image we
// then call stopPropagation() ourselves, so xterm's handler never sees it
// at all.
export function attachImagePasteHandler() {
  const doc = terminalFrameEl.contentDocument;
  if (!doc) return; // iframe not usable same-origin yet, see sendKey()
  doc.addEventListener(
    'paste',
    async (event) => {
      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      if (!imageItem) return; // normal text paste - xterm.js keeps handling it itself
      event.preventDefault();
      event.stopPropagation(); // prevents xterm's own (bubble-phase) handler for this event
      const blob = imageItem.getAsFile();
      if (!blob) return;
      await uploadImageAndPaste(blob);
      // The upload takes time, and iOS' own paste menu may have taken focus
      // away from xterm's input field in the meantime. Reclaiming it here
      // restores the input target - though it won't bring back an already
      // collapsed on-screen keyboard.
      returnFocusToTerminal();
    },
    true,
  );
}

// Claude Code can work with a file path, not with image data in the
// terminal - so the image goes to the server and only its path goes into
// the terminal. Shared by the paste handler above and the keybar's paste
// button.
async function uploadImageAndPaste(blob) {
  try {
    const res = await fetch('/api/uploads/image', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    await checkResponse(res);
    const { path: uploadedPath } = await res.json();
    if (pasteTextIntoTerminal(uploadedPath)) showToast('Image uploaded – path inserted into terminal.');
    else showError(`Image is at ${uploadedPath} – but no terminal is open.`);
  } catch (err) {
    showError(`Image upload failed: ${err.message}`);
  }
}

// Paste via the keybar. There's no key combination for this on a phone,
// and xterm.js can't process images on its own anyway (see paste handler
// above).
//
// Order: check for an image first, then text. clipboard.read() needs
// explicit permission in some browsers and can fail where readText() still
// works - so it deliberately falls back to the text path instead of giving
// up entirely.
//
// EVERY outcome reports itself, including a failure of read(). As long as
// that stayed silent and readText() afterwards just returned an empty
// string - the normal case with an image on the clipboard - a failure on
// the phone was indistinguishable from "button missed". `err.name` is
// included in the message: there's no reachable console on iOS, so the
// message is the only trace.
export async function pasteFromClipboard() {
  moveFocusToMainDocument();
  let readError = null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        await uploadImageAndPaste(await item.getType(imageType));
        returnFocusToTerminal();
        return;
      }
    }
  } catch (err) {
    readError = `${err.name}: ${err.message}`;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text) showError(readError ? `Clipboard not readable – ${readError}` : 'Clipboard is empty.');
    else if (!pasteTextIntoTerminal(text)) showError('No terminal open – open a session first.');
  } catch (err) {
    showError(`Paste failed: ${err.name}: ${err.message}`);
  }
  returnFocusToTerminal();
}

// The browser's clipboard functions require the MAIN document to have
// focus. As long as typing happened in the ttyd iframe, focus sits there -
// `writeText`/`read` then fail with "Document is not focused".
//
// The route goes through an input field instead of `window.focus()`,
// because otherwise the on-screen keyboard collapses on a phone: iOS keeps
// it up only while focus moves between editable elements. `window.focus()`
// doesn't belong to such an element and thus ends it - and after the first
// `await` the user gesture that a reopen depends on is spent.
function moveFocusToMainDocument() {
  focusHolderEl.focus({ preventScroll: true });
}

// ...and back again afterwards, otherwise you'd type into nothing after
// every copy.
//
// The target is xterm's hidden input field, not the iframe window:
// `contentWindow.focus()` only sets the document's focus and may leave no
// element active inside it at all - that's not an editable target for iOS,
// and the keyboard would stay closed. The window is the fallback in case
// xterm hasn't been built yet.
function returnFocusToTerminal() {
  const input = terminalFrameEl.contentDocument?.querySelector('.xterm-helper-textarea');
  if (input) input.focus({ preventScroll: true });
  else terminalFrameEl.contentWindow?.focus();
}

// Via xterm's public `Terminal.paste(text)` method, reachable on the
// `window.term` ttyd exposes. A synthetic paste ClipboardEvent would be the
// obvious route, but it doesn't work across browsers: Firefox leaves
// `event.clipboardData` at `null` for synthetic events, and xterm's own
// handler then silently skips it.
//
// The return value says whether the text actually arrived. Without it, the
// image upload reported success even though nothing was inserted when no
// terminal was open.
export function pasteTextIntoTerminal(text) {
  const term = terminalFrameEl.contentWindow?.term;
  if (!term) return false; // iframe not usable same-origin yet, see sendKey()
  term.paste(text);
  return true;
}

// xterm.js evaluates keys primarily via the LEGACY `keyCode` field, not the
// modern `key`. But `new KeyboardEvent(...)` always yields `keyCode === 0`
// for that, because KeyboardEventInit no longer knows the field. So
// `keyCode` has to be added afterwards via Object.defineProperty on the
// concrete event instance, so synthetic keyboard events reach a legacy
// consumer like xterm.js.
const NAMED_KEY_CODES = {
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Enter: 13,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  // Scrolling through conversation history: Claude Code runs in the
  // alternate screen and keeps its own history - there is no tmux
  // scrollback to page through, but it responds to these two keys.
  PageUp: 33,
  PageDown: 34,
};

export function keyCodeFor(key) {
  if (key in NAMED_KEY_CODES) return NAMED_KEY_CODES[key];
  // Single letters/digits: for A-Z the classic keyCode matches the ASCII
  // code of the uppercase letter (e.g. 'c' -> 67), which xterm.js uses for
  // Ctrl combinations.
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

// Sends a synthetic KeyboardEvent into the terminal iframe (ttyd/xterm.js).
// xterm.js doesn't capture keyboard input globally on document, but on a
// hidden <textarea class="xterm-helper-textarea"> that it moves focus to
// itself when the terminal is focused. So doc.activeElement should normally
// already be this textarea once the user has clicked into the terminal -
// but we deliberately fall back to it if activeElement happens to be
// something else for any reason (e.g. not focused yet), instead of sending
// the event untargeted to doc.body.
//
// Reports whether the event reached the iframe at all, the same way
// pasteTextIntoTerminal() does: right after a load there is no document for a
// moment, and a control that silently does nothing is worse than one that
// visibly fails. The keybar ignores the answer - a key that goes nowhere is
// pressed again - but the composer in the conversation view says so.
export function sendKey(key, ctrl, shift) {
  const doc = terminalFrameEl.contentDocument;
  // The terminal and not just the document: an iframe on about:blank has one -
  // after "release the terminal", and for a moment after every load - and
  // nothing in it listens, so a document alone would report a key as sent.
  if (!doc || !terminalFrameEl.contentWindow?.term) return false;
  const target =
    doc.activeElement && doc.activeElement !== doc.body
      ? doc.activeElement
      : (doc.querySelector('textarea.xterm-helper-textarea') || doc.body);
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: Boolean(ctrl),
    // Shift+Tab switches Claude Code's working mode - the terminal's status
    // line points this out itself. Without this flag, a plain Tab would
    // arrive there instead.
    shiftKey: Boolean(shift),
    bubbles: true,
    cancelable: true,
  });
  // keyCode/which aren't settable in the modern constructor (always 0) -
  // override them deliberately on the instance, see comment above.
  const code = keyCodeFor(key);
  Object.defineProperty(event, 'keyCode', { get: () => code });
  Object.defineProperty(event, 'which', { get: () => code });
  target.dispatchEvent(event);
  return true;
}

// [data-key]: deliberately separates the "real" key buttons from the
// separately wired #copySelectionBtn (wired in app.js), which doesn't want a
// sendKey() call.
document.querySelectorAll('.keybar button[data-key]').forEach((btn) => {
  // Prevents a click on the keybar from taking focus away from the
  // terminal iframe (otherwise the user's second input would land in the
  // button instead of the terminal).
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    sendKey(btn.dataset.key, btn.dataset.ctrl === 'true', btn.dataset.shift === 'true');
  });
});

// The bar stays single-row by default: two rows cost height that's already
// tight on a phone with the keyboard open. Anyone who needs the left/right
// arrows expands it; the state isn't remembered.
//
// Same focus guard as the key buttons. It would otherwise only live on the
// [data-key] loop above, and anyone who skips that skips both: without it,
// the first tap on "expand" would collapse the on-screen keyboard - right
// when the arrows are needed.
keybarMoreBtnEl.addEventListener('mousedown', (e) => e.preventDefault());
keybarMoreBtnEl.addEventListener('click', () => {
  const expanded = keybarEl.dataset.expanded !== 'true';
  keybarEl.dataset.expanded = String(expanded);
  keybarMoreBtnEl.setAttribute('aria-expanded', String(expanded));
  // The second row takes height away from the terminal. xterm's fit addon
  // hangs off a ResizeObserver and won't hear about it without a real size
  // change on the iframe - it would keep the old dimensions.
  forceTerminalReflow();
  requestAnimationFrame(forceTerminalReflow);
});

// Mouse mode is off in tmux. Selecting therefore doesn't go through a
// browser/xterm selection, but through tmux's own copy mode or Claude
// Code's copy function - both end up in the SERVER-global tmux buffer.
// `term.getSelection()` is structurally the wrong source for this path;
// there's never anything in it.
//
// The missing last mile (tmux buffer -> real clipboard) is normally handled
// by the terminal emulator via OSC-52; the installed ttyd version predates
// the commit that taught xterm that. A ttyd upgrade would be the complete
// fix, but that's a separate undertaking.
//
// This function bridges that mile itself: reads the tmux buffer via
// GET /api/tmux-buffer and writes it to the real clipboard via the
// Clipboard API - in the PARENT window, where a click carries real user
// activation. A real mouse-drag selection managed by xterm.js itself is
// NOT covered by this.
//
// `auto` mode: the call comes after EVERY Ctrl+C, not only after an actual
// copy - Ctrl+C without a selection is a normal SIGINT. Without the
// comparison against `lastKnownBuffer`, cancelling any command would show a
// "copied" toast with stale content. Only a real user action should give
// feedback even for an empty clipboard.
let lastKnownBuffer = null;
async function copyTerminalSelection({ auto = false } = {}) {
  try {
    const res = await fetch('/api/tmux-buffer');
    if (res.status === 404) {
      if (!auto) showToast('Nothing to copy – first copy something in the terminal (e.g. Ctrl+C with a selection).');
      return;
    }
    await checkResponse(res);
    const { text } = await res.json();
    if (auto && text === lastKnownBuffer) return; // probably just a SIGINT, not a new copy
    lastKnownBuffer = text;
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard.');
  } catch (err) {
    if (!auto) showError(`Copy failed: ${err.message}`);
  }
}

const pasteBtn = document.getElementById('pasteBtn');
pasteBtn.addEventListener('click', pasteFromClipboard);

// Copying should be ONE keystroke, not Ctrl+C followed by Cmd+C. Ctrl+C
// keeps passing through untouched - tmux needs the real key (see above).
// Instead, after a short delay, we check whether the buffer changed: the
// WebSocket round trip to tmux and the processing there take a moment.
// Cmd+C also remains as an immediate way to copy again without pressing
// Ctrl+C a second time.
export function attachCopyShortcut(doc) {
  doc.addEventListener(
    'keydown',
    (event) => {
      if (event.key.toLowerCase() !== 'c') return;
      if (event.metaKey) {
        // Has no other function in the terminal (browsers/xterm.js don't
        // send it as a control character to the process) - safe to
        // intercept.
        event.preventDefault();
        event.stopPropagation();
        copyTerminalSelection();
        return;
      }
      if (event.ctrlKey) {
        setTimeout(() => copyTerminalSelection({ auto: true }), 300);
      }
    },
    true,
  );
}

// ---------- Reconnecting without pressing Enter ----------
//
// If the phone sleeps or the network switches, ttyd's websocket drops and
// the terminal shows "Press ⏎ to Reconnect" - a dead end on a phone: the
// on-screen keyboard is collapsed at that point, and the keybar below
// deliberately has no Enter.
//
// Why no ttyd option solves this: `onSocketClose` only reconnects on its
// own if the close code isn't 1000 AND `doReconnect` still holds; otherwise
// it shows the overlay and waits for Enter. The only knob
// (`disableReconnect`) turns off the automatic branch, not the Enter
// branch - and a sleeping phone falls into exactly that one.
//
// So from the outside: as soon as ttyd's overlay shows the prompt, we send
// the Enter ourselves, via a synthetic keystroke into the iframe just like
// the keybar. ttyd attaches its handler directly via `terminal.onKey(...)`,
// not through its own `register()` - it survives the preceding `dispose()`
// and accepts the key.
//
// The overlay is a classless <div> with plain inline styles that the
// OverlayAddon attaches directly to the xterm element. That makes it
// unambiguous to find without searching the terminal content for text -
// where "⏎" could at any time also be real output.
const RECONNECT_MARKER = '⏎'; // appears in exactly one of the overlay messages
const RECONNECT_SUCCESS = 'Reconnected'; // shown by ttyd after a successful connection
// ttyd's own single attempt, see the stuck watchdog below. Does not collide
// with RECONNECT_SUCCESS: "Reconnected" doesn't contain "Reconnecting".
const RECONNECTING_MARKER = 'Reconnecting';
const RECONNECT_MAX_ATTEMPTS = 3;
// First attempt immediately - the network is usually back as soon as the
// phone is back in hand. The two stragglers cover the case where wifi or
// mobile data need a few more seconds.
const RECONNECT_DELAYS = [0, 1500, 4000];
// Probation period for a new connection, see startReconnectProbation().
// Longer than the delays above, so a reset can't fall in the middle of a
// still-running attempt sequence.
const RECONNECT_PROBATION_MS = 5000;
// Grace before a stuck overlay counts as stuck, then between attempts. A
// healthy reconnect shows "Reconnecting..." for a few dozen milliseconds, so
// the first entry only ever expires on a dead one. The others grow because a
// failed attempt means the network isn't back yet. Then the overlay stays
// and waits for a tap, rather than reloading forever.
const RECONNECT_STUCK_DELAYS = [1000, 4000, 8000];

let reconnectXtermObserver = null;
let reconnectOverlayObserver = null;
let reconnectPollInterval = null;
let reconnectTimer = null;
let reconnectProbationTimer = null;
let reconnectStuckTimer = null;
let reconnectAttempts = 0;
let reconnectRecoveries = 0;
let reconnectDoc = null;
let stuckTerminalRecovery = null;

// Finds the overlay div, if it's currently shown.
function reconnectOverlayEl() {
  // A reload swaps the frame's document, but this watcher keeps pointing at
  // the old one until the `load` handler reattaches it - and a detached
  // document still answers queries, with the state that made us reload.
  // Reading it would count as "still stuck" and reload again.
  if (reconnectDoc !== terminalFrameEl.contentDocument) return null;
  const xterm = reconnectDoc?.querySelector('.xterm');
  if (!xterm) return null;
  return (
    Array.from(xterm.children).find((child) => child.tagName === 'DIV' && !child.hasAttribute('class')) || null
  );
}

function isReconnectPromptShown() {
  return Boolean(reconnectOverlayEl()?.textContent?.includes(RECONNECT_MARKER));
}

// Every overlay state that means "not connected", whether or not something
// is still trying. What the probation has to be free of to count.
function isDisconnectedShown() {
  const text = reconnectOverlayEl()?.textContent || '';
  return text.includes(RECONNECT_MARKER) || text.includes(RECONNECTING_MARKER);
}

// The one overlay state nothing gets out of on its own.
//
// ttyd fires exactly one automatic attempt, `refreshToken().then(connect)`,
// and `refreshToken()` is a fetch with no timeout. A phone waking up finds a
// half-open network path rather than a refused one: the fetch never settles,
// `connect()` is never reached, and the overlay sits there forever - even
// once the network is back. No close event follows, so no observer fires
// again either, and the "⏎" the Enter watchdog waits for never appears.
//
// Deliberately NOT the "⏎" prompt after our attempts are used up, even
// though that one sits there just as permanently: a tap resolves it (see
// the pointerdown handler), and it appears precisely when ttyd is reachable
// but the session behind it is not - where reloading the frame produces an
// error page with no terminal in it at all, and takes the tap away too.
function isTerminalStuck() {
  return Boolean(reconnectOverlayEl()?.textContent?.includes(RECONNECTING_MARKER));
}

// Set by app.js (see setStuckTerminalRecovery) rather than imported: the
// only way out of a stuck overlay is a reload of the frame, and only the
// resume route can say what to reload to - a dead session needs a new one,
// not a reattach to its corpse.
export function setStuckTerminalRecovery(fn) {
  stuckTerminalRecovery = fn;
}

function armStuckWatchdog() {
  if (reconnectStuckTimer) return; // already counting
  if (reconnectRecoveries >= RECONNECT_STUCK_DELAYS.length) return; // allowance spent
  reconnectStuckTimer = window.setTimeout(runStuckRecovery, RECONNECT_STUCK_DELAYS[reconnectRecoveries]);
}

function cancelStuckWatchdog() {
  window.clearTimeout(reconnectStuckTimer);
  reconnectStuckTimer = null;
}

async function runStuckRecovery() {
  reconnectStuckTimer = null;
  if (document.visibilityState !== 'visible') return; // rearmed on return, see below
  if (!isTerminalStuck()) return;
  try {
    // Only an explicit false means the attempt never reached the resume
    // route - on return from the background the wake path holds the same
    // guard for a moment, and burning an attempt on that would leave fewer
    // for the seconds where the network actually comes back. A failed route
    // call and a reload that didn't help both count: they were attempts.
    if ((await stuckTerminalRecovery?.()) !== false) reconnectRecoveries += 1;
  } catch {
    reconnectRecoveries += 1;
  }
  // Rearmed unconditionally rather than checked here: a reload is
  // asynchronous, so a check at this point still reads the old document.
  // The timer looks once the reload has had its chance - and if it worked,
  // the `load` handler has replaced this watcher and cancelled the timer.
  armStuckWatchdog();
}

function resetReconnect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  cancelReconnectProbation();
  cancelStuckWatchdog();
  reconnectAttempts = 0;
}

// `Reconnected` only proves ttyd's websocket is up, not that a session is
// behind it - with the tmux session gone, attach.sh exits right after. Both
// allowances therefore only refill once the connection has survived a grace
// period without a disconnected overlay coming back.
//
// Also started for every fresh attach, not just for ttyd's `Reconnected`:
// that message needs `opened` to be true already, so a reload - which builds
// a new client with `opened` false - never produces one, and the reload
// allowance would never refill.
function startReconnectProbation() {
  if (reconnectProbationTimer) return; // already running
  reconnectProbationTimer = window.setTimeout(() => {
    reconnectProbationTimer = null;
    if (isDisconnectedShown()) return;
    reconnectAttempts = 0;
    reconnectRecoveries = 0;
  }, RECONNECT_PROBATION_MS);
}

// If the prompt comes back, the connection was worthless: end the
// probation without touching the allowance.
function cancelReconnectProbation() {
  window.clearTimeout(reconnectProbationTimer);
  reconnectProbationTimer = null;
}

// Attempts are deliberately hard-capped. If the tmux session is gone,
// attach.sh exits immediately, the websocket closes again, and the overlay
// reappears - an unbounded watchdog would turn this into an infinite loop,
// hitting ttyd's token route on every pass. After three attempts the
// prompt stays put and waits for a tap (see below).
function triggerReconnect() {
  if (document.visibilityState !== 'visible') return; // don't touch anything in the background
  if (reconnectTimer || reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) return;
  const delay = RECONNECT_DELAYS[reconnectAttempts];
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    // In the meantime the connection may have come back on its own, or the
    // app may be in the background - in that case the Enter would be a
    // real input into a running Claude Code session.
    if (document.visibilityState !== 'visible' || !isReconnectPromptShown()) return;
    sendKey('Enter');
  }, delay);
}

function checkReconnectOverlay() {
  const text = reconnectOverlayEl()?.textContent || '';
  if (text.includes(RECONNECT_SUCCESS)) {
    cancelStuckWatchdog();
    startReconnectProbation();
    return;
  }
  if (text.includes(RECONNECT_MARKER)) {
    cancelReconnectProbation();
    cancelStuckWatchdog();
    triggerReconnect();
    return;
  }
  if (text.includes(RECONNECTING_MARKER)) {
    cancelReconnectProbation();
    armStuckWatchdog();
    return;
  }
  // Anything else is the size display or an empty overlay: nothing hangs.
  cancelStuckWatchdog();
}

// The previous watchdog hangs off a document that no longer exists after a
// session switch. Standalone, because releasing needs the same cleanup
// without setting up a new watchdog.
function stopReconnectWatcher() {
  reconnectXtermObserver?.disconnect();
  reconnectOverlayObserver?.disconnect();
  reconnectXtermObserver = null;
  reconnectOverlayObserver = null;
  window.clearInterval(reconnectPollInterval);
  reconnectPollInterval = null;
  resetReconnect();
  reconnectDoc = null;
}

export function attachReconnectWatcher(doc) {
  stopReconnectWatcher();
  reconnectDoc = doc;

  // Two observers instead of one on `doc.body`: a subtree observer on the
  // body would fire on EVERY rendered terminal row - many times per second
  // during a running Claude Code turn, the most expensive spot possible on
  // a phone. `childList` on the xterm element, in contrast, only reports
  // the overlay being attached and detached; the second observer then
  // hangs off exactly that element and reports its text changes
  // ("Connection Closed" -> "Press ⏎ to Reconnect" runs purely through
  // textContent without a DOM rebuild, a childList observer would see
  // nothing of that).
  const attachToXterm = (xterm) => {
    const bindOverlay = () => {
      const overlay = reconnectOverlayEl();
      if (!overlay) return;
      reconnectOverlayObserver?.disconnect();
      reconnectOverlayObserver = new MutationObserver(checkReconnectOverlay);
      reconnectOverlayObserver.observe(overlay, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      checkReconnectOverlay();
    };
    reconnectXtermObserver = new MutationObserver(bindOverlay);
    reconnectXtermObserver.observe(xterm, { childList: true });
    // Run it once by hand too: a MutationObserver only reports what happens
    // AFTER observe(). But exactly the worst case attaches the overlay
    // earlier - if the tmux session is already gone, attach.sh exits
    // immediately, and the prompt is already there in the document while
    // the polling loop above is still running. Without this call the
    // observer would never fire, because "Press ⏎" is a terminal state:
    // nothing gets attached to the xterm element after that.
    //
    // The call is safe to repeat: ttyd's OverlayAddon creates its <div>
    // exactly once in the constructor and always reattaches the same one,
    // so binding again hits the same node. And checkReconnectOverlay() does
    // nothing while "Connection Closed" or a size display like "80x24" is
    // showing there.
    bindOverlay();
    // A fresh attach is a connection attempt like any other and has to
    // prove itself the same way - see startReconnectProbation().
    startReconnectProbation();
  };

  // ttyd only builds its terminal after fetching its token - so `.xterm`
  // isn't necessarily in the document yet at the iframe's `load`. Hence a
  // brief poll instead of checking exactly once.
  const xtermNow = doc.querySelector('.xterm');
  if (xtermNow) {
    attachToXterm(xtermNow);
  } else {
    let attempts = 0;
    reconnectPollInterval = window.setInterval(() => {
      const xterm = doc.querySelector('.xterm');
      if (xterm) {
        window.clearInterval(reconnectPollInterval);
        reconnectPollInterval = null;
        attachToXterm(xterm);
      } else if ((attempts += 1) > 25) {
        window.clearInterval(reconnectPollInterval); // give up after 5s
        reconnectPollInterval = null;
      }
    }, 200);
  }

  // Fallback: a tap into the terminal triggers the Enter, as long as the
  // prompt is showing. This also works after the three automatic attempts
  // and is then the only way back that doesn't require an on-screen
  // keyboard.
  // Capture phase, because the overlay itself intercepts pointer events
  // (its mousedown handler calls preventDefault/stopPropagation, also in
  // the capture phase).
  doc.addEventListener(
    'pointerdown',
    () => {
      if (!isReconnectPromptShown()) return;
      resetReconnect(); // a tap is intentional, not an automatic run
      reconnectRecoveries = 0; // and it earns a fresh reload allowance too
      sendKey('Enter');
    },
    { capture: true, passive: true },
  );
}

// Coming back from the background is the most common moment the prompt
// gets noticed at all: while the phone was asleep, the observer kept
// running, but `triggerReconnect()` did nothing because of the visibility
// gate. The allowance starts fresh again here - the app coming back to the
// foreground is a user action, not a loop.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (isReconnectPromptShown()) {
    resetReconnect();
    triggerReconnect();
    return;
  }
  // Read directly instead of waiting for the observer: if the connection
  // died while the phone was away, the overlay already says "Reconnecting..."
  // on return and nothing will mutate it ever again (see isTerminalStuck).
  if (isTerminalStuck()) armStuckWatchdog();
});
