// The settings window: the dialog itself, its tabs, and everything the
// Projects and Sessions tabs show - the list of added folders, one folder's
// settings, the folder browser behind "+ Add folder", and the overview of
// sessions held back from the reaper.
//
// The Appearance, Accounts and Access tabs are only reached from here; what
// they show belongs to appearance.js, accounts.js and access.js.
//
// Reads the project model but never writes it: adding, removing, favouring
// and assigning a default account all go through app.js, which owns the
// model and re-renders the sidebar. Those arrive through
// initManageDialog(), the same DI shape the other modules here use.
import { showError, clearError, showToast, escapeHtml, checkResponse } from './messages.js';
import { svgNode } from './icons.js';
import { allAccounts, resumeWizardTracking, suspendWizard } from './accounts.js';
import { showNotificationTargets, showPushActivation } from './notifications.js';
import { showAccessSettings } from './access.js';

let allProjects = () => [];
let changeSession = async () => {};
let removeProject = async () => {};
let setProjectDefaultAccount = async () => {};
let toggleFavorite = async () => {};
let loadProjects = async () => {};

export function initManageDialog(deps) {
  allProjects = deps.allProjects;
  changeSession = deps.changeSession;
  removeProject = deps.removeProject;
  setProjectDefaultAccount = deps.setProjectDefaultAccount;
  toggleFavorite = deps.toggleFavorite;
  loadProjects = deps.loadProjects;
}

// ---------- Management window ----------
// showModal() instead of a custom overlay: Escape, focus trap, and the
// dimmed background come from the browser.
const manageDialogEl = document.getElementById('manageDialog');

// This is where it gets tight: every running session permanently uses a
// few hundred megabytes. The idle reaper is the brake against that -
// protecting many sessions defeats it. Then eventually it's not the
// oldest that dies from lack of memory, but SOME ONE of them.
const PROTECTED_WARN_THRESHOLD = 3;

function protectedSessions() {
  return allProjects().flatMap((p) =>
    p.sessions.filter((sess) => sess.protected).map((sess) => ({ project: p, session: sess })),
  );
}

// Asked by the session row when a session is about to be protected: that
// is the moment the count matters, not the one where this window is opened.
// Returns the message rather than the number, so the threshold stays here
// with the overview that explains it.
export function protectionWarning() {
  const after = protectedSessions().length + 1;
  return after > PROTECTED_WARN_THRESHOLD
    ? `${after} protected sessions – each one permanently uses memory.`
    : null;
}

// Builds the overview in the settings menu from the already loaded data
// model - a dedicated endpoint for this would be superfluous, the list
// already knows the state.
function renderProtectedList() {
  const entries = protectedSessions();
  const head = document.getElementById('protectedHead');
  const list = document.getElementById('protectedList');

  head.textContent = `Protected sessions (${entries.length})`;
  head.dataset.warn = entries.length > PROTECTED_WARN_THRESHOLD ? 'true' : 'false';
  list.innerHTML = '';

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-hint';
    empty.textContent = 'None – every session gets cleaned up once it has been idle long enough.';
    list.appendChild(empty);
    return;
  }

  for (const { project, session } of entries) {
    const row = document.createElement('div');
    row.className = 'protected-row';
    row.innerHTML =
      `<span class="protected-title" title="${escapeHtml(project.name)} › ${escapeHtml(session.title)}">` +
      `${escapeHtml(session.title)}</span>` +
      `<span class="protected-project">${escapeHtml(project.name)}</span>` +
      '<button type="button" class="btn-ghost">release</button>';
    row.querySelector('button').addEventListener('click', async () => {
      await changeSession(project, session, { protected: false });
      renderProtectedList();
    });
    list.appendChild(row);
  }

  if (entries.length > PROTECTED_WARN_THRESHOLD) {
    const warning = document.createElement('p');
    warning.className = 'settings-warn';
    warning.textContent =
      `${entries.length} protected sessions permanently use memory. ` +
      'Once the machine runs out, some session dies from lack of memory – not necessarily the oldest one.';
    list.appendChild(warning);
  }
}

// Which project's settings the Projects tab shows; null shows the list.
// Kept here rather than read back out of the DOM.
let manageProjectId = null;

function openProjectDetail(projectId) {
  manageProjectId = projectId;
  renderProjectManagement();
}

