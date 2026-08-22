// Sidebar, session management, and the interplay between the controls.
//
// What stays here hangs off the shared state further down (projects, open
// session, known accounts) - it is read and written by both display and
// flow alike, which is why the two stay together until this state gets a
// home of its own.
import {
  appEl,
  projectListEl,
  terminalFrameEl,
  searchInputEl,
  accountBadgeEl,
  usagePopoverEl,
  usageBackdropEl,
  agentWindowsEl,
  agentLinesEl,
  tabTerminalEl,
  tabFilesEl,
  tabConversationEl,
  backBtnEl,
  overlayGroupEl,
  overlayMenuBtnEl,
  overlayMenuEl,
  overlayMenuReleaseEl,
  overlayMenuTextEl,
  sidebarRailEl,
  authBannerEl,
  copySelectionBtnEl,
} from './js/dom.js';
import {
  showError,
  clearError,
  showToast,
  escapeHtml,
  formatRelativeTime,
  checkResponse,
} from './js/messages.js';
import {
  withTerminalOptions,
  releaseTerminal,
  terminalIsAttached,
  setStuckTerminalRecovery,
} from './js/terminal.js';
import { initUsage } from './js/usage.js';
import { initSubagents, startSubagentDebug } from './js/subagents.js';
import { initAgentWindows } from './js/agentWindows.js';
import { showFiles, leaveFiles } from './js/files.js';
import { showConversation, leaveConversation, noteSessionStatus, noteSessionRow } from './js/conversation.js';
import { initTerminalLinks } from './js/terminalLinks.js';
import { initUpdate } from './js/update.js';
import { initClaudeCodeUpdate } from './js/claudeCodeUpdate.js';
import { svg, svgNode } from './js/icons.js';
import { toggleCopyMenu, closeCopyMenu, leaveCopyText } from './js/copyText.js';
import { startEventStream } from './js/events.js';
import { initViewport } from './js/viewport.js';
import { initAppearance, setSidebarCollapsed } from './js/appearance.js';
import {
  initManageDialog,
  openManagement,
  renderProjectManagement,
  protectionWarning,
  closeManageDialog,
} from './js/manageDialog.js';
import { initOnboarding, updateOnboardingWizard } from './js/onboarding.js';
import {
  initAccounts,
  allAccounts,
  accountById,
  accountLabel,
  accountLoadFailed,
  accountsFingerprint,
  loadAccounts,
  resetWizard,
  showLoginBanner,
} from './js/accounts.js';

// The account area needs four things back from here; see the comment on
// initAccounts() for why they arrive as parameters instead of an import.
initAccounts({
  render: (filter) => render(filter),
  openLoginTerminal: (url) => openLoginTerminal(url),
  openManagement,
  closeManageDialog,
});

// The settings window reads the project model and hands every change back
// here, where the model lives and the sidebar is redrawn from it.
initManageDialog({
  allProjects: () => projects,
  changeSession: (project, session, changes) => changeSession(project, session, changes),
  removeProject: (project) => removeProject(project),
  setProjectDefaultAccount: (project, accountId) => setProjectDefaultAccount(project, accountId),
  toggleFavorite: (project) => toggleFavorite(project),
  loadProjects: () => loadProjects(),
});

initOnboarding({ openManagement });

// Every request in this page goes through here rather than through a helper
// each call site has to remember: a 401 means the session ended, and the
// answer to that is always the same - reload, whereupon the gate serves the
// login page under the url that is open.
//
// /access is left out. A 401 from there is a wrong password on the change
// form, not a lost session, and reloading would swallow the message.
{
  const nativeFetch = window.fetch.bind(window);
  let reloading = false;
  window.fetch = async (input, init) => {
    const res = await nativeFetch(input, init);
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (res.status === 401 && !reloading && !new URL(url, location.origin).pathname.startsWith('/access')) {
      reloading = true; // several requests can fail at once; one reload is enough
      location.reload();
    }
    return res;
  };
}

// Central data model: projects along with their sessions and the
// client-side expanded/collapsed state. The accordion and live search need
// a data source that can be re-rendered repeatedly, rather than DOM nodes
// built once – render() rebuilds the whole list from scratch on every change.
let projects = [];
let currentProject = null;
let currentSessionId = null;
// A login terminal has no session in the list, so currentSessionId stays
// null there (see openLoginTerminal). The text view still needs the tmux
// session, though: the login flow explicitly requires copying the printed
// token out of the terminal - on a phone that's simply not possible without
// the view.
let currentLoginSessionId = null;
// Controls the usage popover on the account pill, set at startup (see the
// initUsage call further down).
let usage = null;

// Shared by every caller of the resume route (resumeSession,
// restoreLastSession, the wake path in healOpenSessionOnReturn, and the
// crash-heal below): the route starts tmux processes, and two overlapping
// calls for the SAME name race - the second `new-session` fails on the name
// already being taken and leaves its 0600 token file on disk.
//
// Keyed per session id, not a single flag: a tap on a DIFFERENT session
// while one resume is in flight must go through normally - only two POSTs
// for the same name cause the leak this guards against, and a single flag
// would swallow that unrelated tap with no feedback at all.
const resumeInFlightIds = new Set();

// See the resume POST in healOpenSessionOnReturn() for why this one is
// bounded where the other calls to the route are not.
const RESUME_TIMEOUT_MS = 10000;

async function fetchProjectSessions(project) {
  const res = await fetch(`/api/projects/${project.id}/sessions`);
  await checkResponse(res);
  const { sessions } = await res.json();
  // Carry the auth hint of the OPEN session along. Without this the banner
  // only showed the state at the time it was opened – wrong in exactly the
  // normal case, since a login typically expires while the session sits
  // open on screen. The sidebar chip updates here anyway; applying the same
  // data to the banner costs nothing extra.
  //
  // Deliberately here and not in render(): render() also runs on every
  // keystroke in search, without any new server data being available.
  const openId = openSessionId(sessions);
  const open = sessions.find((s) => s.id === openId);
  if (open) {
    updateAuthBanner(open);
    // The pill for the same reason, and it needs it more: it shows the
    // account MEASURED on the process, so it has to follow the measurement
    // rather than the guess openSession() made from the resume response -
    // that response carries no account at all. Without this the pill kept
    // whatever was true when the session was opened, so switching accounts
    // from the popover left the old name standing until a reload.
    updateAccountBadge(open);
  }
  return sessions;
}

async function loadProjects({ still = false } = {}) {
  try {
    const res = await fetch('/api/projects');
    await checkResponse(res);
    const { projects: rawProjects } = await res.json();
    if (!still) clearError();
    projects = await Promise.all(
      rawProjects.map(async (p) => {
        const existing = projects.find((old) => old.id === p.id);
        let sessions = existing?.sessions ?? [];
        try {
          sessions = await fetchProjectSessions(p);
        } catch (err) {
          if (!still) showError(`Could not load sessions for "${p.name}": ${err.message}`);
        }
        // Mutate the existing object in place instead of spreading into a
        // new one: the click handler built by the last render() closes over
        // this exact object, and `open` lives on it as a plain property. A
        // fresh object here would silently orphan a click that landed
        // between this fetch and the reassignment below - toggle() would
        // flip `open` on an object render() never reads again, and the
        // project would need a second click to actually expand.
        if (existing) {
          Object.assign(existing, p, { sessions });
          return existing;
        }
        return { ...p, sessions, open: false };
      }),
    );
    // Before anything reads the new model: the fetched states go into the
    // map the dots are built from, so a rebuild below shows them too.
    absorbFetchedActivity();
    // And the conversation view gets the row again. It holds the object it
    // was entered with, whose `activity` is what its Stop button falls back
    // on until the status stream reports a CHANGE - a session that was
    // already working when this page loaded would otherwise keep that button
    // hidden for as long as it never changes state.
    if (appEl.dataset.tab === 'conversation') noteSessionRow(openSessionRow());
    // On the background tick, only rebuild if something actually changed:
    // render() replaces the whole sidebar, which closes any open select,
    // discards the scroll position, and ends edit mode. The time labels and
    // the dots still get refreshed either way - deliberately in place,
    // since neither is part of the signature.
    if (still && sessionSignature() === lastSignature) {
      updateTimes();
      updateActivityDots();
      return;
    }
    render(searchInputEl.value);
  } catch (err) {
    // A failed background tick stays silent: on the phone the connection
    // keeps dropping briefly, and an error message for something nobody
    // triggered would just be noise. The next tick catches it up.
    if (!still) showError(`Could not load projects: ${err.message}`);
  }
}

// Only server data that's actually VISIBLE. Deliberately without mtime:
// Claude Code writes to the JSONL file about once a second while replying,
// so the list would keep rebuilding itself constantly without anything
// visibly different to read.
function sessionSignature() {
  return JSON.stringify([
    projects.map((p) => [
      p.id,
      p.name,
      p.favorite,
      p.sessions.map((s) => [
        s.id,
        s.title,
        s.lastPrompt,
        s.live,
        s.authProblem?.kind ?? null,
        s.accountId,
        s.activeAccountId,
        s.hasToken,
        s.protected,
      ]),
    ]),
    accountsFingerprint(allAccounts()),
  ]);
}
let lastSignature = null;

// Rewrites "3 min ago" in place, without touching the list. The source is
// the model, not the DOM - the DOM would otherwise reflect the mtime from
// the last rebuild.
function updateTimes() {
  for (const project of projects) {
    for (const session of project.sessions) {
      const el = document.querySelector(`.session-row[data-session-id="${session.id}"] .session-time`);
      if (el) el.textContent = formatRelativeTime(session.mtimeMs);
    }
  }
}

// The last activity MEASURED for a session, against the one last FETCHED
// with the list. Those drift apart because the fetch is 15 seconds apart
// while the status stream reports every two, and because render() runs on
// plenty of paths that don't fetch at all - a keystroke in the search
// field, a favorite toggled, a session opened - each of those would
// otherwise throw away everything the stream had applied in between.
//
// Keyed under both ids the stream carries, for the same reason
// applyActivityState tries both below.
const measuredActivity = new Map();

// What a row or tile should show. The map wins: every fetch writes its own
// snapshot into it, so it is never the older of the two.
function activityOf(session) {
  return measuredActivity.get(session.id) ?? session.activity ?? null;
}

// Takes the fetched states over, and forgets the sessions that have ended -
// otherwise a resumed conversation would briefly wear the activity of its
// previous run. A live session the server knows nothing about keeps what
// the stream last said.
function absorbFetchedActivity() {
  const live = new Set();
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.live) continue;
      live.add(session.id);
      if (session.activity) measuredActivity.set(session.id, session.activity);
    }
  }
  for (const id of measuredActivity.keys()) if (!live.has(id)) measuredActivity.delete(id);
}

