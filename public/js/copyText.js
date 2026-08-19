// Terminal text for selecting. The keybar's copy button used to fetch the
// tmux buffer instead - which stays inevitably empty on the phone, because
// there's no way into tmux' copy mode there: mouse mode is off, Claude Code
// sits on the alternate screen with no scrollback, and a finger drag in the
// terminal gets turned into a scroll event by attachTouchScroll.
//
// The button instead opens a menu above the keybar. Anyone who just needs
// the whole screen copies straight from there; anyone who wants to pick out
// a spot opens the text view and selects there with a finger - magnifier,
// selection handles, and scrolling all come from the device.
import {
  copyMenuAllEl,
  copyMenuViewEl,
  copyMenuEl,
  copyMenuVersionEl,
  copyMenuCloseEl,
  copyMenuStatusEl,
  copyTextPanelEl,
  copyTextContentEl,
  copyTextCloseEl,
  copySelectionBtnEl,
  overlayMenuEl,
} from './dom.js';
import { checkResponse, showError } from './messages.js';

// Both versions arrive in one response (see the route), so the toggle
// doesn't need a second request.
// `raw` and `clean` are the JSON keys the server returns from
// GET /api/sessions/:id/pane.
let versions = { raw: '', clean: '' };
let showClean = true;

// Feedback inside the menu itself instead of via toast: the menu sits at
// the bottom near the thumb, and a toast at the other end of the screen
// wouldn't be where the eye is at that moment.
let statusTimer = null;
function report(text) {
  copyMenuStatusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { copyMenuStatusEl.textContent = ''; }, 2600);
}

function currentText() {
  return showClean ? versions.clean : versions.raw;
}

function render() {
  copyTextContentEl.textContent = currentText() || 'The terminal is empty.';
  copyMenuVersionEl.textContent = `View: ${showClean ? 'Clean' : 'Raw'}`;
  copyMenuVersionEl.setAttribute('aria-pressed', String(!showClean));
}

async function fetchText(sessionId) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pane`);
  await checkResponse(res);
  versions = await res.json();
  render();
}

// The text is fetched already when the menu OPENS, not only once "Copy all"
// is tapped. Safari only grants navigator.clipboard.writeText() within a
// fresh user gesture, and an `await fetch` in between consumes it - the copy
// would then fail even though everything is available.
export function toggleCopyMenu(sessionId) {
  if (!copyMenuEl.hidden) {
    closeCopyMenu();
    return;
  }
  copyMenuEl.hidden = false;
  copySelectionBtnEl.setAttribute('aria-expanded', 'true');
  report('');
  fetchText(sessionId).catch((err) => {
    closeCopyMenu();
    showError(`Could not fetch terminal text: ${err.message}`);
  });
}

export function closeCopyMenu() {
  copyMenuEl.hidden = true;
  copySelectionBtnEl.setAttribute('aria-expanded', 'false');
}

// The terminal is covered, not hidden: a display change on the iframe costs
// xterm a reflow (see forceTerminalReflow in terminal.js).
function showView(on) {
  copyTextPanelEl.hidden = !on;
}

export function leaveCopyText() {
  showView(false);
  closeCopyMenu();
}

copyMenuViewEl.addEventListener('click', () => {
  showView(true);
  closeCopyMenu();
});

copyMenuAllEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentText());
    report('Copied.');
  } catch (err) {
    // Include err.name in the message: on iOS there's no reachable console,
    // this is the only trace left.
    report(`Failed: ${err.name}`);
  }
});

copyMenuVersionEl.addEventListener('click', () => {
  showClean = !showClean;
  render();
});

copyMenuCloseEl.addEventListener('click', leaveCopyText);
copyTextCloseEl.addEventListener('click', leaveCopyText);

// A tap next to the menu closes it - but only the menu, not the view.
// Anyone selecting text in the view will inevitably tap outside it.
//
// The copy button is excluded because it toggles itself: otherwise this
// pointerdown would close the menu, and its own click would immediately
// reopen it.
document.addEventListener('pointerdown', (event) => {
  if (copyMenuEl.hidden) return;
  if (copyMenuEl.contains(event.target)) return;
  if (copySelectionBtnEl.contains(event.target)) return;
  // This menu can also be opened from the ··· menu - without this
  // exception, that menu's pointerdown would close what its click is just
  // about to open.
  if (overlayMenuEl.contains(event.target)) return;
  closeCopyMenu();
});