// Management view of the projects. The sidebar stays the working view
// with the sessions underneath; here it's the folder itself - the same
// split as with the accounts. Filled from the already loaded model, so no
// dedicated endpoint is needed.
export function renderProjectManagement() {
  const list = document.getElementById('projectManageList');
  list.replaceChildren();
  const open = allProjects().find((p) => p.id === manageProjectId);
  // A project removed while its detail view was open falls back to the
  // list instead of showing an empty pane.
  if (manageProjectId && !open) manageProjectId = null;

  // The heading and the add form belong to the list. Inside one project's
  // settings, "Added folders" and "Add folder" describe something else
  // entirely - the detail view brings its own heading.
  const heading = list.closest('.settings-section')?.querySelector('.settings-section-head');
  const addForm = document.getElementById('addProjectArea');
  if (heading) heading.hidden = Boolean(open);
  if (addForm) addForm.hidden = Boolean(open);

  if (open) return renderProjectDetail(open, list);

  if (allProjects().length === 0) {
    const hint = document.createElement('span');
    hint.className = 'accounts-empty-hint';
    hint.textContent = 'No folder added yet.';
    list.appendChild(hint);
    return;
  }
  for (const project of allProjects()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'manage-row manage-row-link';

    // Name and path as text nodes, not via innerHTML: both come from the
    // filesystem.
    const text = document.createElement('span');
    text.className = 'manage-text';
    const name = document.createElement('span');
    name.className = 'manage-name';
    name.textContent = project.name;
    const path = document.createElement('span');
    path.className = 'manage-path';
    path.textContent = project.path;
    text.append(name, path);

    // A chevron, not a delete icon: the row leads onward, and a delete a
    // finger's width from it is a trap on the phone.
    const chevron = svgNode('back', 'icon-symbol manage-chevron');

    row.append(text, chevron);
    row.addEventListener('click', () => openProjectDetail(project.id));
    list.appendChild(row);
  }
}

