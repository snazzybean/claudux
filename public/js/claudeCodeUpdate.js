// The "Claude Code" section in the System tab: installed version, its own
// release notes, and the automatic-update toggle. No restart-follow loop
// like update.js's - a background install here never needs one, so there
// is nothing to poll beyond the one request while it runs.
import {
  claudeCodeVersionEl, claudeCodeCheckedEl, claudeCodeReasonEl, claudeCodeNotesEl,
  claudeCodeCheckBtnEl, claudeCodeAutoToggleEl,
} from './dom.js';

const POLL_MS = 1500;

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
  const failed = info.lastResult === 'failed';
  claudeCodeReasonEl.hidden = !failed;
  claudeCodeReasonEl.textContent = failed ? (info.error ?? 'The last check failed.') : '';
  claudeCodeNotesEl.hidden = !info.current;
  if (info.current) claudeCodeNotesEl.href = `https://github.com/anthropics/claude-code/releases/tag/v${info.current}`;
  claudeCodeAutoToggleEl.checked = info.autoUpdateEnabled;
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
}