// Sets the dot of one row without rebuilding the list - the same in-place
// route as updateTimes(), for the same reason: a rebuild destroys the
// scroll position, an open select and the edit mode.
//
// Both ids are tried: after a /clear the row in the list is named
// differently from its carrier.
//
// Careful with "idle": the registry uses it for "waiting for input", the
// dot's data-state uses it for "session has ended". They are opposites, so
// the registry value never reaches the dom attribute unmapped.
function applyActivityState(tmuxSession, sessionId, state) {
  const dotState = state === 'busy' ? 'working' : 'waiting';
  for (const id of [sessionId, tmuxSession]) measuredActivity.set(id, dotState);
  // Here and not at the end of the function: the loop below returns as soon
  // as it has found a node, so anything after it runs only sometimes.
  updateProjectBusy();
  for (const id of [sessionId, tmuxSession]) {
    const dot = document.querySelector(`.session-row[data-session-id="${id}"] .dot`);
    // The collapsed sidebar shows the same session as a tile; it only ever
    // holds running ones, so it needs no ended-row guard.
    const railDot = document.querySelector(`.rail-tile[data-session-id="${id}"] .rail-dot`);
    // Only rows that are live carry a working/waiting dot - an ended row
    // stays muted, and overwriting it here would make it look alive.
    const rowIsLive = dot && dot.dataset.state !== 'idle';
    if (rowIsLive) dot.dataset.state = dotState;
    if (railDot) railDot.dataset.state = dotState;
    if (rowIsLive || railDot) return;
  }
}

// The dots after a fetch that changed nothing else. Same in-place route as
// updateTimes(), and needed for the same reason it is: the quiet tick is
// the only chance to correct a dot the stream missed, and rebuilding the
// list for it is exactly what the signature check avoids.
function updateActivityDots() {
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.live) continue;
      const state = activityOf(session);
      if (!state) continue;
      const dot = document.querySelector(`.session-row[data-session-id="${session.id}"] .dot`);
      if (dot && dot.dataset.state !== 'idle') dot.dataset.state = state;
      const railDot = document.querySelector(`.rail-tile[data-session-id="${session.id}"] .rail-dot`);
      if (railDot) railDot.dataset.state = state;
    }
  }
  updateProjectBusy();
}

// Whether anything is being produced inside this project. A collapsed
// project builds no session rows at all (see buildProjectElement), so the
// cone that reports a working session has nothing to run through - the
// project's own title takes it over while it stays collapsed.
function projectIsBusy(project) {
  return project.sessions.some((s) => s.live && activityOf(s) === 'working');
}

// The flag on the card, without rebuilding the list - same in-place route
// as the dots above. Reading from measuredActivity rather than from the
// dots is what keeps the two from drifting: one measured state, two ways
// of showing it.
function updateProjectBusy() {
  for (const project of projects) {
    const el = document.querySelector(`.project[data-project-id="${project.id}"]`);
    if (el) el.dataset.busy = String(projectIsBusy(project));
  }
}

// Nothing from here: the edge it drives is found by session id, and the
// row it sits on is rebuilt by render() below.
const subagents = initSubagents();

const agentWindows = initAgentWindows({
  containerEl: agentWindowsEl,
  lineEl: agentLinesEl,
  sidebarEl: projectListEl,
});

const activeSessionIdForDebug = () => openSessionId(currentProject?.sessions ?? []);

const eventSource = startEventStream(
  ({ tmuxSession, sessionId, state }) => {
    applyActivityState(tmuxSession, sessionId, state);
    // Handed over rather than read from the session list: applyActivityState
    // collapses the four values onto working/waiting for the dot, and the
    // conversation view needs the distinction that collapse throws away.
    noteSessionStatus({ tmuxSession, sessionId, state });
  },
  (payload) => {
    subagents.handleEvent(payload);
    // Open windows fetch what was appended and their line carries one
    // pulse - the delta is the only signal that anything happened.
    agentWindows.noteDelta(payload.sessionId, payload.agents ?? []);
  },
);

if (new URLSearchParams(location.search).get('debug') === 'subagents') {
  startSubagentDebug({
    source: eventSource,
    openWindowCount: () => agentWindows.openCount(),
    activeSessionId: activeSessionIdForDebug,
  });
}

async function refreshProjectSessions(project) {
  try {
    project.sessions = await fetchProjectSessions(project);
  } catch (err) {
    showError(`Could not refresh sessions for "${project.name}": ${err.message}`);
  }
  render(searchInputEl.value);
}

async function toggleFavorite(project) {
  try {
    const res = await fetch(`/api/projects/${project.id}/favorite`, { method: 'POST' });
    await checkResponse(res);
    clearError();
    project.favorite = !project.favorite;
    render(searchInputEl.value);
  } catch (err) {
    showError(`Could not change favorite: ${err.message}`);
  }
}

// Removes only the list entry - neither the real files nor the session
// history are touched. That's stated in the confirmation dialog too; with
// such low risk, a plain confirm() is enough.
async function removeProject(project) {
  const sure = confirm(
    `Remove "${project.name}" from the list?\n\n` +
      'This only deletes the entry in Claudux - the actual folder and the ' +
      'session history stay untouched. You can add the project back at ' +
      'any time via the same path.',
  );
  if (!sure) return;
  try {
    const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
    await checkResponse(res);
    clearError();
    projects = projects.filter((p) => p.id !== project.id);
    render(searchInputEl.value);
    renderProjectManagement();
  } catch (err) {
    showError(`Could not remove project: ${err.message}`);
  }
}

// Shared by the pin in the tile and the select in the project detail: a
// second copy of this would be the place where the two views drift apart.
// `null` clears the default.
async function setProjectDefaultAccount(project, accountId) {
  const res = await fetch(`/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultAccountId: accountId }),
  });
  await checkResponse(res);
  clearError();
  // Only into the model after the response, not before: the mark should
  // show the saved state, not the intent.
  if (accountId === null) delete project.defaultAccountId;
  else project.defaultAccountId = accountId;
  showToast(
    accountId
      ? `"${accountById(accountId)?.name ?? accountId}" is now the default for ${project.name}.`
      : `Default account for ${project.name} unset.`,
  );
}

// Pre-selection of the account select, each candidate checked against the
// loaded list so a removed account leaves no dead value: the project's
// default, the last choice made in THIS project, then the first known
// account. A dedicated function because the rail (railTile click) needs the
// same fallback value.
function determineDefaultAccount(project) {
  const accounts = allAccounts();
  const candidates = [project.defaultAccountId, lastAccount(project.id), accounts[0]?.id];
  return candidates.find((id) => id && accounts.some((a) => a.id === id)) ?? null;
}

// Builds the "+ New session" row for a project. accountSelect goes back to
// the caller because a session row without a known account uses the same
// select value as a fallback on click – that way there's no second
// selection UI per session row.
function buildNewSessionControls(project) {
  const wrap = document.createElement('div');
  wrap.className = 'new-session-controls';
  // The controls sit INSIDE the expandable tile: without this, every click
  // in there would additionally expand or collapse the project.
  wrap.addEventListener('click', (e) => e.stopPropagation());

  let accountSelect = null;
  if (allAccounts().length === 0) {
    const hint = document.createElement('span');
    hint.className = 'new-session-hint';
    hint.textContent = accountLoadFailed()
      ? 'Could not load accounts – reload the page.'
      : 'No account – add one below first.';
    wrap.appendChild(hint);
  } else {
    const chipEl = document.createElement('span');
    chipEl.className = 'account-chip';
    accountSelect = document.createElement('select');
    accountSelect.className = 'account-select';
    for (const account of allAccounts()) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.name;
      accountSelect.appendChild(option);
    }
    const match = determineDefaultAccount(project);
    if (match) accountSelect.value = match;
    // Label first, the select on top of it - the same arrangement as in the
    // session row, so the account looks and behaves the same in both
    // places.
    const setChipLabel = () => {
      chipEl.replaceChildren(
        document.createTextNode(accountLabel(accountSelect.value) ?? ''),
        accountSelect,
      );
    };
    setChipLabel();
    wrap.appendChild(chipEl);

    accountSelect.addEventListener('change', () => {
      rememberAccount(project.id, accountSelect.value);
      setChipLabel();
      // The pin mark shows the comparison against THIS value – without this
      // it would show a state that's no longer valid after a switch.
      drawPin();
    });
  }

  // Remembers the currently selected account as this project's default.
  // Only visible in edit mode (styles.css), but always rendered – the mode
  // toggles there without rebuilding the list.
  //
  // No second select field: the project row is already tight at narrow
  // widths, and a mark on the existing pill costs no extra column.
  function drawPin() {
    if (!pinBtn || !accountSelect) return;
    const set = Boolean(project.defaultAccountId) && project.defaultAccountId === accountSelect.value;
    pinBtn.dataset.configured = String(set);
    pinBtn.title = set
      ? 'Default account for this project – tap to unset'
      : 'Remember the selected account as this project’s default';
  }

  let pinBtn = null;
  if (accountSelect) {
    pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'btn-quiet pin-btn';
    // A pushpin as SVG instead of a text character: such symbols have shown
    // up here before as empty boxes. The body gets filled in via styles.css
    // when a default is set.
    pinBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
      '<path class="pin-body" d="M4.6 10.2h6.8L10 7.4V3.2H6v4.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
      '<path d="M8 10.2V13.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
      '</svg>';
    drawPin();
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't collapse/expand the project
      // From a mismatched state, the click always sets the selected
      // account; it only gets unset when both already match.
      const next = pinBtn.dataset.configured === 'true' ? null : accountSelect.value;
      pinBtn.disabled = true;
      try {
        await setProjectDefaultAccount(project, next);
        drawPin();
      } catch (err) {
        showError(`Could not save default account: ${err.message}`);
      } finally {
        pinBtn.disabled = false;
      }
    });
    wrap.appendChild(pinBtn);
  }

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  // Just the icon: there's no room for text in the project tile, and next
  // to the account field it's clear enough what this starts.
  newBtn.innerHTML = svg('plus', 'icon-symbol');
  newBtn.title = 'Start a new session with the selected account';
  newBtn.setAttribute('aria-label', newBtn.title);
  newBtn.disabled = allAccounts().length === 0;
  newBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't collapse/expand the project
    const accountId = accountSelect ? accountSelect.value : null;
    if (!accountId) {
      showError('Please add an account first before starting a new session.');
      return;
    }
    newBtn.disabled = true;
    try {
      const res = await fetch(`/api/projects/${project.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      await checkResponse(res);
      const session = await res.json();
      clearError();
      // POST /api/projects/:id/sessions deliberately returns only {id,
      // terminalUrl} (see src/routes/sessions.js), no account – but the
      // client already knows it here from its own selection anyway.
      // `live: true`, because the route only responds after it has itself
      // waited for the tmux session via waitForSession() – so the
      // dot can be green right away, without waiting for the refresh below.
      project.open = true;
      // `activeAccountId` comes from the own selection: the route doesn't
      // return it, and the session was just started with exactly this
      // token. The refresh below replaces it with the value read off the
      // process - without this pre-fill the badge would stay empty until
      // then.
      openSession(project, { ...session, accountId, activeAccountId: accountId, live: true });
      await refreshProjectSessions(project);
    } catch (err) {
      showError(`Could not create session: ${err.message}`);
    } finally {
      newBtn.disabled = allAccounts().length === 0;
    }
  });
  wrap.appendChild(newBtn);
  return { el: wrap, accountSelect };
}

