// The update card in the sidebar and the "Version" section in the settings.
// Both read the same route; the card only appears once a newer release
// actually exists.
import {
  updateCardEl, updateTitleEl, updateNotesEl, updateBtnEl, updateReasonEl,
  systemVersionEl, systemCheckedEl, systemReasonEl, systemCheckBtnEl,
  sidebarToggleEl,
} from './dom.js';
import { showToast } from './messages.js';

const POLL_MS = 3000;
const RESTART_TIMEOUT_MS = 120_000;
const BUTTON_LABEL = 'Update & restart';

let info = null;

async function load(path = '', method = 'GET') {
  const res = await fetch(`/api/update${path}`, { method });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function renderCard() {
  const show = Boolean(info?.updateAvailable);
  updateCardEl.hidden = !show;
  // The card folds away with .sidebar-body when the sidebar is collapsed;
  // the dot on the toggle is what remains visible then (see styles.css).
  sidebarToggleEl.classList.toggle('has-update', show);
  if (!show) return;

  updateTitleEl.textContent = `Update to ${info.latest}`;
  updateNotesEl.hidden = !info.notesUrl;
  if (info.notesUrl) updateNotesEl.href = info.notesUrl;
  updateBtnEl.disabled = !info.canUpdate;
  // A disabled control without an explanation reads as a defect.
  updateReasonEl.hidden = Boolean(info.canUpdate);
  updateReasonEl.textContent = info.canUpdate ? '' : info.reason;
}

function renderSystem() {
  if (!info) return;
  systemVersionEl.textContent = info.updateAvailable
    ? `Version ${info.current} — ${info.latest} available`
    : `Version ${info.current}`;
  systemCheckedEl.textContent = info.checkedAt
    ? `Last checked ${new Date(info.checkedAt).toLocaleString()}`
    : 'Not checked yet';
  systemReasonEl.hidden = Boolean(info.canUpdate) || !info.reason;
  systemReasonEl.textContent = info.reason ?? '';
}

function setPhase(text) {
  updateBtnEl.disabled = true;
  updateBtnEl.textContent = text;
}

function releaseButton() {
  updateBtnEl.disabled = false;
  updateBtnEl.textContent = BUTTON_LABEL;
}

// Success is "the route answers again AND reports the new version". The job
// state lives in memory and dies with the process, so /status knows nothing
// after the restart - and a service that never comes back looks exactly like
// a slow one from here.
async function waitForRestart(target) {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      const next = await load();
      if (next.current === target.replace(/^v/, '')) {
        location.reload();
        return;
      }
    } catch {
      // Still restarting.
    }
  }
  setPhase('Restart not confirmed');
  showToast('The restart was not confirmed — check the terminal.');
}

async function follow(target) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    let status;
    try {
      status = await load('/status');
    } catch {
      // The restart has begun and the server is gone - from here on the
      // version is what decides.
      await waitForRestart(target);
      return;
    }
    if (status.phase === 'failed') {
      releaseButton();
      updateReasonEl.hidden = false;
      updateReasonEl.textContent = status.error;
      return;
    }
    if (status.phase === 'restart-required') {
      setPhase('Restart required');
      return;
    }
    if (status.phase === 'restarting') {
      setPhase('Restarting…');
      await waitForRestart(target);
      return;
    }
    setPhase(status.phase === 'installing' ? 'Installing…' : 'Fetching…');
  }
}

async function runUpdate() {
  const target = info.latest;
  setPhase('Updating…');
  try {
    await load('', 'POST');
  } catch (err) {
    releaseButton();
    showToast(err.message);
    return;
  }
  await follow(target);
}

export function initUpdate() {
  updateBtnEl.addEventListener('click', () => { runUpdate(); });
  systemCheckBtnEl.addEventListener('click', async () => {
    systemCheckBtnEl.disabled = true;
    try {
      info = await load('/check', 'POST');
      renderCard();
      renderSystem();
    } catch (err) {
      showToast(err.message);
    } finally {
      systemCheckBtnEl.disabled = false;
    }
  });

  load().then((state) => {
    info = state;
    renderCard();
    renderSystem();
  }).catch(() => {
    // No answer means no message - the same rule the server follows.
  });
}
