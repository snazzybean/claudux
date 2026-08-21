// The Files tab: navigate the project, view files, and save simple text
// edits. The logic behind it lives on the server (src/lib/file*.js) - this
// module only displays what it delivers.
//
// The module holds its own state and receives the project as a parameter:
// showFiles(project) when switching into the tab, leaveFiles() when leaving
// it. Deliberately no shared `export let` with app.js - an assignment from
// outside never reaches the importing module.
import { filesPanelEl } from './dom.js';
import { showToast, checkResponse } from './messages.js';
import { svg, fillAlertIcons } from './icons.js';
import { buildRow, buildTree, formatSize } from './fileTree.js';
import { makeResizable } from './resizer.js';

// Last opened directory per project: switching tabs returns there, not to
// the root.
const lastDirectory = new Map();

let project = null;
// Directory and open file are two states side by side, not an
// either/or: from 721px up, list and file are both on screen at once.
// Below that, filesPanelEl.dataset.fileView shows which of the two columns
// is visible (see styles.css) - that's where it stays when toggling.
let currentDirectory = null; // path relative to the project root; '' is the root
let directoryData = null; // the most recently loaded response, for redrawing
let activeFile = null; // { path, view, sourceView, editing }

// The tree needs several directories at once, the list exactly one. Both read
// from here: `loaded` maps a directory path to its response, `expanded` holds
// the folders that are open. Per project like lastDirectory above, so
// switching tabs comes back to the same tree instead of a collapsed root.
const loadedByProject = new Map();
const expandedByProject = new Map();

function treeState() {
  const id = project.id;
  if (!loadedByProject.has(id)) loadedByProject.set(id, new Map());
  if (!expandedByProject.has(id)) expandedByProject.set(id, new Set());
  return { loaded: loadedByProject.get(id), expanded: expandedByProject.get(id) };
}

const WIDE_QUERY = '(min-width: 721px)';
const isWideEnough = () => window.matchMedia(WIDE_QUERY).matches;

function api(path, subPath = '', extra = '') {
  const p = `project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(path)}`;
  return `/api/files${subPath}?${p}${extra}`;
}

function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

const TREE_DEFAULT_SHARE = 0.5; // the 50/50 the two columns had before

// The two columns exist permanently; only one of them is ever redrawn at a
// time - clearing the whole panel would stop list and file coexisting. The
// draggable edge between them is built here for the same reason: it has to
// outlive every redraw of either side.
function scaffold() {
  let tree = filesPanelEl.querySelector('.file-tree');
  if (!tree) {
    tree = document.createElement('div');
    tree.className = 'file-tree';
    const handle = document.createElement('div');
    handle.className = 'edge-handle edge-handle-files';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'File list width');
    const newMain = document.createElement('div');
    newMain.className = 'file-main';
    filesPanelEl.replaceChildren(tree, handle, newMain);
    filesPanelEl.dataset.fileView = 'list';
    // A deep tree needs more width than a flat list, and the file beside it
    // should stay readable - which of the two wins is not ours to decide.
    makeResizable(handle, {
      key: 'file-tree',
      fallback: filesPanelEl.getBoundingClientRect().width * TREE_DEFAULT_SHARE,
      apply: (width) => tree.style.setProperty('flex', `0 0 ${Math.round(width)}px`),
      measure: () => tree.getBoundingClientRect().width,
      limits: () => {
        const panel = filesPanelEl.getBoundingClientRect().width;
        return [200, Math.max(200, panel * 0.6)];
      },
    });
  }
  return { tree, main: filesPanelEl.querySelector('.file-main') };
}

// A dedicated error box inside the panel rather than the error bar above:
// that one belongs to session management, and an error while browsing
// shouldn't overwrite the message for an expired login.
function showError(text) {
  const box = document.createElement('div');
  box.className = 'file-error';
  box.textContent = text;
  scaffold().tree.replaceChildren(box);
}