// The three states from src/lib/authStatus.js need three different calls
// to action - collapsing them into one warning would suggest the wrong
// step:
//
//   expired  - the stored token has expired, RENEWING helps
//   invalid  - the value isn't a valid token at all, renewing does NOT
//              help, it has to be corrected
//   expiring - nothing broken yet, but this is the last chance to act
//
// Icon for the sidebar, plain text for the banner in the panel header: the
// narrow session row has no room for text, and on the phone there's no
// hover that would show a title tooltip. The icon is referenced by name
// from js/icons.js here, not as a character - it used to be emoji.
const AUTH_PROBLEM_DISPLAY = {
  expired: {
    icon: 'forbidden',
    text: 'This session\u2019s login has expired. Renew the token: edit the account \u2192 \u201cLogin\u2026\u201d, then restart the session.',
  },
  invalid: {
    icon: 'forbidden',
    text: 'The stored token is invalid \u2013 renewing will NOT help here. The saved value has to be corrected (it must start with sk-ant-oat).',
  },
  expiring: {
    icon: 'hourglass',
    text: 'This session\u2019s login expires soon. Everything still works \u2013 this is the chance to renew the token.',
  },
};

// Changes properties of a session (reaper protection, account) and reloads
// the list so the display follows the server instead of an assumption.
// Returns whether the change actually succeeded - restartWithAccount below
// needs that to stop before doing something destructive on top of a
// failure the user has already seen reported.
async function changeSession(project, session, changes) {
  try {
    const res = await fetch(`/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    await checkResponse(res);
    clearError();
    await refreshProjectSessions(project);
    return true;
  } catch (err) {
    showError(`Could not change session: ${err.message}`);
    return false;
  }
}

// Clears the open-terminal UI state without touching the backend - shared
// by endSession (after the DELETE call below) and by the auto-close for a
// deliberate `/exit` (see closeCleanlyExitedSession further down), so the
// two paths can't drift apart.
function closeOpenTerminal() {
  currentSessionId = null;
  currentLoginSessionId = null;
  currentProject = null;
  terminalFrameEl.removeAttribute('src');
  dropConversationSession();
  updateAccountBadge(null);
  updateAuthBanner(null);
  try {
    localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // Private mode - then the next reload tries to resume the session
    // and restarts it instead. Unsightly, no harm done.
  }
}

// Ends the tmux session without confirmation. That's fine, because the
// conversation is NOT lost - Claude Code writes it continuously to its
// JSONL file, and the same row can be resumed afterward. All that's lost is
// what wasn't in the file anyway: a running command, text not yet sent,
// background jobs. A mis-tap costs a restart, not work.
async function endSession(project, session) {
  try {
    const res = await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
    await checkResponse(res);
    clearError();
    // If it was the open session, the terminal next to it has to go too -
    // otherwise an iframe would be left standing whose tmux session no
    // longer exists.
    if (isOpenSession(project, session)) closeOpenTerminal();
    // Load fresh instead of just recoloring the row: otherwise the green
    // dot would keep glowing until something else happens to fetch the
    // list.
    await refreshProjectSessions(project);
    // Without a confirmation beforehand (see above), the feedback
    // afterward is the safety net: it says what happened AND that it can
    // be undone without consequence - important because on the phone the
    // dot is tappable without any visible marker.
    showToast('Session ended – can be resumed via the same row.');
  } catch (err) {
    showError(`Could not end session: ${err.message}`);
  }
}

// A resume that replaced a corpse deserves a toast: otherwise the terminal
// just looks different from before with no indication why. Shared by every
// caller of the resume route instead of three copies of the same lines.
function showCrashToast(restoredAfterCrash) {
  if (!restoredAfterCrash) return;
  const cause = restoredAfterCrash.signal
    ? `Signal ${restoredAfterCrash.signal}`
    : `Exit ${restoredAfterCrash.status}`;
  showToast(`Crashed session restored (${cause})`);
}

// Resumes a session and puts it in the terminal. Pulled out of
// buildSessionRow because the rail of the collapsed sidebar needs the same
// path – two copies of the same flow would be the spot where they later
// drift apart.
//
// `fallbackAccountId` applies to legacy sessions from the JSONL history:
// those never had a sessionMeta entry and therefore carry no account of
// their own.
//
// Silently does nothing if THIS session already has a resume in flight
// (see resumeInFlightIds) - exactly the case where the crash screen tells
// the user to tap, while the wake path or the crash-heal tick is already
// resuming it. The caller's finally block still re-enables the row. A tap
// on a different session is unaffected - the guard is per id.
//
// The guard bookkeeping lives here and only here; runResume() below is the
// bare flow, for callers that already hold the id (see
// restartWithAccount).
async function resumeSession(project, session, fallbackAccountId) {
  if (resumeInFlightIds.has(session.id)) return;
  resumeInFlightIds.add(session.id);
  try {
    await runResume(project, session, fallbackAccountId);
  } finally {
    resumeInFlightIds.delete(session.id);
  }
}

async function runResume(project, session, fallbackAccountId) {
  const accountId = session.accountId || fallbackAccountId || null;
  const res = await fetch(`/api/sessions/${session.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, accountId }),
  });
  await checkResponse(res);
  const resumed = await res.json();
  clearError();
  // accountId and activeAccountId aren't part of the response - it carries
  // restarted/restoredAfterCrash instead. Both are already available here
  // from the list response or the own selection; the following refresh
  // replaces both with the value measured on the process.
  openSession(project, {
    ...resumed,
    accountId: session.accountId || accountId,
    activeAccountId: session.activeAccountId || accountId,
    live: true,
  });
  // Without this fetch the row would stay at the state of the last list
  // fetch: the status dot would stay gray, and since the end-session
  // button hangs off it, it wouldn't be reachable for a session that was
  // just opened.
  await refreshProjectSessions(project);
  showCrashToast(resumed.restoredAfterCrash);
}

