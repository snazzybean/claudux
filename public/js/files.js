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
import { svg } from './icons.js';

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

const isWideEnough = () => window.matchMedia('(min-width: 721px)').matches;

function iconFor(kind) {
  const name = kind === 'folder' ? 'folder' : kind === 'image' ? 'image' : 'file';
  return svg(name, 'file-icon');
}

function formatSize(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function api(path, subPath = '', extra = '') {
  const p = `project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(path)}`;
  return `/api/files${subPath}?${p}${extra}`;
}

function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// The two columns exist permanently; only one of them is ever redrawn at a
// time - clearing the whole panel would stop list and file coexisting.
function scaffold() {
  let tree = filesPanelEl.querySelector('.file-tree');
  if (!tree) {
    tree = document.createElement('div');
    tree.className = 'file-tree';
    const newMain = document.createElement('div');
    newMain.className = 'file-main';
    filesPanelEl.replaceChildren(tree, newMain);
    filesPanelEl.dataset.fileView = 'list';
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
  b.className = `btn-surface btn-lift file-btn ${className}`.trim();
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

async function openDirectory(path) {
  const projectId = project.id;
  let data;
  try {
    const res = await fetch(api(path));
    await checkResponse(res);
    data = await res.json();
    if (!isCurrent(projectId)) return;
  } catch (err) {
    if (!isCurrent(projectId)) return;
    // A deleted directory must not lead to a dead end: one level up is the
    // next place that might still exist.
    if (path) {
      showToast(`Directory no longer there – going up one level: ${err.message}`);
      return openDirectory(parentOf(path));
    }
    return showError(err.message);
  }
  currentDirectory = data.path;
  directoryData = data;
  lastDirectory.set(project.id, data.path);
  renderList(data);
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
  if (currentDirectory !== null) openDirectory(currentDirectory);
}

function refresh() {
  if (!project) return;
  if (currentDirectory !== null) openDirectory(currentDirectory);
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
  nav.className = 'file-breadcrumbs';
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

function renderList(data) {
  const header = buildHeader();
  header.append(buildBreadcrumbs(data.path));
  header.append(iconButton('reload', 'Reload', () => refresh()));

  const content = document.createElement('div');
  content.className = 'file-content';

  if (data.parent !== null) {
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'file-row';
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

  for (const entry of data.entries) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'file-row';
    row.dataset.fileKind = entry.type;
    row.innerHTML = iconFor(entry.type);
    const name = document.createElement('span');
    name.className = 'file-name';
    // textContent, never innerHTML: names come from the filesystem.
    name.textContent = entry.name;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = entry.type === 'folder' ? '' : formatSize(entry.size);
    row.append(name, size);
    const target = data.path ? `${data.path}/${entry.name}` : entry.name;
    // Which row is the open file must be shown by the list itself - on
    // desktop it sits permanently next to the file.
    if (activeFile?.path === target) row.dataset.activeEntry = 'true';
    row.addEventListener('click', () => (
      entry.type === 'folder' ? openDirectory(target) : openFile(target)
    ));
    content.append(row);
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
    // The HTML arrives already escaped from fileRender.js - the renderer
    // there never lets raw HTML from the file through.
    box.innerHTML = view.html;
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
  openDirectory(projectChanged || currentDirectory === null
    ? (lastDirectory.get(newProject.id) ?? '')
    : currentDirectory);
}

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