function button(label, title, onClick, className = '') {
  const b = document.createElement('button');
  b.type = 'button';
  // 'primary' takes .btn-accent instead of .btn-surface/.btn-lift - the two
  // fill classes have equal CSS specificity, so applying both and letting
  // one win by source order would be fragile.
  const base = className === 'primary' ? 'btn-accent' : 'btn-surface btn-lift';
  b.className = `${base} file-btn ${className}`.trim();
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function iconButton(iconName, title, onClick) {
  const b = button('', title, onClick, 'file-btn-icon-only');
  b.innerHTML = svg(iconName, 'btn-icon');
  return b;
}

// ---------------------------------------------------------------- Navigation

// While a response is in flight, the user can switch projects or open a
// login terminal (where currentProject is null). Without this check, the
// returning response would render into the wrong view - or into none at
// all.
function isCurrent(id) {
  return project?.id === id;
}

// Fetches one directory into the cache. Returns null when the request failed
// or the project changed underneath - both cases where the caller must not go
// on rendering.
async function loadDirectory(path) {
  const projectId = project.id;
  try {
    const res = await fetch(api(path));
    await checkResponse(res);
    const data = await res.json();
    if (!isCurrent(projectId)) return null;
    treeState().loaded.set(data.path, data);
    return data;
  } catch (err) {
    if (!isCurrent(projectId)) return null;
    throw err;
  }
}

async function openDirectory(path) {
  let data;
  try {
    data = await loadDirectory(path);
  } catch (err) {
    // A deleted directory must not lead to a dead end: one level up is the
    // next place that might still exist.
    if (path) {
      showToast(`Directory no longer there – going up one level: ${err.message}`);
      return openDirectory(parentOf(path));
    }
    return showError(err.message);
  }
  if (!data) return;
  currentDirectory = data.path;
  directoryData = data;
  lastDirectory.set(project.id, data.path);
  renderBrowser();
}

// Opening is two steps: mark expanded and draw immediately, so the chevron
// turns without waiting for the response, then fill the level in once it
// arrives. Collapsing keeps the cached content - reopening costs no request.
async function toggleDirectory(path) {
  const { loaded, expanded } = treeState();
  if (expanded.has(path)) {
    expanded.delete(path);
    return renderBrowser();
  }
  expanded.add(path);
  renderBrowser();
  if (loaded.has(path)) return;
  try {
    if (await loadDirectory(path)) renderBrowser();
  } catch (err) {
    expanded.delete(path);
    showToast(`Folder not opened: ${err.message}`);
    renderBrowser();
  }
}

// Opens every folder along a path, so the tree shows a file that was reached
// from somewhere else - a terminal link, a markdown link, the last directory
// of the previous visit.
async function revealPath(directoryPath) {
  const { expanded } = treeState();
  const parts = directoryPath ? directoryPath.split('/') : [];
  const pending = [];
  let walked = '';
  for (const part of parts) {
    walked = walked ? `${walked}/${part}` : part;
    expanded.add(walked);
    pending.push(walked);
  }
  renderBrowser();
  for (const path of pending) {
    if (treeState().loaded.has(path)) continue;
    try {
      await loadDirectory(path);
    } catch {
      expanded.delete(path); // gone in the meantime - leave the level closed
    }
  }
  renderBrowser();
}

// `navigate: false` for a plain reload of the open file - otherwise
// refresh() would drag the list along on every click of "Reload".
async function openFile(path, { navigate = true, line = null } = {}) {
  const projectId = project.id;
  let view;
  try {
    const res = await fetch(api(path, '/view'));
    await checkResponse(res);
    view = await res.json();
    if (!isCurrent(projectId)) return;
  } catch (err) {
    if (!isCurrent(projectId)) return;
    showToast(`File not opened: ${err.message}`);
    return closeFile();
  }
  activeFile = { path: view.path, view, sourceView: false, editing: false };
  renderMain();
  if (line) scrollToLine(line);
  // The list always shows the open file's directory: on desktop it sits
  // next to it and must match the file, on mobile it's the way back.
  // This mainly concerns links in rendered markdown - those can point into
  // other directories too.
  const parent = parentOf(view.path);
  if (isWideEnough()) {
    // Nothing to navigate in the tree - the level is already on screen. What
    // it needs is the folders along the path to be open.
    if (navigate) return revealPath(parent);
    return renderBrowser();
  }
  if (navigate && parent !== currentDirectory) return openDirectory(parent);
  // Redraw only to update which row is marked active.
  if (directoryData) renderList(directoryData);
}

// From a terminal path click with a :line suffix (see terminalLinks.js).
// [data-line] only exists on rendered code (fileRender.js), not on the
// markdown view - a line number refers to the source file, and rendered
// markdown no longer has a 1:1 line mapping to it.
const LINE_HIGHLIGHT_MS = 2000;
function scrollToLine(line) {
  const el = filesPanelEl.querySelector(`.file-main [data-line="${line}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  // A class instead of a permanent state: nobody clears it otherwise, and
  // the next file opened would carry a stale highlight into unrelated code.
  el.classList.add('line-highlight');
  setTimeout(() => el.classList.remove('line-highlight'), LINE_HIGHLIGHT_MS);
}

// On desktop this clears the right column, on mobile it leads back to the
// list. The directory is reloaded in the process: Claude may be creating
// files in the terminal alongside it.
function closeFile() {
  activeFile = null;
  renderMain();
  if (isWideEnough()) return reloadTree();
  if (currentDirectory !== null) openDirectory(currentDirectory);
}

// Loads the root and every open folder again. Requests go out together: one
// per open folder, and waiting for them in turn would show the tree filling up
// level by level.
async function reloadTree() {
  if (!project) return;
  const { loaded, expanded } = treeState();
  loaded.clear();
  if (!await loadRoot()) return;
  await Promise.all([...expanded].map(async (path) => {
    try {
      await loadDirectory(path);
    } catch {
      expanded.delete(path); // gone in the meantime - leave the level closed
    }
  }));
  renderBrowser();
}

async function loadRoot() {
  try {
    return await loadDirectory('');
  } catch (err) {
    showError(err.message);
    return null;
  }
}

function refresh() {
  if (!project) return;
  // The cache goes, what is expanded stays: a reload should bring new files
  // into view, not collapse a tree somebody just opened.
  if (isWideEnough()) reloadTree();
  else if (currentDirectory !== null) openDirectory(currentDirectory);
  // Not while editing: reloading would replace the textarea's content and
  // with it the unsaved change.
  if (activeFile && !activeFile.editing) openFile(activeFile.path, { navigate: false });
}

// -------------------------------------------------------------------- Display

function buildHeader() {
  const header = document.createElement('div');
  header.className = 'file-header';
  return header;
}

function buildBreadcrumbs(path) {
  const nav = document.createElement('nav');
  nav.className = 'no-scrollbar file-breadcrumbs';
  nav.setAttribute('aria-label', 'Path');
  const parts = path ? path.split('/') : [];

  const root = document.createElement('button');
  root.type = 'button';
  root.textContent = project.name;
  root.addEventListener('click', () => openDirectory(''));
  nav.append(root);

  parts.forEach((part, i) => {
    const separator = document.createElement('span');
    separator.className = 'breadcrumb-separator';
    separator.textContent = '/';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = part;
    const target = parts.slice(0, i + 1).join('/');
    if (i === parts.length - 1) b.dataset.current = 'true';
    else b.addEventListener('click', () => openDirectory(target));
    nav.append(separator, b);
  });
  return nav;
}

// Which of the two is drawn depends on the width, not on CSS: the DOM differs
// (chevron, indent, no "Up one level" row). The listener at the end of the
// module hands over when the width crosses the breakpoint.
function renderBrowser() {
  if (!project) return;
  if (isWideEnough()) return renderTree();
  if (directoryData) renderList(directoryData);
}

// In the tree the path is no longer a way to navigate - every level is on
// screen. What stays is knowing where the open file sits, so this is text and
// not a row of buttons.
function buildTreePath() {
  const nav = document.createElement('div');
  nav.className = 'file-tree-path';
  const name = document.createElement('span');
  name.className = 'file-tree-project';
  name.textContent = project.name;
  nav.append(name);
  const directory = activeFile ? parentOf(activeFile.path) : '';
  if (directory) {
    const rest = document.createElement('span');
    rest.className = 'file-tree-subpath';
    rest.textContent = `/ ${directory}`;
    nav.append(rest);
  }
  return nav;
}

function renderTree() {
  const { loaded, expanded } = treeState();
  const rootData = loaded.get('');
  if (!rootData) return; // still on its way - the load draws again
  const header = buildHeader();
  header.append(buildTreePath(), iconButton('reload', 'Reload', () => refresh()));
  const content = buildTree(
    { rootData, loaded, expanded, activePath: activeFile?.path ?? null },
    { onToggle: toggleDirectory, onOpenFile: (path) => openFile(path) },
  );
  scaffold().tree.replaceChildren(header, content);
}

// Only worth a heading where both kinds are present - "Files" over a folder
// list of one says nothing.
function buildGroupLabel(text) {
  const label = document.createElement('p');
  label.className = 'file-group-label';
  label.textContent = text;
  return label;
}

function renderList(data) {
  const header = buildHeader();
  header.append(buildBreadcrumbs(data.path));
  header.append(iconButton('reload', 'Reload', () => refresh()));

  const content = document.createElement('div');
  content.className = 'file-content';

  if (data.parent !== null) {
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'row-card file-row file-row-up';
    up.innerHTML = `${svg('back', 'file-icon')}<span class="file-name">Up one level</span>`;
    up.addEventListener('click', () => openDirectory(data.parent));
    content.append(up);
  }

  if (data.entries.length === 0) {
    const emptyHint = document.createElement('p');
    emptyHint.className = 'file-hint';
    emptyHint.textContent = 'This folder is empty.';
    content.append(emptyHint);
  }

  const kinds = new Set(data.entries.map((e) => (e.type === 'folder' ? 'folder' : 'file')));
  const labelled = kinds.size > 1;
  let group = null;

  for (const entry of data.entries) {
    const isFolder = entry.type === 'folder';
    const kind = isFolder ? 'folder' : 'file';
    if (labelled && kind !== group) {
      content.append(buildGroupLabel(isFolder ? 'Folders' : 'Files'));
      group = kind;
    }
    const target = data.path ? `${data.path}/${entry.name}` : entry.name;
    // Which row is the open file must be shown by the list itself - on
    // desktop it sits permanently next to the file.
    content.append(buildRow(entry, {
      active: activeFile?.path === target,
      onClick: () => (isFolder ? openDirectory(target) : openFile(target)),
    }));
  }

  scaffold().tree.replaceChildren(header, content);
}

function download() {
  const a = document.createElement('a');
  a.href = api(activeFile.path, '/raw', '&download=1');
  a.download = activeFile.view.name;
  // Anchored in the document before it's clicked: a detached node doesn't
  // work in every browser.
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
}

// On mobile, the share sheet is the real way to hand off a file; on
// desktop that interface is mostly absent - there it falls back to
// downloading.
async function share() {
  try {
    const res = await fetch(api(activeFile.path, '/raw'));
    await checkResponse(res);
    const blob = await res.blob();
    const file = new File([blob], activeFile.view.name, { type: blob.type });
    if (!navigator.canShare?.({ files: [file] })) return download();
    await navigator.share({ files: [file], title: activeFile.view.name });
  } catch (err) {
    // A cancellation in the share sheet isn't an error worth reporting.
    if (err.name === 'AbortError') return;
    // Some browsers require the share() call inside the gesture and reject
    // it after the file has loaded. Downloading remains the fallback then.
    if (err.name === 'NotAllowedError') return download();
    showToast(`Could not share: ${err.message}`);
  }
}

function renderFileHeader() {
  const { view } = activeFile;
  const header = buildHeader();

  const title = document.createElement('span');
  title.className = 'file-title';
  title.textContent = view.name;

  if (activeFile.editing) {
    // No back button while editing: a stray tap on it would silently
    // discard the change. The way out is Cancel or Save.
    const row = document.createElement('span');
    row.className = 'file-back';
    row.append(title);
    header.append(row);
    return header;
  }

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'file-back';
  // The arrow is hidden from 721px up (styles.css): the list already sits
  // next to it there, so the button only clears the right column.
  back.innerHTML = svg('back', 'icon-symbol file-back-arrow');
  back.append(title);
  back.title = isWideEnough() ? 'Close file' : 'Back to list';
  back.setAttribute('aria-label', back.title);
  back.addEventListener('click', closeFile);
  header.append(back);

  if (view.type === 'markdown') {
    // Plain ASCII as the label: no font dependency, and both states are
    // readable without knowing the icon.
    header.append(button(
      activeFile.sourceView ? 'MD' : '</>',
      activeFile.sourceView ? 'View rendered' : 'View source',
      () => { activeFile.sourceView = !activeFile.sourceView; renderMain(); },
      'file-btn-icon-only',
    ));
  }
  if (view.editable) {
    header.append(iconButton('pencil', 'Edit', () => {
      activeFile.editing = true;
      renderMain();
    }));
  }
  header.append(iconButton('download', 'Download', download));
  if (navigator.share) {
    header.append(iconButton('share', 'Share', share));
  }
  header.append(iconButton('reload', 'Reload', () => refresh()));
  return header;
}

function buildFileContent() {
  const content = document.createElement('div');
  content.className = 'file-content';
  const { view } = activeFile;

  if (activeFile.editing) {
    content.append(buildEditor());
  } else if (view.type === 'image') {
    const img = document.createElement('img');
    img.className = 'file-image';
    img.src = api(activeFile.path, '/raw');
    img.alt = view.name;
    content.append(img);
  } else if (view.type === 'binary' || view.tooLarge) {
    const hint = document.createElement('p');
    hint.className = 'file-hint';
    hint.textContent = view.tooLarge
      ? `Too large to preview · ${formatSize(view.size)}`
      : `No preview available · ${formatSize(view.size)}`;
    const load = button('Download', 'Download', download);
    content.append(hint, load);
  } else if (view.type === 'markdown' && !activeFile.sourceView) {
    const box = document.createElement('div');
    box.className = 'markdown-body';
    // The HTML arrives filtered from fileRender.js: raw HTML from the file
    // has passed a whitelist there, script and event handlers are gone.
    box.innerHTML = view.html;
    fillAlertIcons(box);
    box.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-file-path]');
      if (!link) return;
      e.preventDefault();
      openFile(link.dataset.filePath);
    });
    content.append(box);
  } else if (activeFile.sourceView) {
    // Markdown source: the same path as code, just without rendering.
    const box = document.createElement('pre');
    box.className = 'code-block source-view';
    const code = document.createElement('code');
    code.textContent = view.raw;
    box.append(code);
    content.append(box);
  } else {
    const box = document.createElement('div');
    box.className = 'code-wrapper';
    box.innerHTML = view.html;
    content.append(box);
  }
  return content;
}

// Renders the right column and sets the switch for narrow screens: without
// an open file, the list stays in front.
function renderMain() {
  const { main } = scaffold();
  filesPanelEl.dataset.fileView = activeFile ? 'file' : 'list';
  // Locks the list next to it while editing (see styles.css) - the same
  // reasoning as the missing back button below.
  filesPanelEl.dataset.editing = activeFile?.editing ? 'true' : 'false';
  if (!activeFile) {
    const hint = document.createElement('p');
    hint.className = 'file-hint';
    hint.textContent = 'Select a file on the left.';
    main.replaceChildren(hint);
    return;
  }
  main.replaceChildren(renderFileHeader(), buildFileContent());
}

// ----------------------------------------------------------------- Editing

function buildEditor() {
  const wrapper = document.createElement('div');
  wrapper.className = 'file-editor';

  const field = document.createElement('textarea');
  field.className = 'file-textarea';
  field.value = activeFile.view.raw;
  field.spellcheck = false;
  field.autocapitalize = 'off';
  field.autocomplete = 'off';
  field.setAttribute('autocorrect', 'off');

  const bar = document.createElement('div');
  bar.className = 'file-editor-bar';
  const saveBtn = button('Save', 'Save', () => save(field.value), 'primary');
  const cancelBtn = button('Cancel', 'Cancel editing', () => {
    activeFile.editing = false;
    renderMain();
  });
  bar.append(cancelBtn, saveBtn);

  wrapper.append(bar, field);
  return wrapper;
}

async function save(content, expectedModified = activeFile.view.modified) {
  const file = activeFile;
  const path = file.path;
  let res;
  try {
    res = await fetch(api(path), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, expectedModified }),
    });
  } catch (err) {
    return showToast(`Not saved: ${err.message}`);
  }
  if (res.status === 409) {
    const data = await res.json();
    return showConflict(content, data);
  }
  try {
    await checkResponse(res);
  } catch (err) {
    return showToast(`Not saved: ${err.message}`);
  }
  const { modified } = await res.json();
  showToast('Saved.');
  // Written is written - but if a different file is open by now, the
  // result no longer belongs to the current state.
  if (activeFile !== file) return;
  file.view.raw = content;
  file.view.modified = modified;
  file.editing = false;
  // Reload instead of redrawing locally: syntax highlighting and rendered
  // markdown are produced on the server.
  openFile(path, { navigate: false });
}

// Never overwritten without a prompt: whoever changed the file elsewhere
// (typically Claude in the terminal alongside it) should get a say.
function showConflict(ownContent, data) {
  const path = activeFile.path;
  const box = document.createElement('div');
  box.className = 'file-conflict';
  const text = document.createElement('p');
  text.textContent = 'The file was changed in the meantime.';
  const bar = document.createElement('div');
  bar.className = 'file-editor-bar';
  bar.append(
    button('Discard my version', 'Use the other version', () => {
      activeFile.editing = false;
      openFile(path, { navigate: false });
    }),
    button('Overwrite anyway', 'Force through my version', () => {
      box.remove();
      save(ownContent, data.modified);
    }, 'primary'),
  );
  box.append(text, bar);
  filesPanelEl.querySelector('.file-editor')?.prepend(box);
}

// ------------------------------------------------------------- Enter and leave

export function showFiles(newProject) {
  filesPanelEl.style.display = 'flex';
  scaffold();
  if (!newProject) {
    project = null;
    currentDirectory = null;
    directoryData = null;
    activeFile = null;
    renderMain();
    return showError('No project selected.');
  }
  const projectChanged = project?.id !== newProject.id;
  project = newProject;
  if (projectChanged) {
    // The open file belongs to the old project and has no place in the new
    // one - not even as an empty column with a foreign name in it.
    directoryData = null;
    activeFile = null;
    renderMain();
  }
  // The list is freshly loaded every time it's opened - Claude may be
  // creating files in the terminal alongside it. An open file view, on the
  // other hand, stays put so it doesn't interrupt an edit in progress.
  if (isWideEnough()) return enterTree();
  openDirectory(projectChanged || currentDirectory === null
    ? (lastDirectory.get(newProject.id) ?? '')
    : currentDirectory);
}

// Which folders are open survives the tab switch, their content does not: the
// same reasoning as the freshly loaded list above.
async function enterTree() {
  treeState().loaded.clear();
  if (!await loadRoot()) return;
  const target = activeFile
    ? parentOf(activeFile.path)
    : (lastDirectory.get(project.id) ?? '');
  if (target) return revealPath(target);
  renderBrowser();
}

// Rotating the phone crosses the breakpoint, and the display that fits has to
// take over then - nothing else in this module reacts to a width change.
window.matchMedia(WIDE_QUERY).addEventListener('change', () => {
  if (!project || filesPanelEl.style.display === 'none') return;
  // Coming from the list the tree has nothing but the current directory in its
  // cache; entering it loads the root and opens the path that was reached.
  if (isWideEnough()) enterTree();
  else if (currentDirectory !== null) openDirectory(currentDirectory);
  else openDirectory(lastDirectory.get(project.id) ?? '');
});

// Entry point for a path clicked in the terminal (see terminalLinks.js).
// Callers switch to the Files tab (which calls showFiles(project)) BEFORE
// this - the showFiles() call is only a safety net for a project mismatch,
// not the normal path.
export function openPath(targetProject, path, { line } = {}) {
  if (!targetProject) return;
  if (project?.id !== targetProject.id) showFiles(targetProject);
  return openFile(path, { line });
}

// Must be idempotent: activateTerminalTab() calls this even when the Files
// tab was never open.
export function leaveFiles() {
  filesPanelEl.style.display = 'none';
}