// Switches the account of a session that is RUNNING. The token lives in
// the process environment and cannot be swapped in place, so the session
// has to restart - deliberately not via endSession(), which reports an
// ending and tears down the terminal.
//
// What the restart costs is only the prompt cache: the conversation is in
// the JSONL, everything else (running command, unsent text) is what a stop
// costs too.
//
// The order matters beyond tidiness: the resume route prefers the stored
// assignment over the id passed in its body (see sessions.js), so the PATCH
// has to land before the DELETE+resume or the process would come back
// under the OLD account while this function reports the new one.
//
// The id is claimed in resumeInFlightIds for the WHOLE sequence, not just
// for the resume: a resume started elsewhere (row tap, rail, wake path)
// between the DELETE and the restart would find the guard set, return
// silently - and this function would report a switch on top of a killed
// chat that nothing brought back. Claiming it before the PATCH also keeps
// the stored assignment from moving on a run that then bails.
async function restartWithAccount(project, session, accountId) {
  if (resumeInFlightIds.has(session.id)) {
    showError('Could not restart – a resume for this session is already in progress.');
    return;
  }
  resumeInFlightIds.add(session.id);
  try {
    // changeSession() already reported the failure - proceeding would kill
    // and restart a still-correctly-assigned session for nothing, and the
    // toast below would claim a switch that never happened.
    if (!(await changeSession(project, session, { accountId }))) return;
    // The route answers 204 even for a session that's already gone, so
    // anything else here is a real failure - swallowing it would leave the
    // process running under the OLD token while the toast announces the new
    // account.
    await checkResponse(await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' }));
    await runResume(project, { ...session, accountId, live: false }, accountId);
    showToast(`Now running under ${accountById(accountId)?.name ?? 'the selected account'}.`);
  } catch (err) {
    // The assignment is stored at this point, the process is not
    // necessarily gone (the DELETE may be what failed) - hence a message
    // that holds for both, instead of one that claims a state.
    showError(`Could not restart under the new account: ${err.message} `
      + 'The account is saved and takes effect on the next start.');
  } finally {
    resumeInFlightIds.delete(session.id);
  }
}

// Which row is in the terminal? Not necessarily the one that was clicked:
// after a /clear, Claude Code continues the conversation under a NEW id,
// while the tmux session - and with it currentSessionId - keeps its name.
// Without this detour the new row stayed unmarked while the old one stayed
// highlighted.
function openSessionId(sessions) {
  if (!currentSessionId) return null;
  const carrier = sessions.find((s) => s.id === currentSessionId)?.carrier ?? currentSessionId;
  return sessions.find((s) => s.carrier === carrier && s.current)?.id ?? currentSessionId;
}

function isOpenSession(project, session) {
  return currentProject?.id === project.id && session.id === openSessionId(project.sessions);
}

function buildSessionRow(project, session, fallbackAccountSelect) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row-card session-row';
  // Anchor point for the time label: the 15-second tick rewrites "3 min
  // ago" in place, without rebuilding the list (see updateTimes).
  row.dataset.sessionId = session.id;
  const isActive = isOpenSession(project, session);
  row.dataset.active = String(isActive);
  // The server only returns authProblem for running sessions (only those
  // have a pane, see GET /:id/sessions) - it's null for ended ones.
  const authDisplay = AUTH_PROBLEM_DISPLAY[session.authProblem?.kind] ?? null;
  // The chip shows the account, and which one depends on the state:
  //
  //   - running: the account measured on the process. The environment is
  //     the truth there, and with two subscriptions on separate rate
  //     limits, "which session eats which quota" is worth a glance.
  //   - ended: the stored assignment, dimmed - it is what the next start
  //     will use, not something anyone measured.
  //
  // A token belonging to no stored account (or none at all) shows as a
  // warning instead of staying quiet - it is invisible everywhere else.
  let chipLabel = null;
  let chipWarning = null;
  let chipStored = false;
  if (session.live) {
    if (session.activeAccountId) {
      chipLabel = accountLabel(session.activeAccountId);
      // Resolves to nothing only if the account was deleted while the
      // session kept running under its token - genuinely worth a warning.
      // Guarded by accountLoadFailed(), otherwise the very same shape (id
      // set, label missing) also covers "the account list hasn't loaded
      // yet", where the app cannot tell deleted from not-yet-known.
      if (!chipLabel && !accountLoadFailed()) {
        chipWarning = 'Token belongs to no stored account';
      }
    } else if (session.hasToken === false) {
      chipWarning = 'Running without CLAUDE_CODE_OAUTH_TOKEN';
    } else if (session.hasToken === true) {
      chipWarning = 'Token belongs to no stored account';
    }
  } else {
    chipLabel = accountLabel(session.accountId);
    chipStored = true;
  }
  // What the picker should preselect: for a live session that's the
  // account actually running (`activeAccountId`), nothing else - a live
  // row with no `activeAccountId` is exactly the warning-chip states
  // above (no token, or a token that resolves to nothing), which show no
  // account at all, so falling back to the stored assignment there would
  // preselect an account the chip never displayed and make tapping it a
  // silent no-op. Using `session.accountId` unconditionally would also
  // disagree with what the chip shows whenever a switch was requested but
  // hasn't taken effect yet (see restartWithAccount).
  const selectedAccountId = session.live
    ? session.activeAccountId || null
    : session.accountId || null;
  const selectedAccountResolves = Boolean(accountById(selectedAccountId));
  // The select sits INSIDE the chip and is transparent (see styles.css):
  // it's the only control that opens a proper list on the phone, and the
  // chip is where the information it changes already is.
  //
  // An unresolved id (deleted account, or none at all) gets a hidden
  // placeholder option marked `selected` instead of leaving every real
  // option unselected: without it the browser preselects option 0, and
  // picking that same account again would silently do nothing.
  const accountOptions =
    (selectedAccountResolves ? '' : '<option value="" selected hidden></option>') +
    allAccounts()
      .map((a) => `<option value="${escapeHtml(a.id)}"${a.id === selectedAccountId ? ' selected' : ''}>`
        + `${escapeHtml(a.name)}</option>`)
      .join('');
  row.innerHTML =
    // For running sessions, the status dot doubles as the end-session
    // button: it shows a power icon in the live colour, so the action stays
    // visible without a hover and sits right where the information it
    // conveys is. Idle sessions get the same icon, muted - there's nothing
    // to end there. Saves a dedicated column at the end of the row, which
    // stays calmer as a result.
    //
    // A live row starts in the last activity anyone measured - the stream's
    // if it has said something since the fetch, the server's otherwise, and
    // `live` where nothing is known about it at all.
    `<span class="dot" data-state="${session.live ? (activityOf(session) ?? 'live') : 'idle'}"` +
    (session.live
      ? ' data-stop="true" role="button" tabindex="0" title="End session – the conversation is preserved"'
      : '') +
    '>' +
    svg('power', 'icon-symbol') +
    '</span>' +
    // Its own control at the right edge, not a cell in the grid: it glows
    // while agents run in this session and opens their windows on a click,
    // which the row's own click (open the session) must not do.
    `<button class="btn-quiet session-agents-edge" data-session-id="${escapeHtml(session.id)}" hidden` +
    ' title="Show the agents running in this session"></button>' +
    // Title and last prompt stacked. The prompt is omitted when it matches
    // the title - which is the case for every session that doesn't have an
    // ai-title yet, and the same text twice adds nothing.
    '<span class="session-title">' +
    `<span class="session-name">${escapeHtml(session.title)}</span>` +
    (session.lastPrompt && session.lastPrompt !== session.title
      ? `<span class="session-preview">${escapeHtml(session.lastPrompt)}</span>`
      : '') +
    '</span>' +
    `<span class="session-time">${formatRelativeTime(session.mtimeMs)}</span>` +
    // On a problem the icon replaces the account label - with the login
    // expired the account matters less than the prompt to renew it, and the
    // explanation stays in the tooltip and the banner. The select stays in
    // every branch: an expired login is exactly when switching accounts
    // matters.
    (() => {
      const picker = `<select class="account-select-inline" aria-label="Account this session runs under">${accountOptions}</select>`;
      if (authDisplay) {
        // data-kind carries the color, since the SVG has none of its own -
        // and "expiring" is explicitly not a failure (see styles.css).
        return `<span class="account-chip" data-warn="true" data-kind="${escapeHtml(session.authProblem.kind)}" title="${escapeHtml(authDisplay.text)}">`
          + svg(authDisplay.icon, 'icon-symbol') + picker + '</span>';
      }
      if (chipWarning) {
        return `<span class="account-chip" data-warn="true" title="${escapeHtml(chipWarning)}">`
          + svg('warning', 'icon-symbol') + picker + '</span>';
      }
      return `<span class="account-chip" data-stored="${chipStored}" title="${chipStored
        ? 'Last used – the account this chat resumes under'
        : 'Account actually in use'}">`
        + escapeHtml(chipLabel ?? '') + picker + '</span>';
    })() +
    // Only visible in edit mode (see styles.css). The lock protects
    // against the idle reaper, which otherwise ends every unattended
    // session after four hours of quiet.
    `<span class="btn-quiet lock-btn" role="button" tabindex="0" data-locked="${session.protected ? 'true' : 'false'}"` +
    ` title="${session.protected
        ? 'Protected: keeps running even if idle for hours'
        : 'Ends automatically once idle for long enough – tap to protect'}">` +
    // Padlock as SVG, not a character: closed means protected, open doesn't.
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
    '<rect x="3.4" y="7" width="9.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    (session.protected
      ? '<path d="M5.8 7V4.8a2.2 2.2 0 0 1 4.4 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/>'
      : '<path d="M5.8 7V4.8a2.2 2.2 0 0 1 4.4 0" fill="none" stroke="currentColor" stroke-width="1.4"/>') +
    '</svg>' +
    '</span>';

  const accountSelectInline = row.querySelector('.account-select-inline');
  // A resolved id needs a second account to switch TO. An unresolved one
  // (the placeholder above) is itself the broken state - one known account
  // is already a real destination, exactly the row the picker exists to
  // heal (see the CSS comment on .account-chip).
  accountSelectInline.disabled = allAccounts().length < (selectedAccountResolves ? 2 : 1);
  accountSelectInline.addEventListener('click', (e) => e.stopPropagation()); // don't open the session
  accountSelectInline.addEventListener('change', async (e) => {
    e.stopPropagation();
    const accountId = accountSelectInline.value;
    // The placeholder option (see accountOptions above) has an empty
    // value. It's `hidden`, so a real browser picker shouldn't offer it -
    // but iOS Safari's wheel has historically rendered `hidden` options as
    // a blank, pickable row, and this app runs on the phone.
    if (!accountId) return;
    // A running session can't change its token, so switching means
    // restarting - and the price that isn't obvious goes into the
    // question: the prompt cache dies with the process, so a long chat is
    // reloaded on the next start.
    if (session.live) {
      const name = accountById(accountId)?.name ?? 'this account';
      const sure = confirm(
        `Restart this session with ${name}?\n\n`
        + 'The conversation is preserved. Its prompt cache is not – a long '
        + 'chat is reloaded on the next start and can cost noticeably more tokens.',
      );
      if (!sure) {
        // Reset to an option that actually exists: `selectedAccountId`
        // itself has no <option> when it doesn't resolve (see the
        // placeholder above), and assigning a value with no matching
        // option clears the selection instead of restoring it.
        accountSelectInline.value = selectedAccountResolves ? selectedAccountId : '';
        return;
      }
      await restartWithAccount(project, session, accountId);
      return;
    }
    // Ended: only stored, deliberately without resuming. Starting here
    // would be what the chip's own tooltip rules out ("the account this
    // chat resumes under"), and on the phone a mis-tap on a dimmed row
    // would spawn a session and burn quota. The row stays a tap away.
    if (!(await changeSession(project, session, { accountId }))) return;
    showToast(`Resumes under ${accountById(accountId)?.name ?? 'the selected account'}.`);
  });

  const lockEl = row.querySelector('.lock-btn');
  const toggleProtection = (e) => {
    e.stopPropagation(); // otherwise the same click would also open the session
    changeSession(project, session, { protected: !session.protected });
  };
  lockEl.addEventListener('click', toggleProtection);
  // The warning comes when protecting itself, not only when the menu is
  // opened: at that point you're not in the menu anyway.
  lockEl.addEventListener('click', () => {
    if (session.protected) return; // was protected, is being released now
    const warning = protectionWarning();
    if (warning) showToast(warning);
  });
  lockEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleProtection(e);
  });

  const stopEl = row.querySelector('.dot[data-stop]');
  if (stopEl) {
    stopEl.addEventListener('click', (e) => {
      // Without stopPropagation the same click would additionally hit the
      // row and open the session that's just being ended.
      e.stopPropagation();
      endSession(project, session);
    });
    // There's no hover on the phone, so the mark never appears there -
    // but the dot stays tappable. Hence a feedback message after ending
    // (see endSession), so that a mis-tap is immediately recognizable and
    // it's clear it stays without consequence.
    stopEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      endSession(project, session);
    });
  }
  const edgeEl = row.querySelector('.session-agents-edge');
  if (edgeEl) {
    edgeEl.addEventListener('click', (e) => {
      // Same reason as the end button above: without this the click would
      // additionally hit the row and resume the session.
      e.stopPropagation();
      agentWindows.toggle(session.id, subagents.agentsOf(session.id));
    });
  }
  row.addEventListener('click', async () => {
    row.disabled = true;
    try {
      await resumeSession(project, session, fallbackAccountSelect?.value);
    } catch (err) {
      showError(`Could not resume session: ${err.message}`);
    } finally {
      row.disabled = false;
    }
  });
  return row;
}

