// The rows of the Files tab, and the tree built from them.
//
// Two displays share one row: from 721px up a tree whose subfolders expand in
// place, below that the replacing list in files.js. The row therefore lives
// here rather than in either of them, and everything it needs - which entry,
// how deep, what happens on a click - arrives as a parameter. This module
// deliberately imports nothing from files.js: it holds no state of its own, so
// there is nothing for the two to disagree about.
import { svg } from './icons.js';

// Beyond this the name has more to lose than the depth has to say - the step
// width itself is in styles.css, on --depth. Six levels are already deeper
// than any project needs in a 328px column.
const MAX_INDENT_DEPTH = 6;

function iconFor(kind) {
  const name = kind === 'folder' ? 'folder' : kind === 'image' ? 'image' : 'file';
  return svg(name, 'file-icon');
}

// Also used by files.js for the file view's size hint - it moved here with the
// row rather than being written a second time.
export function formatSize(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One row for a directory entry. `depth` only indents, `expandable` decides
// whether the chevron is there at all - a file has no room for a placeholder
// in that column.
export function buildRow(entry, { depth = 0, expandable = false, expanded = false, active = false, onClick }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'file-row';
  row.dataset.fileKind = entry.type;
  row.style.setProperty('--depth', String(Math.min(depth, MAX_INDENT_DEPTH)));
  if (active) row.dataset.activeEntry = 'true';

  if (expandable) {
    row.dataset.expanded = expanded ? 'true' : 'false';
    row.insertAdjacentHTML('beforeend', svg('chevron', 'file-chevron'));
  }
  row.insertAdjacentHTML('beforeend', iconFor(entry.type));

  const name = document.createElement('span');
  name.className = 'file-name';
  // textContent, never innerHTML: names come from the filesystem.
  name.textContent = entry.name;
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = entry.type === 'folder' ? '' : formatSize(entry.size);
  row.append(name, size);
  row.addEventListener('click', onClick);
  return row;
}

// A row that says a folder's content is still on its way. Without it an
// expanded folder would look empty until the response arrives.
function buildPendingRow(depth) {
  const row = document.createElement('p');
  row.className = 'file-hint file-pending';
  row.style.setProperty('--depth', String(Math.min(depth, MAX_INDENT_DEPTH)));
  row.textContent = 'Loading …';
  return row;
}

function buildEmptyRow(depth) {
  const row = document.createElement('p');
  row.className = 'file-hint';
  row.style.setProperty('--depth', String(Math.min(depth, MAX_INDENT_DEPTH)));
  row.textContent = 'empty';
  return row;
}

function joinPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
}

function appendLevel(container, data, depth, context) {
  if (data.entries.length === 0) {
    container.append(buildEmptyRow(depth));
    return;
  }
  for (const entry of data.entries) {
    const entryPath = joinPath(data.path, entry.name);
    const isFolder = entry.type === 'folder';
    const isExpanded = isFolder && context.expanded.has(entryPath);
    container.append(buildRow(entry, {
      depth,
      expandable: isFolder,
      expanded: isExpanded,
      active: context.activePath === entryPath,
      onClick: () => (isFolder ? context.onToggle(entryPath) : context.onOpenFile(entryPath)),
    }));
    if (!isExpanded) continue;
    const child = context.loaded.get(entryPath);
    if (child) appendLevel(container, child, depth + 1, context);
    else container.append(buildPendingRow(depth + 1));
  }
}

// `loaded` maps a directory path to its response, `expanded` holds the paths
// that are open. Both come from files.js, which owns them - this function only
// reads them and asks for what it is missing through onToggle.
export function buildTree({ rootData, loaded, expanded, activePath }, { onToggle, onOpenFile }) {
  const content = document.createElement('div');
  content.className = 'file-content file-content-tree';
  appendLevel(content, rootData, 0, { loaded, expanded, activePath, onToggle, onOpenFile });
  return content;
}