function renderProjectDetail(project, list) {
  const head = document.createElement('div');
  head.className = 'manage-detail-head';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn-quiet manage-action';
  back.title = 'Back to the folder list';
  back.setAttribute('aria-label', back.title);
  back.appendChild(svgNode('back', 'icon-symbol'));
  back.addEventListener('click', () => openProjectDetail(null));

  const text = document.createElement('span');
  text.className = 'manage-text';
  const name = document.createElement('span');
  name.className = 'manage-name';
  name.textContent = project.name;
  const path = document.createElement('span');
  path.className = 'manage-path';
  path.textContent = project.path;
  text.append(name, path);
  head.append(back, text);

  // Favorite: the same function as the star in the sidebar, so the two
  // marks cannot disagree.
  const favoriteBtn = document.createElement('button');
  favoriteBtn.type = 'button';
  favoriteBtn.className = 'settings-item';
  const drawFavorite = () => {
    favoriteBtn.replaceChildren(
      svgNode(project.favorite ? 'starFull' : 'star', 'icon-symbol'),
      document.createTextNode(project.favorite ? 'Favorite' : 'Not a favorite'),
    );
  };
  drawFavorite();
  favoriteBtn.addEventListener('click', async () => {
    await toggleFavorite(project);
    drawFavorite();
  });

  const account = document.createElement('label');
  account.className = 'settings-item settings-item-select';
  account.appendChild(document.createTextNode('Default account'));
  const accountSelect = document.createElement('select');
  accountSelect.className = 'settings-select';
  const noDefault = document.createElement('option');
  noDefault.value = '';
  noDefault.textContent = 'None';
  accountSelect.appendChild(noDefault);
  for (const known of allAccounts()) {
    const option = document.createElement('option');
    option.value = known.id;
    option.textContent = known.name;
    accountSelect.appendChild(option);
  }
  accountSelect.value = project.defaultAccountId ?? '';
  accountSelect.addEventListener('change', async () => {
    try {
      await setProjectDefaultAccount(project, accountSelect.value || null);
    } catch (err) {
      showError(`Could not save the default account: ${err.message}`);
      accountSelect.value = project.defaultAccountId ?? '';
    }
  });
  account.appendChild(accountSelect);

  // Three fixed values side by side rather than a dropdown: the same
  // control the notification targets pick their type with, and it shows
  // what the other two options are without being opened.
  const notify = document.createElement('div');
  notify.className = 'settings-item settings-item-stacked';
  const notifyLabel = document.createElement('span');
  notifyLabel.textContent = 'Notifications';
  const levels = document.createElement('div');
  levels.className = 'segmented';
  const LEVELS = [
    ['all', 'Everything'],
    ['blocking', 'Only blocking'],
    ['none', 'Nothing'],
  ];
  for (const [value, label] of LEVELS) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'palette-item';
    choice.textContent = label;
    choice.dataset.level = value;
    choice.dataset.active = String((project.notify ?? 'all') === value);
    choice.addEventListener('click', async () => {
      const previous = project.notify ?? 'all';
      if (previous === value) return;
      try {
        const res = await fetch(`/api/projects/${project.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notify: value }),
        });
        await checkResponse(res);
        clearError();
        // The server drops the field for 'all'; the model follows, so a
        // reopened view reads the same state the file holds.
        if (value === 'all') delete project.notify;
        else project.notify = value;
        for (const other of levels.children) {
          other.dataset.active = String(other.dataset.level === value);
        }
        showToast(`Notifications for ${project.name}: ${label.toLowerCase()}.`);
      } catch (err) {
        showError(`Could not save the notification level: ${err.message}`);
      }
    });
    levels.appendChild(choice);
  }
  notify.append(notifyLabel, levels);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'settings-item';
  remove.dataset.danger = 'true';
  remove.append(svgNode('close', 'icon-symbol'), document.createTextNode('Remove folder from the list'));
  // No return to the list here: removeProject redraws this tab itself, and
  // the guard above sends a detail view whose project is gone back to the
  // list. Doing it here as well would also close the view when the
  // confirmation was declined.
  remove.addEventListener('click', () => removeProject(project));

  list.append(head, favoriteBtn, account, notify, remove);
}

const manageTabsEl = document.getElementById('manageTabs');

function showTab(name) {
  manageTabsEl.querySelectorAll('.manage-tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  });
  manageDialogEl.querySelectorAll('.manage-pane').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== name;
  });
  // The bar scrolls sideways on the phone; a tab at the edge would
  // otherwise only be half visible, and when opening on one of the later
  // ones, not visible at all.
  manageTabsEl
    .querySelector(`.manage-tab[data-tab="${name}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

manageTabsEl.addEventListener('click', (event) => {
  const tab = event.target.closest('.manage-tab');
  if (!tab) return;
  showTab(tab.dataset.tab);
  // Refresh when switching there: between opening the window and this
  // click, a session may have been released or ended.
  if (tab.dataset.tab === 'sessions') renderProtectedList();
  if (tab.dataset.tab === 'projects') { renderProjectManagement(); loadFolderBrowser(null); }
  if (tab.dataset.tab === 'access') renderAccessSettings();
});

// Wired when switching there rather than on open: the pane asks the server
// for the current lifetime, and that is a request nobody needs who opens the
// window for the palette.
function renderAccessSettings() {
  showAccessSettings({
    ttlList: document.getElementById('ttlList'),
    passwordForm: document.getElementById('passwordForm'),
    currentInput: document.getElementById('currentPassword'),
    nextInput: document.getElementById('nextPassword'),
    signOutBtn: document.getElementById('signOut'),
    signOutAllBtn: document.getElementById('signOutAll'),
  });
}

// Both areas together, because activating a device changes the list and
// removing its row changes the activation area - each has to redraw the
// other.
function renderNotificationSettings() {
  showNotificationTargets(
    document.getElementById('notifyTargets'),
    document.getElementById('notifyAddArea'),
    renderNotificationSettings,
  );
  showPushActivation(document.getElementById('pushActivation'), renderNotificationSettings);
}

// The list of protected sessions is filled when OPENING, not on every
// list render: the window is almost always closed, and the state can
// have changed by the time it's opened.
export function openManagement(tab) {
  showTab(tab);
  renderProtectedList();
  // Always opens on the list, not on the project that happened to be open
  // the last time.
  manageProjectId = null;
  renderProjectManagement();
  if (tab === 'projects') loadFolderBrowser(null);
  // Fetched on open rather than kept in the loaded model: the targets have
  // no place in the session list, and this is the only view that shows them.
  renderNotificationSettings();
  resumeWizardTracking();
  manageDialogEl.showModal();
}

document.getElementById('manageToggle').addEventListener('click', () => openManagement('projects'));
document.getElementById('settingsOpen').addEventListener('click', () => openManagement('appearance'));
document.getElementById('manageClose').addEventListener('click', () => manageDialogEl.close());

// On the close event instead of the close button: Escape and a click on
// the background close the window too, and a tick that kept running
// without a visible wizard would query the server pointlessly for
// minutes.
manageDialogEl.addEventListener('close', suspendWizard);
// A click on the dimmed border also closes it. The window itself is the
// click target when the click lands beside it - hence the comparison
// with event.target instead of an overlay element.
manageDialogEl.addEventListener('click', (e) => {
  if (e.target === manageDialogEl) manageDialogEl.close();
});

// Folder browser for "+ Add folder": always visible in the Projects tab,
// no toggle to open it first. Clicking a folder navigates into it; the "+"
// next to a row, or "Add this folder" for the folder currently open, both
// lead into the same inline name confirmation before POST /api/projects.
const folderBrowserPathEl = document.getElementById('folderBrowserPath');
const folderBrowserAddCurrentEl = document.getElementById('folderBrowserAddCurrent');
const folderBrowserListEl = document.getElementById('folderBrowserList');
const addProjectConfirmEl = document.getElementById('addProjectConfirm');
const addProjectConfirmNameEl = document.getElementById('addProjectConfirmName');
let browserCurrentPath = null;
let pendingProjectPath = null;

async function loadFolderBrowser(targetPath) {
  try {
    // No path at all (not even an empty one) when targetPath is falsy -
    // the server then defaults to its own start directory. An empty
    // `?path=` would instead resolve to the server's own cwd.
    const url = targetPath ? `/api/browse?path=${encodeURIComponent(targetPath)}` : '/api/browse';
    const res = await fetch(url);
    await checkResponse(res);
    const { path: resolvedPath, parent, dirs } = await res.json();
    clearError();
    browserCurrentPath = resolvedPath;
    folderBrowserPathEl.textContent = resolvedPath;
    folderBrowserListEl.innerHTML = '';

    if (parent !== null) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'folder-browser-open';
      upBtn.replaceChildren(svgNode('back', 'icon-symbol'),
        document.createTextNode('.. (parent folder)'));
      upBtn.addEventListener('click', () => loadFolderBrowser(parent));
      folderBrowserListEl.appendChild(upBtn);
    }
    if (dirs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-browser-empty';
      empty.textContent = 'No subfolders.';
      folderBrowserListEl.appendChild(empty);
    }
    for (const dir of dirs) {
      const dirPath = `${resolvedPath}/${dir}`;
      const row = document.createElement('div');
      row.className = 'folder-browser-row';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'folder-browser-open';
      // Text node, not innerHTML: dir comes from the real filesystem.
      open.replaceChildren(svgNode('folder', 'icon-symbol'), document.createTextNode(dir));
      open.addEventListener('click', () => loadFolderBrowser(dirPath));

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn-quiet manage-action';
      add.title = `Add "${dir}"`;
      add.setAttribute('aria-label', add.title);
      add.appendChild(svgNode('plus', 'icon-symbol'));
      add.addEventListener('click', () => openAddConfirm(dirPath));

      row.append(open, add);
      folderBrowserListEl.appendChild(row);
    }
  } catch (err) {
    showError(`Could not load folder: ${err.message}`);
  }
}

function openAddConfirm(projectPath) {
  pendingProjectPath = projectPath;
  addProjectConfirmNameEl.value = projectPath.split('/').filter(Boolean).pop() ?? projectPath;
  addProjectConfirmEl.hidden = false;
  addProjectConfirmNameEl.focus();
  addProjectConfirmNameEl.select();
}

function closeAddConfirm() {
  pendingProjectPath = null;
  addProjectConfirmEl.hidden = true;
}

folderBrowserAddCurrentEl.addEventListener('click', () => {
  if (browserCurrentPath) openAddConfirm(browserCurrentPath);
});

document.getElementById('addProjectConfirmCancel').addEventListener('click', closeAddConfirm);

document.getElementById('addProjectConfirmSubmit').addEventListener('click', async () => {
  const name = addProjectConfirmNameEl.value.trim();
  if (!name || !pendingProjectPath) return;

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, projectPath: pendingProjectPath }),
    });
    await checkResponse(res);
    clearError();
    closeAddConfirm();
    await loadProjects();
    // The window stays open while adding - without this, the list above
    // would stay empty until the tab is switched once.
    renderProjectManagement();
    showToast(`Folder "${name}" added.`);
  } catch (err) {
    showError(`Could not create project: ${err.message}`);
  }
});

// The account area closes this window when the login moves into the
// terminal; app.js passes this on rather than reaching for the element.
export function closeManageDialog() {
  manageDialogEl.close();
}