// Bottom fade so a long session list hints that more rows sit below the
// visible area (see .session-scroll[data-more-below] in styles.css).
// `mask-image` fades to the element's own transparency instead of a
// background color matched per theme - nothing to keep in sync there.
// Off again once there's nothing left to scroll to, so the fade never
// promises content that isn't there.
function updateScrollFade(el) {
  el.dataset.moreBelow = String(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
}

function buildProjectElement(project, visibleSessions, isOpen) {
  const projEl = document.createElement('div');
  projEl.className = 'project';
  projEl.dataset.open = String(isOpen);
  projEl.dataset.projectId = project.id;
  projEl.dataset.busy = String(projectIsBusy(project));

  // A <div role="button"> instead of a real <button>: the session controls
  // (select + button) have moved into the tile, and a <select> or <button>
  // INSIDE a <button> is neither valid HTML nor operable - the outer
  // button would swallow the clicks. Keyboard operation is therefore
  // retrofitted by hand (tabindex + Enter/Space), which a real <button>
  // otherwise provides on its own.
  const head = document.createElement('div');
  head.className = 'project-head';
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', String(isOpen));
  head.title = project.path;
  head.innerHTML =
    // The SVG is aria-hidden, so the title carries the accessible name.
    `<span class="btn-quiet star-btn" data-fav="${project.favorite}" ` +
      `title="${project.favorite ? 'Remove favorite' : 'Mark as favorite'}">` +
      `${svg(project.favorite ? 'starFull' : 'star', 'icon-symbol')}</span>` +
    '<span class="project-name-col">' +
    `<span class="project-name">${escapeHtml(project.name)}</span>` +
    `<span class="project-path">${escapeHtml(project.path)}</span>` +
    '</span>' +
    // An X, not a trash can: "remove" fits better than "delete" - the
    // folder itself stays untouched.
    `<span class="btn-quiet remove-btn" title="Remove project from the list">${svg('close', 'icon-symbol')}</span>`;
  const toggle = () => {
    project.open = !isOpen;
    render(searchInputEl.value);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  });
  head.querySelector('.star-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(project);
  });
  head.querySelector('.remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    removeProject(project);
  });

  // Session controls go into the tile instead of below it. They have to
  // come BEFORE the trash icon, so it stays at the right edge.
  const { el: newSessionEl, accountSelect } = buildNewSessionControls(project);
  head.insertBefore(newSessionEl, head.querySelector('.remove-btn'));
  projEl.appendChild(head);

  const sessionPanel = document.createElement('div');
  sessionPanel.className = 'session-panel';

  if (visibleSessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No sessions – "+" in the project row starts one.';
    sessionPanel.appendChild(empty);
  }

  // The open session stays visible even when its project is collapsed -
  // otherwise, once collapsed, it's no longer clear which conversation is
  // currently in the terminal. A dedicated row outside the collapsible
  // area, so it's unaffected by that area's height animation.
  if (!isOpen && currentProject?.id === project.id && currentSessionId) {
    const openId = openSessionId(project.sessions);
    const active = project.sessions.find((sess) => sess.id === openId);
    if (active) {
      const pinned = document.createElement('div');
      pinned.className = 'pinned-session';
      pinned.appendChild(buildSessionRow(project, active, accountSelect));
      projEl.appendChild(pinned);
    }
  }
  // A dedicated container for the rows so they can scroll on their own: a
  // project with a long history would otherwise flood the sidebar and push
  // every other project out of view. The height limit deliberately does NOT
  // sit on .session-panel - the expand/collapse animation runs on that, and
  // having both on one property would interfere with each other.
  const sessionScroll = document.createElement('div');
  sessionScroll.className = 'no-scrollbar session-scroll';
  // Only for an open project. A collapsed one clips its rows away entirely
  // (max-height: 0 plus overflow: hidden above), so building them puts work
  // into nodes nobody can see - with a three-digit history across several
  // projects that is the bulk of a render(). Expanding runs through
  // render() again and builds them then. The open session of a collapsed
  // project is unaffected: it hangs in .pinned-session above, outside this
  // container.
  if (isOpen) {
    for (const session of visibleSessions) {
      sessionScroll.appendChild(buildSessionRow(project, session, accountSelect));
    }
  }
  sessionPanel.appendChild(sessionScroll);
  sessionScroll.addEventListener('scroll', () => updateScrollFade(sessionScroll));
  // The project card's expand/collapse runs on .session-panel's max-height
  // (see the transition in styles.css). Mid-animation, the still-clipped
  // ancestor makes session-scroll report a too-small height - the fade
  // needs a second check once that settles, not only right away.
  sessionPanel.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'max-height') updateScrollFade(sessionScroll);
  });

  projEl.appendChild(sessionPanel);
  return projEl;
}

// Abbreviation tile for the rail. Two letters plus title in the tooltip –
// nothing more fits in 60px, and the rail is a springboard, not a list.
function railTile({ text, title, active, live, activity }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-surface btn-glow rail-tile';
  btn.title = title;
  btn.dataset.active = String(Boolean(active));
  btn.textContent = text;
  // Only ever called with live:true (running sessions) or without live at
  // all (favorites) - an 'idle' state never occurs here. The activity is
  // the same value the row's dot carries, so both show one session in one
  // state instead of two.
  if (live !== undefined) {
    const dot = document.createElement('span');
    dot.className = 'rail-dot';
    dot.dataset.state = activity ?? 'live';
    btn.appendChild(dot);
  }
  return btn;
}

function initials(name) {
  return name.trim().slice(0, 2).toUpperCase();
}

// Builds the rail from the same model as the list, so both stay in sync.
// No dedicated endpoint needed: loadProjects() already fetches the
// sessions of ALL projects, so `live` is already in the model.
function renderRail() {
  sidebarRailEl.replaceChildren();

  const search = document.createElement('button');
  search.type = 'button';
  search.className = 'btn-surface btn-glow rail-btn';
  search.title = 'Search – expands the sidebar';
  search.setAttribute('aria-label', 'Search');
  search.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M10.2 10.2 13.6 13.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>';
  search.addEventListener('click', () => {
    setSidebarCollapsed(false); // remembers the state itself, see there
    searchInputEl.focus();
  });
  sidebarRailEl.appendChild(search);

  const zones = document.createElement('div');
  zones.className = 'no-scrollbar rail-zones';

  // Running sessions across all projects. The initials come from the
  // PROJECT, not the account: that's already in the pill above the
  // terminal, the project mapping is the missing information here.
  const running = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.live) running.push({ project, session });
    }
  }
  for (const { project, session } of running) {
    const tile = railTile({
      text: initials(project.name),
      title: `${project.name} · ${session.title}`,
      active: isOpenSession(project, session),
      live: true,
      activity: activityOf(session),
    });
    // Anchor for the status stream, same as on the row - without it the
    // rail dot would only follow on the next full render.
    tile.dataset.sessionId = session.id;
    tile.addEventListener('click', async () => {
      tile.disabled = true;
      try {
        await resumeSession(project, session, determineDefaultAccount(project));
      } catch (err) {
        showError(`Could not resume session: ${err.message}`);
      } finally {
        tile.disabled = false;
      }
    });
    zones.appendChild(tile);
  }

  const favorites = projects.filter((p) => p.favorite);
  // The separator only when it actually separates two zones – otherwise
  // it would stand alone in space.
  if (running.length > 0 && favorites.length > 0) {
    const line = document.createElement('div');
    line.className = 'rail-separator';
    zones.appendChild(line);
  }
  for (const project of favorites) {
    const tile = railTile({
      text: initials(project.name),
      title: `${project.name} – opens the sidebar`,
      active: currentProject?.id === project.id,
    });
    // A project can't be shown meaningfully in 60px; here the click means
    // "switch to it", not "expand and look".
    tile.addEventListener('click', () => {
      setSidebarCollapsed(false); // remembers the state itself, see there
      project.open = true;
      render(searchInputEl.value);
    });
    zones.appendChild(tile);
  }
  sidebarRailEl.appendChild(zones);

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'btn-surface btn-glow rail-btn';
  settings.title = 'Settings';
  settings.setAttribute('aria-label', 'Settings');
  settings.textContent = '···';
  settings.addEventListener('click', () => openManagement('appearance'));
  sidebarRailEl.appendChild(settings);
}

// Rebuilds the complete sidebar project list from the `projects` model,
// instead of patching individual DOM nodes. A filter match automatically
// expands its project even if it was previously collapsed.
function render(filter) {
  filter = (filter || '').trim().toLowerCase();
  projectListEl.innerHTML = '';
  // Favorites first. A stable sort (guaranteed since ES2019) keeps the
  // existing order within both groups, instead of shuffling it.
  const sorted = [...projects].sort((a, b) => Number(b.favorite) - Number(a.favorite));
  for (const project of sorted) {
    const matchesProject = project.name.toLowerCase().includes(filter);
    // Also over the last prompt: an ai-title often shares no word with what
    // was actually typed, so title-only search would miss the session.
    const visibleSessions = filter
      ? project.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(filter) ||
            (s.lastPrompt ?? '').toLowerCase().includes(filter),
        )
      : project.sessions;
    if (filter && !matchesProject && visibleSessions.length === 0) continue;
    const isOpen = project.open || (filter !== '' && visibleSessions.length > 0);
    projectListEl.appendChild(buildProjectElement(project, visibleSessions, isOpen));
  }
  // From the same data as the list, so the two can't drift apart. The
  // filter is deliberately left out: the rail isn't a search result.
  renderRail();
  // The rows are new elements and every subagent badge comes back hidden;
  // the stream carries only deltas, so nothing else would put the counts
  // back. Same idiom as the activity dots, which buildSessionRow reads out
  // of measuredActivity for exactly this reason.
  subagents.refreshEdges();
  // The rebuilt list may no longer have a row for a session whose windows
  // are open, and nothing in the stream reports that.
  agentWindows.pruneMissingRows();
  updateOnboardingWizard(allAccounts(), projects);
  // What's on screen right now - the background tick compares against this.
  lastSignature = sessionSignature();
  // Layout only settles once these elements are actually in the document -
  // right after appendChild above, scrollHeight would still be 0.
  requestAnimationFrame(() => {
    document.querySelectorAll('.session-scroll').forEach(updateScrollFade);
  });
}

// The badge prefers to show the account the process is ACTUALLY running
// under (`activeAccountId`, determined from the token in
// /proc/<pid>/environ), not the stored mapping. The two can diverge, and a
// wrong account display is worse than none at all when two subscriptions
// with separate rate limits are in play.
//
// Three distinguishable states instead of two:
//   - account known                            -> name
//   - running, but without a token              -> warning
//   - token belongs to no stored account        -> warning
function updateAccountBadge(session) {
  // Icon as a node next to a text node, not as innerHTML: the text next to
  // it is an account name and thus comes from outside.
  const set = (iconName, text, title) => {
    accountBadgeEl.replaceChildren(svgNode(iconName, 'icon-symbol'), document.createTextNode(text));
    accountBadgeEl.title = title;
  };
  const clear = () => {
    accountBadgeEl.replaceChildren();
    accountBadgeEl.title = '';
  };
  if (!session) return clear();
  if (session.loginTerminal) {
    return set('key', 'Account login',
      'claude setup-token – copy the token from this terminal and paste it below');
  }
  if (session.activeAccountId) {
    const account = accountById(session.activeAccountId);
    return set('person', account?.name ?? 'unknown account',
      'Account actually in use (determined from the running process’s token)');
  }
  if (session.hasToken === false) {
    return set('warning', 'no token', 'This session is running without CLAUDE_CODE_OAUTH_TOKEN.');
  }
  if (session.hasToken === true) {
    return set('warning', 'unknown token',
      'This session’s token belongs to no stored account.');
  }
  // Session not running: no process, so only the stored mapping – marked
  // as such.
  if (!session.accountId) return clear();
  const account = accountById(session.accountId);
  set('person', account?.name ?? 'unknown account', 'Last saved mapping (session not running)');
}

