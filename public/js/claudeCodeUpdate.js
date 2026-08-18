// The "Claude Code" section in the System tab: installed version, its own
// release notes, and the automatic-update toggle. No restart-follow loop
// like update.js's - a background install here never needs one, so there
// is nothing to poll beyond the one request while it runs.
import {
  claudeCodeVersionEl, claudeCodeCheckedEl, claudeCodeInstallEl, claudeCodeReasonEl, claudeCodeNotesEl,
  claudeCodeCheckBtnEl, claudeCodeAutoToggleEl,
} from './dom.js';
import { showToast } from './messages.js';

const POLL_MS = 1500;
const SILENT_POLL_MS = 5 * 60 * 1000;

let lastKnownVersion = null;

async function load(path = '', method = 'GET', body) {
  const res = await fetch(`/api/claude-update${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function render(info) {
  claudeCodeVersionEl.textContent = info.current ? `Version ${info.current}` : 'Version unknown';
  claudeCodeCheckedEl.textContent = info.lastRunAt
    ? `Last checked ${new Date(info.lastRunAt).toLocaleString()}`
    : 'Not checked yet';
  claudeCodeInstallEl.textContent = info.installMethod ? `Installation: ${info.installMethod}` : '';
  const failed = info.lastResult === 'failed';
  claudeCodeReasonEl.hidden = !failed;
  claudeCodeReasonEl.textContent = failed ? (info.error ?? 'The last check failed.') : '';
  claudeCodeNotesEl.hidden = !info.current;
  if (info.current) claudeCodeNotesEl.href = `https://github.com/anthropics/claude-code/releases/tag/v${info.current}`;
  claudeCodeAutoToggleEl.checked = info.autoUpdateEnabled;
  lastKnownVersion = info.current;
}

async function pollSilently() {
  try {
    const info = await load();
    if (lastKnownVersion !== null && info.current !== null && info.current !== lastKnownVersion) {
      showToast(`Claude Code updated to ${info.current}`);
    }
    render(info);
  } catch {
    // Same tolerant rule as everywhere else in this module - a failed
    // background poll is not worth surfacing.
  }
}

async function pollUntilDone() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const status = await load('/status');
    if (status.phase !== 'running') return;
  }
}

async function runCheck() {
  claudeCodeCheckBtnEl.disabled = true;
  try {
    await load('', 'POST');
    await pollUntilDone();
    render(await load());
  } catch {
    // The button re-enabling is feedback enough here - no dedicated error
    // banner for a background feature nobody has to act on.
  } finally {
    claudeCodeCheckBtnEl.disabled = false;
  }
}

export function initClaudeCodeUpdate() {
  claudeCodeCheckBtnEl.addEventListener('click', () => { runCheck(); });
  claudeCodeAutoToggleEl.addEventListener('change', async () => {
    await load('/toggle', 'POST', { enabled: claudeCodeAutoToggleEl.checked }).catch(() => {});
  });

  load().then(render).catch(() => {
    // No answer means no display update - the same rule update.js follows.
  });
  setInterval(pollSilently, SILENT_POLL_MS);
}