// Which tab was last on screen, so a reload comes back to it rather than to
// the terminal every time.
const LAST_TAB_KEY = 'claudux-last-tab';

function rememberTab(name) {
  try {
    localStorage.setItem(LAST_TAB_KEY, name);
  } catch {
    // Private mode - then a reload comes back to the terminal, as it always did.
  }
}

// Read once, at startup, and used up on the first session that opens: opening
// a session forces the terminal tab on purpose (see below), and that has to
// keep holding for every session opened by hand afterwards.
let tabToRestore = (() => {
  try {
    return localStorage.getItem(LAST_TAB_KEY);
  } catch {
    return null;
  }
})();

// Not before the terminal has actually attached. Hidden from the start, xterm
// fits itself to a box of no height and ttyd hands that size on to tmux - the
// window of a real session, resized by a tab this UI happened to remember. A
// click cannot hit this because by then the terminal is up; only a restore
// can, which is why the wait is here and not in the tab function.
//
// A condition, not a delay, and it gives up rather than firing into a terminal
// that never came up. It also stands down the moment the tab is changed by
// hand - a restore landing on top of that would take the screen away from
// whoever just asked for it.
const TAB_RESTORE_LOOK_MS = 120;
const TAB_RESTORE_LOOKS = 100;

function restoreLastTab() {
  const want = tabToRestore;
  tabToRestore = null;
  if (want !== 'files' && want !== 'conversation') return;
  let looks = 0;
  const look = () => {
    if (appEl.dataset.tab !== 'terminal') return;
    if (terminalIsAttached()) {
      if (want === 'files') activateFilesTab();
      else activateConversationTab();
      return;
    }
    looks += 1;
    if (looks < TAB_RESTORE_LOOKS) setTimeout(look, TAB_RESTORE_LOOK_MS);
  };
  look();
}

// Forces the terminal tab (instead of files) – e.g. relevant when a new
// session/a login terminal is opened while another session's files tab was
// previously active.
function activateTerminalTab() {
  tabTerminalEl.dataset.active = 'true';
  tabFilesEl.dataset.active = 'false';
  tabConversationEl.dataset.active = 'false';
  terminalFrameEl.style.display = 'block';
  leaveFiles();
  leaveConversation();
  // Via an attribute instead of an inline style: the bar is hidden on wide
  // screens through a media query, and an inline style would always
  // override that.
  appEl.dataset.tab = 'terminal';
  rememberTab('terminal');
  updateOnboardingWizard(allAccounts(), projects);
}

// The other direction, factored out so a terminal path click (see
// terminalLinks.js) can switch tabs the same way the Files tab button does,
// instead of keeping a second copy of this inline in a click handler.
//
// `project` defaults to the currently open one but can be overridden - a
// terminal link into a SIBLING project passes that project instead, without
// touching currentProject itself. currentProject also drives which row the
// sidebar marks active, which belongs to the running session, not to
// whatever file someone last peeked at.
function activateFilesTab(project = currentProject) {
  tabTerminalEl.dataset.active = 'false';
  tabFilesEl.dataset.active = 'true';
  tabConversationEl.dataset.active = 'false';
  terminalFrameEl.style.display = 'none';
  appEl.dataset.tab = 'files';
  rememberTab('files');
  leaveConversation();
  // The text view covers the same area and would otherwise sit on top of
  // the file list - it doesn't belong there.
  leaveCopyText();
  showFiles(project);
  updateOnboardingWizard(allAccounts(), projects);
}

// Which row is in the terminal, as an object rather than an id: the
// conversation route is keyed on the carrier, and openSessionId() alone
// hands back only the id (see the comment there for the /clear detour it
// exists for).
function openSessionRow() {
  const sessions = currentProject?.sessions ?? [];
  return sessions.find((s) => s.id === openSessionId(sessions)) ?? null;
}

// The conversation is bound to one session, and showConversation() only runs
// when the tab is entered - so a session that goes away while this tab is ON
// SCREEN has to be reported here. Both callers deliberately leave the tab
// standing (see the release handler), which is right for the files tab and
// would otherwise leave a composer over a session this UI no longer holds.
function dropConversationSession() {
  if (appEl.dataset.tab === 'conversation') showConversation(null);
}

// The third view. Same shape as activateFilesTab: the terminal iframe is
// hidden, never unloaded - window.term has to survive, because this view
// sends its input back out through it.
//
// The keybar goes with the terminal, same as on the files tab (the rule is in
// styles.css): every key on it is aimed at the terminal, and this view has
// grown its own control for each one it still needs.
function activateConversationTab() {
  tabTerminalEl.dataset.active = 'false';
  tabFilesEl.dataset.active = 'false';
  tabConversationEl.dataset.active = 'true';
  terminalFrameEl.style.display = 'none';
  appEl.dataset.tab = 'conversation';
  rememberTab('conversation');
  leaveFiles();
  leaveCopyText();
  showConversation(openSessionRow());
  updateOnboardingWizard(allAccounts(), projects);
}

// Plain-text hint about the open session's auth state. Deliberately a
// dedicated element next to the error banner: that one shows errors of
// THIS UI and gets cleared by clearError(); an expired login, on the other
// hand, is a state of the session that has to stay until it's fixed.
function updateAuthBanner(session) {
  const display = AUTH_PROBLEM_DISPLAY[session?.authProblem?.kind] ?? null;
  if (!display) {
    authBannerEl.style.display = 'none';
    authBannerEl.textContent = '';
    authBannerEl.removeAttribute('data-kind');
    return;
  }
  authBannerEl.replaceChildren(svgNode(display.icon, 'icon-symbol'), document.createTextNode(display.text));
  authBannerEl.dataset.kind = session.authProblem.kind;
  authBannerEl.style.display = '';
}

// Which session was last open, so a reload lands back there instead of on
// an empty screen. Deliberately only project and session id: everything
// else (account, auth state, whether it's still running) comes fresh from
// the server on the next load anyway and would just be a staling copy here.
const LAST_SESSION_KEY = 'claudux-last-session';
// Last chosen account, so the selection doesn't fall back to the first
// entry on every render. The list gets completely rebuilt on every change
// (see render()), so state held purely in the DOM would be gone again
// after every click.
//
// Kept per project, not globally: a single key would let a switch that was
// only meant to pin a default in ONE project bleed into all other
// projects.
//
// The key names the value type: ids and names under one key would collide.
const LAST_ACCOUNT_PREFIX = 'claudux-last-account-id:';

function lastAccount(projectId) {
  try {
    return localStorage.getItem(LAST_ACCOUNT_PREFIX + projectId);
  } catch {
    return null;
  }
}

function rememberAccount(projectId, accountId) {
  try {
    localStorage.setItem(LAST_ACCOUNT_PREFIX + projectId, accountId);
  } catch {
    // Private mode - then it just falls back to the first entry again.
  }
}

function rememberSession(project, session) {
  try {
    localStorage.setItem(
      LAST_SESSION_KEY,
      JSON.stringify({ projectId: project.id, sessionId: session.id }),
    );
  } catch {
    // Private mode or similar - then a reload just starts without a selection.
  }
}

function openSession(project, session) {
  // The previous session is no longer being watched from now on - report
  // that before currentSessionId gets overwritten, otherwise it would stay
  // marked as visible until it expires.
  if (currentSessionId && currentSessionId !== session.id) reportPresence(false);
  // An open usage popover belongs to the old session - leaving it up would
  // mean showing someone else's numbers over the new terminal.
  usage?.close();
  currentProject = project;
  currentSessionId = session.id;
  currentLoginSessionId = null; // a real session replaces the login terminal
  // The signpost belongs to the login terminal, not to the panel: over an
  // ordinary session it would point at a process that isn't running here.
  // The login itself stays in place - it's still reachable via settings.
  showLoginBanner(false);
  leaveCopyText(); // otherwise the previous session's text would sit in front of the new one
  rememberSession(project, session);
  sendHeartbeat();
  terminalFrameEl.src = withTerminalOptions(session.terminalUrl);
  updateAccountBadge(session);
  updateAuthBanner(session);
  activateTerminalTab();
  restoreLastTab();
  // Mobile (see media query in styles.css): the sidebar and terminal panel
  // don't share the screen, so opening a session actively switches to the
  // panel view. On wide screens data-view has no effect (both columns
  // stay visible side by side).
  appEl.dataset.view = 'panel';
  render(searchInputEl.value); // refreshes the row's data-active mark
}

// The login terminal runs in the large main panel instead of a sidebar
// box: the OAuth URL generated there is too long to be readable and
// copyable in a narrow iframe. currentProject/currentSessionId are
// deliberately set to null, so that neither a real session row is
// wrongly marked active nor the files tab would have a sensible target
// URL.
function openLoginTerminal(terminalUrl) {
  currentProject = null;
  currentSessionId = null;
  // The tmux session sits in the `arg` parameter of the ttyd address -
  // the only place the frontend learns it from. Without it, the text view
  // would show nothing, of all places on the login terminal.
  currentLoginSessionId = new URL(terminalUrl, location.origin).searchParams.get('arg');
  // A login terminal has no session, and thus no usage numbers. The agent
  // windows are not tied to the terminal at all - they belong to their
  // sidebar row and stay where they are.
  usage?.close();
  terminalFrameEl.src = withTerminalOptions(terminalUrl);
  // The account pill names the terminal's context, and a login terminal has
  // no account it would otherwise show - so the label goes there.
  updateAccountBadge({ loginTerminal: true });
  updateAuthBanner(null); // a login terminal is not a session with an auth state
  activateTerminalTab();
  appEl.dataset.view = 'panel';
  render(searchInputEl.value);
}

backBtnEl.addEventListener('click', () => {
  appEl.dataset.view = 'sidebar';
});

function closeOverlayMenu() {
  overlayMenuEl.hidden = true;
  overlayMenuBtnEl.setAttribute('aria-expanded', 'false');
  overlayGroupEl.dataset.menu = 'closed';
}

overlayMenuBtnEl.addEventListener('click', () => {
  const opening = overlayMenuEl.hidden;
  overlayMenuEl.hidden = !opening;
  overlayMenuBtnEl.setAttribute('aria-expanded', String(opening));
  overlayGroupEl.dataset.menu = opening ? 'open' : 'closed';
});

// Closing on a tap elsewhere runs via pointerdown instead of click: the
// account pill of the usage popover stops the propagation of its own click
// event - a click handler here would thus never hear a tap on the pill,
// and both menus would end up open at the same time. pointerdown still
// gets through.
document.addEventListener('pointerdown', (event) => {
  if (overlayMenuEl.hidden) return;
  if (overlayMenuEl.contains(event.target)) return;
  // The button itself is excluded because it toggles on its own: otherwise
  // this pointerdown would close the menu, and its click would immediately
  // reopen it.
  if (overlayMenuBtnEl.contains(event.target)) return;
  closeOverlayMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeOverlayMenu();
  closeCopyMenu();
});

overlayMenuTextEl.addEventListener('click', () => {
  closeOverlayMenu();
  openCopyMenu();
});

// Release the terminal without ending the session. Deliberately separate
// from the back button: that one only switches the view and leaves the
// connection standing - someone who glances at the list and comes back
// shouldn't have to pay for a rebuild of the history every time (see
// releaseTerminal()).
//
// The remembered session goes along with it: releasing means "no terminal
// here right now", and a reload would otherwise bring it straight back.
overlayMenuReleaseEl.addEventListener('click', () => {
  closeOverlayMenu();
  if (currentSessionId) reportPresence(false);
  usage?.close();
  releaseTerminal();
  currentSessionId = null;
  currentLoginSessionId = null; // the iframe now shows about:blank
  leaveCopyText();
  dropConversationSession();
  // currentProject stays: the files tab shows the project folder and is
  // just as usable without an open terminal.
  updateAccountBadge(null);
  updateAuthBanner(null);
  try {
    localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // Private mode or similar - then the entry just stays put.
  }
  // On narrow screens an empty panel would otherwise be on screen; on wide
  // ones data-view has no effect (both columns stay visible).
  appEl.dataset.view = 'sidebar';
  showToast('Terminal released – the session keeps running.');
  render(searchInputEl.value);
});

// Checked entry point into the copy menu, shared by the keybar button and
// the overflow menu: toggleCopyMenu() checks nothing and would fetch
// /api/sessions/null/pane with no session open. The keybar is mobile-only
// (hidden from 721px up), so on desktop the overflow menu is the only way
// in; the tmux-buffer path stays on Ctrl+C / Cmd+C (see terminal.js).
//
// Wired here rather than in terminal.js because the open session lives
// here; toggleCopyMenu() takes it as a parameter, like js/files.js.
function openCopyMenu() {
  const session = currentSessionId ?? currentLoginSessionId;
  if (!session) {
    showError('No open terminal – open a session first.');
    return;
  }
  toggleCopyMenu(session);
}

copySelectionBtnEl.addEventListener('click', openCopyMenu);

// Tab switch between the terminal (ttyd iframe), the built-in file view
// (js/files.js) and the conversation (js/conversation.js). The keybar sends
// synthetic keyboard events into the ttyd iframe and is therefore hidden on
// the files tab - but not on the conversation tab, which uses it as its own
// keyboard.
//
// Deliberately tied only to currentProject and not to currentSessionId:
// after "release terminal" the project stays selected, and the files tab
// is usable even without an open terminal.
tabTerminalEl.addEventListener('click', activateTerminalTab);

// Not a bare function reference: addEventListener would pass the click's
// MouseEvent as activateFilesTab's first argument, landing in its `project`
// parameter instead of falling through to the currentProject default.
tabFilesEl.addEventListener('click', () => activateFilesTab());
tabConversationEl.addEventListener('click', activateConversationTab);

// Client-side filter over project and session names (visibility only, no
// server request) – render() automatically expands projects with matches,
// see the comment there.
searchInputEl.addEventListener('input', () => {
  render(searchInputEl.value);
});

// See js/appearance.js: light/dark, palette, terminal bell and border,
// and the collapsed sidebar - all four write a data attribute on the root
// element that styles.css resolves.
initAppearance();

// Resolves the click link of a push notification (#/session/<id>, see
// src/routes/notify.js). The project can't be derived from the id alone,
// so it's searched for across all loaded projects.
function sessionFromAddressBar() {
  const match = /^#\/session\/([a-zA-Z0-9-]{1,80})$/.exec(location.hash);
  if (!match) return null;
  const sessionId = match[1];
  const project = projects.find((p) => p.sessions.some((sess) => sess.id === sessionId));
  return project ? { projectId: project.id, sessionId } : null;
}

// Restores the last open session - even an ended one. Always via the
// resume route, like a click on its row: `live` in `project.sessions` is
// frozen from the last list load, and the tmux session can die while the
// phone sleeps. Only the resume route can tell a corpse from a live
// session; for one that is actually running it stays at this single call.
// Under tight memory, the restart case is deliberately accepted.
async function restoreLastSession() {
  // A link from a notification takes priority: whoever taps it wants to
  // see exactly that session, not whichever was last open.
  let remembered = sessionFromAddressBar();
  if (!remembered) {
    try {
      remembered = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || 'null');
    } catch {
      return;
    }
  }
  if (!remembered?.projectId || !remembered?.sessionId) return;

  const project = projects.find((p) => p.id === remembered.projectId);
  const session = project?.sessions.find((sess) => sess.id === remembered.sessionId);
  if (!session) return;

  // Same guard as every other caller of the resume route (see
  // resumeInFlightIds): the sidebar is already rendered and tappable while
  // this fetch sits in waitForSession, so a tap on the same row in that
  // window would otherwise double-POST.
  if (resumeInFlightIds.has(session.id)) return;
  resumeInFlightIds.add(session.id);
  try {
    const res = await fetch(`/api/sessions/${session.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // accountId can be null (legacy session without a stored mapping).
      // The route then chooses itself as long as exactly one account is
      // set up, and otherwise responds with 400 - which stays silent
      // here, see catch.
      body: JSON.stringify({ projectId: project.id, accountId: session.accountId }),
    });
    await checkResponse(res);
    const { terminalUrl, restoredAfterCrash } = await res.json();
    // Expand the project so the restored row is also visibly marked in
    // the list and doesn't disappear inside a collapsed project.
    project.open = true;
    openSession(project, { ...session, terminalUrl, live: true });
    // Same reason as for a click on a row: a session resumed here was
    // still marked as ended in the data model, so its status dot would
    // stay gray and the end-session button hanging off it unreachable.
    await refreshProjectSessions(project);
    showCrashToast(restoredAfterCrash);
  } catch {
    // Session not resumable (gone in the meantime, account ambiguous) -
    // then it stays at the empty view. A reload is not the moment for an
    // error message about something the user didn't even request.
  } finally {
    resumeInFlightIds.delete(session.id);
  }
}

// The wizard starts back at null after every load: a login that's still
// running server-side is unknown to the freshly loaded frontend. The
// fields have to match that - browsers otherwise restore their values on
// their own on reload, and `autocomplete="off"` alone doesn't prevent
// that everywhere. A name that survives the page looks like a process
// that's still running.
resetWizard();

// Deliberate order: loadAccounts() first and awaited, so `knownAccounts`
// is already populated on the first render – otherwise every project
// would wrongly show the "no account" hint on initial load, even if
// accounts exist.
loadAccounts()
  .then(loadProjects)
  .then(restoreLastSession);

// ---------- Heartbeat: which session is someone currently looking at? ----------
//
// A notification goes out after EVERY finished reply - even while someone
// is sitting in front of it reading along, where it would just be noise.
// The server therefore suppresses it for a session that's reported here as
// open AND visible (see src/lib/presence.js).
//
// "Visible" means: this session is open and the tab is in the foreground.
// A tab in the background or a locked device doesn't count - that's
// exactly when the notification should come through.
const HEARTBEAT_MS = 20_000; // the server side lets a report stay valid for 45s

function reportPresence(visible) {
  if (!currentSessionId) return;
  fetch('/api/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: currentSessionId, visible }),
    // On a hidden tab the browser sometimes cancels in-flight requests.
    // keepalive lets exactly this un-report get through anyway - otherwise
    // the session would stay marked visible until it expires, and the next
    // notification would be suppressed at exactly the moment someone
    // looked away.
    keepalive: true,
  }).catch(() => {
    // A missed heartbeat has no consequence: the report expires on the
    // server side on its own; in doubt, one notification too many arrives
    // rather than none.
  });
}

function sendHeartbeat() {
  reportPresence(document.visibilityState === 'visible');
}

setInterval(sendHeartbeat, HEARTBEAT_MS);
// Report immediately instead of waiting for the next tick - otherwise the
// session that was just opened could still get a notification for up to
// 20 seconds.
document.addEventListener('visibilitychange', sendHeartbeat);

// ---------- Session list tick ----------
//
// Anything that happens without this browser's involvement - a session
// started elsewhere, one ended by the reaper, an expired login - is only
// picked up here.
//
// Nothing is fetched on a hidden tab: nobody's looking at the list anyway,
// and on the phone the device would otherwise stay awake for nothing.
const LIST_TICK_MS = 15_000;

// A guard against overlapping runs: a tick fetches the sessions of EVERY
// project, and a project with a three-digit history reads every JSONL
// file while doing so. If the tick coincides with coming back from the
// background - the normal case on the phone - two full rounds would
// otherwise run at once.
let tickRunning = false;
async function loadListSilently() {
  if (tickRunning || document.visibilityState !== 'visible') return;
  tickRunning = true;
  try {
    // Before the projects, because loadProjects() decides from the
    // signature whether it rebuilds - and that signature contains the
    // accounts (see sessionSignature).
    await loadAccounts({ still: true });
    await loadProjects({ still: true });
  } finally {
    tickRunning = false;
  }
  healCrashedOpenSession();
}

// Which open sessions already got one heal attempt, so a session that
// crashes again right after `--resume` does not get retried
// every 15 seconds - that would be the restart loop the design forbids.
// An id is only released once the list reports its row `live: true` again,
// not merely once `crashed` clears - a session that dies again immediately
// still reports `dead`/non-live on the very next tick.
const healAttempted = new Set();

// The tick-triggered half of crash recovery: visibilitychange never fires
// while the tab stays in the foreground, so a crash with the chat open and
// visible used to sit on tmux's "Pane is dead" line until the next tap.
// Reuses healOpenSessionOnReturn as-is (same fetch, iframe handling, toast)
// rather than duplicating it - the tick only decides WHETHER to call it.
function healCrashedOpenSession() {
  const project = currentProject;
  if (!project || !currentSessionId) return;
  // Via openSessionId, not a direct id lookup: after a /clear,
  // currentSessionId still names the carrier's PRE-clear row, whose
  // `current` (and with it `live`) can never become true again - the
  // release below would then never fire. openSessionId resolves to
  // whichever row is actually current for that carrier (see its own
  // comment). The attempted-set below still keys on currentSessionId
  // itself - it identifies the open session across ticks, not the row.
  const row = project.sessions?.find((s) => s.id === openSessionId(project.sessions));
  if (!row) return;
  if (row.live) {
    healAttempted.delete(currentSessionId);
    return;
  }
  // A deliberate `/exit` leaves the pane dead but the death wanted - the
  // terminal closes instead of healing.
  if (row.cleanExit && !resumeInFlightForCarrier(project, row)) {
    healAttempted.delete(currentSessionId);
    closeCleanlyExitedSession(project, currentSessionId);
    return;
  }
  if (!row.crashed || healAttempted.has(currentSessionId)) return;
  healAttempted.add(currentSessionId);
  // Not awaited: loadListSilently has already released tickRunning above,
  // and healOpenSessionOnReturn's own fetch can take up to two seconds
  // (waitForSession) - awaiting it here would stall the next tick.
  healOpenSessionOnReturn();
}

// Carrier-scoped, not id-scoped: after two /clears the carrier has three
// rows in the list, and a resume kicked off from ANY of them - the tick's
// own healOpenSessionOnReturn call, or a manual tap on a different row of
// the same carrier - locks the same tmux session underneath all of them.
function resumeInFlightForCarrier(project, row) {
  return project.sessions?.some((s) => s.carrier === row.carrier && resumeInFlightIds.has(s.id)) ?? false;
}

// `row` can already be stale by the time healCrashedOpenSession decides to
// call this: on the wake path, visibilitychange fires loadListSilently and
// healOpenSessionOnReturn together, and loadListSilently's own project-wide
// fetch (with its per-session capturePane, across every project) can
// outlast a resume that healOpenSessionOnReturn already completed and wrote
// fresher data into project.sessions via refreshProjectSessions -
// Object.assign in loadProjects would then overwrite that fresh data right
// back with the stale corpse it read. A one-project re-fetch and a re-check
// right before acting closes that window - the same protection
// healOpenSessionOnReturn already applies to its own response.
//
// fetchProjectSessions() also updates the auth banner for whatever session
// is open according to `sessions` - harmless here: if the open session
// changed to a different project in the meantime, that id won't resolve in
// THIS project's `sessions` and the call is a no-op; if it's still this
// session, the banner ends up cleared anyway by closeOpenTerminal() right
// below, or otherwise reflects the now-current open session correctly.
async function closeCleanlyExitedSession(project, sessionId) {
  let sessions;
  try {
    sessions = await fetchProjectSessions(project);
  } catch {
    return; // next tick tries again with fresher data
  }
  if (currentSessionId !== sessionId) return; // moved on while this was in flight
  const row = sessions.find((s) => s.id === openSessionId(sessions));
  project.sessions = sessions;
  if (!row || !row.cleanExit || resumeInFlightForCarrier(project, row)) return;
  // Stops the reconnect watchdog before the terminal disappears from under
  // it. endSession's caller is a tap in the sidebar - nowhere near the
  // watchdog's target document - but this path can fire while that exact
  // document is still on screen. closeOpenTerminal() right after still
  // clears the iframe itself; this only adds the teardown it doesn't do.
  releaseTerminal();
  closeOpenTerminal();
  // The tick can fire while the panel is open on mobile - unlike
  // endSession's own caller, there's no view to fall back to otherwise:
  // data-view="panel" hides the sidebar outright (see styles.css). Same
  // switch the release handler makes for the same reason.
  appEl.dataset.view = 'sidebar';
  render(searchInputEl.value);
}

setInterval(loadListSilently, LIST_TICK_MS);
// Immediately on returning instead of waiting up to 15 seconds - the
// moment you look again is exactly the moment the list should be correct.
document.addEventListener('visibilitychange', loadListSilently);

// ttyd's own reconnect on visibilitychange (terminal.js) attaches straight
// to a crashed session's corpse - it never asks anyone. Only the resume
// route can tell a corpse from a live session, reap it, and restart it, so
// ask it here too. A live session's answer carries the URL already loaded,
// so nothing changes; a session that was gone (reaped, or /clear's carrier
// expired) gets its iframe pointed at the new one.
//
// Guarded by resumeInFlightIds, shared with every other caller of the
// resume route (see its declaration) - a resume call starts tmux
// processes, and two overlapping ones for the same name would race.
//
// `forceReload` is for the stuck-overlay watchdog in terminal.js: there the
// session is usually alive and unchanged, so every reason below to reload
// says no - while the frame in front of it hangs on a connection that will
// never come back. Asking the route first still matters, because it is what
// tells a live session from a corpse.
//
// Returns false when the guard turned it away without asking anyone - the
// watchdog counts its allowance in attempts that reached the route, and on
// return from the background this call and the watchdog's both fire within
// seconds of each other.
async function healOpenSessionOnReturn({ forceReload = false } = {}) {
  if (document.visibilityState !== 'visible') return true;
  if (!currentProject || !currentSessionId) return true;
  const project = currentProject;
  const sessionId = currentSessionId;
  if (resumeInFlightIds.has(sessionId)) return false;
  const session = project.sessions?.find((sess) => sess.id === sessionId);
  resumeInFlightIds.add(sessionId);
  try {
    const res = await fetch(`/api/sessions/${sessionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, accountId: session?.accountId ?? null }),
      // Claudux and ttyd share an origin, so the half-open network path that
      // hangs ttyd's own reconnect hangs this POST just as well - and this
      // one holds resumeInFlightIds until it settles, which blocks both the
      // stuck-terminal watchdog and a tap on the session. Well above what
      // starting tmux takes, far below waiting for the OS to give up.
      signal: AbortSignal.timeout(RESUME_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const { terminalUrl, restarted, restoredAfterCrash } = await res.json();
    // The await above can take seconds. If the user has since moved on -
    // opened a different session, or released this one - the response no
    // longer belongs to what's on screen.
    if (currentSessionId !== sessionId) return;
    if (!terminalUrl) return;
    // A crash and a reaper kill both restart the session under its own
    // name, so the URL string alone can't tell reload-worthy apart from
    // unchanged - only the route knows via `restarted`. The rotation/theme
    // case (arg unchanged, options changed) still must not reload, so the
    // full option string stays out of the comparison either way.
    const argOf = (url) => new URLSearchParams((url ?? '').split('?')[1] ?? '').get('arg');
    const currentArg = argOf(terminalFrameEl.getAttribute('src'));
    const nextArg = argOf(terminalUrl);
    if (restarted || currentArg !== nextArg || forceReload) {
      // withTerminalOptions() reads the CURRENT font size/theme, so this is
      // byte-identical to the loaded src exactly when neither changed while
      // the session sat dead - the only case with nothing to resync.
      const nextSrc = withTerminalOptions(terminalUrl);
      if (nextSrc === terminalFrameEl.getAttribute('src') && terminalFrameEl.contentWindow) {
        // Assigning the same string again is not guaranteed to navigate.
        // Reloading the document in place is - and it keeps the frame
        // filled while it happens, where a bounce through about:blank
        // showed an empty terminal for its duration and could lose the
        // race against its own second assignment (about:blank resolves
        // asynchronously and could land AFTER the real URL, undoing it).
        terminalFrameEl.contentWindow.location.reload();
      } else {
        // The query string in `src` still carries the font size/theme from
        // when the session was opened, so a changed one has to be assigned
        // rather than reloaded.
        terminalFrameEl.src = nextSrc;
      }
    }
    showCrashToast(restoredAfterCrash);
  } catch {
    // Nothing to report: the user didn't ask for this, and the list tick
    // right next to it will show the real state anyway.
  } finally {
    resumeInFlightIds.delete(sessionId);
  }
}

// Wrapped rather than passed directly: the listener would hand the event in
// as the options object.
document.addEventListener('visibilitychange', () => healOpenSessionOnReturn());

// ttyd's "Reconnecting..." can hang forever - see isTerminalStuck() in
// terminal.js for why. The way out is the same route as on return from the
// background, only with the reload no longer optional.
setStuckTerminalRecovery(() => healOpenSessionOnReturn({ forceReload: true }));

// See js/viewport.js: keyboard height, the drag-off-screen guard, and the
// ?debug=viewport overlay.
initViewport();

// ---------- Edit mode ----------
// The remove mark on projects only appears when this mode is on.
// Deliberately NOT remembered: it's off again after a reload. A
// permanently armed delete button would be more convenient, but that
// convenience is weighed here against an accidental removal - and adding
// a project back costs more than a checkbox.
const editModeToggleEl = document.getElementById('editModeToggle');
editModeToggleEl.addEventListener('change', () => {
  appEl.dataset.edit = editModeToggleEl.checked ? 'on' : 'off';
});

// Usage popover on the account pill. Fetching it costs a mini request on
// the server against the account's quota (see src/lib/rateLimits.js) -
// hence only on tap, never in the background.
usage = initUsage({
  badgeEl: accountBadgeEl,
  popoverEl: usagePopoverEl,
  backdropEl: usageBackdropEl,
  sessionId: () => currentSessionId,
  load: async (id) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/usage`);
    await checkResponse(res);
    return res.json();
  },
  accountName: (id) => accountById(id)?.name ?? null,
  accounts: allAccounts,
  onSwitchAccount: async (accountId) => {
    const project = currentProject;
    if (!project) return;
    // The row the switch applies to - after a /clear that isn't the id in
    // currentSessionId, which is why openSessionId() exists.
    const id = openSessionId(project.sessions ?? []);
    const session = (project.sessions ?? []).find((s) => s.id === id);
    if (!session) return;
    await restartWithAccount(project, session, accountId);
  },
});

// Clickable file paths in the terminal (see js/terminalLinks.js). Same DI
// shape as initUsage() above: a live getter instead of a snapshot, because
// the project open at click time may not be the one open when this ran.
initTerminalLinks({
  getCurrentProject: () => currentProject,
  getAllProjects: () => projects,
  activateFilesTab,
});

// Needs nothing from here: it reads its own route and owns its two views.
initUpdate();
initClaudeCodeUpdate();

// PWA: register a service worker, only so the browser offers the "Add to
// home screen" install flow – no offline caching.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // E.g. when the page is opened over an unencrypted LAN IP instead of
    // https:// – service workers aren't allowed there. No user-visible
    // error needed, the home-screen feature is optional.
  });
}
