// Makes file paths in the terminal output clickable - they open in Claudux'
// own file view (js/files.js) instead of staying inert text. Two kinds:
//
// - Absolute paths (`/…`) inside ANY known project, not just the currently
//   open one - Claude regularly names files in sibling projects.
// - Relative paths, e.g. the ones Claude uses when it names its own edits
//   in prose (`src/lib/fileRender.js`, `README.md`). These stay tied to the
//   currently open project - a bare relative path has no anchor to resolve
//   it against anything else.
//
// Both accept Claude's own `:line` or `:line:column` suffix.
//
// Registered via xterm.js' own registerLinkProvider() - the same public
// extension point ttyd's bundled WebLinksAddon uses for "http://" links, not
// a private interface. terminal.js calls attachPathLinks(term) fresh on
// every iframe `load`, because a new document means a new `term` instance.
//
// Same DI shape as files.js' showFiles(project): dependencies arrive via
// initTerminalLinks() instead of shared state, because an `export let`
// assigned from outside never reaches the importing module (see the comment
// at the top of files.js).
import { openPath } from './files.js';

let getCurrentProject = () => null;
let getAllProjects = () => [];
let activateFilesTab = () => {};

export function initTerminalLinks(deps) {
  getCurrentProject = deps.getCurrentProject;
  getAllProjects = deps.getAllProjects;
  activateFilesTab = deps.activateFilesTab;
}

// Anchored on a leading "/" - the one unambiguous marker that separates a
// filesystem path from prose. Requires a dotted extension at the end, so a
// stray slash or a bare directory name doesn't match. The body excludes
// ":" - real paths don't contain it, which leaves it free for the optional
// :line or :line:column suffix Claude uses when referencing code.
const ABS_PATH_RE = /\/[^\s`"'()<>:]+\.[A-Za-z0-9]{1,10}(?::(\d+)(?::\d+)?)?/g;

// Same shape, minus the leading "/" - a relative path has no anchor of its
// own to tell it apart from prose ("e.g.", "example.com", "v1.2" all look
// exactly like one once the "/" requirement is gone). REL_EXTENSIONS below
// is the substitute anchor: without a full project file index (a bigger
// undertaking), an extension whitelist is what keeps this cheap while
// still ruling out the common false positives.
const REL_PATH_RE = /(?:\.\/)?(?:[^\s`"'()<>:/]+\/)*[^\s`"'()<>:/]+\.([A-Za-z0-9]{1,10})(?::(\d+)(?::\d+)?)?/g;

const REL_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'jsonc', 'md', 'markdown', 'mdx',
  'txt', 'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h',
  'cc', 'cpp', 'cxx', 'hpp', 'cs', 'php', 'swift', 'm', 'mm', 'html', 'htm', 'css',
  'scss', 'sass', 'less', 'vue', 'svelte', 'sql', 'yml', 'yaml', 'toml', 'ini',
  'conf', 'cfg', 'env', 'lock', 'gradle', 'xml', 'csv', 'tsv', 'log', 'proto',
  'graphql', 'gql', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf',
]);

// Splits a full regex match into its file path and (if present) line
// number. The regex body already excludes ":", so the first one found (if
// any) marks the start of the :line[:column] suffix.
function parseMatch(fullText, lineGroup) {
  const colon = fullText.indexOf(':');
  const path = colon === -1 ? fullText : fullText.slice(0, colon);
  return { path, line: lineGroup ? Number(lineGroup) : null };
}

// The most specific (longest path) project whose folder contains `path`,
// or null. "Most specific" matters only if one configured project's folder
// happens to sit inside another's - picking the longest prefix resolves
// that the same way a filesystem lookup would.
function projectContaining(path, projects) {
  let best = null;
  for (const project of projects) {
    // A real "/"-bounded prefix, not just a string prefix - "/opt/app"
    // must not also claim a sibling folder like "/opt/app-backup".
    if (path !== project.path && !path.startsWith(`${project.path}/`)) continue;
    if (!best || project.path.length > best.path.length) best = project;
  }
  return best;
}

function findAbsoluteMatches(text, projects) {
  const matches = [];
  for (const m of text.matchAll(ABS_PATH_RE)) {
    // Rejects the "//" that follows a URL scheme (`https://host/a/b.js`) -
    // a real absolute path is never itself doubled up like that. This is a
    // second line of defense; the project-prefix check below rejects
    // nearly all of these anyway, since a URL's embedded path essentially
    // never starts with any configured project's own directory.
    if (text[m.index + 1] === '/') continue;
    const { path, line } = parseMatch(m[0], m[1]);
    const project = projectContaining(path, projects);
    if (!project) continue;
    const relativePath = path.slice(project.path.length).replace(/^\/+/, '');
    if (!relativePath) continue; // the project root itself, not a file inside it
    matches.push({ index: m.index, length: m[0].length, relativePath, line, project });
  }
  return matches;
}

// `claimedRanges` comes from findAbsoluteMatches(): scanning the same text
// twice with two different regexes means the relative one would otherwise
// also match the TAIL of an already-matched absolute path (e.g. "README.md"
// inside "/opt/app/README.md") as a second, overlapping link with a
// wrong (too-short) relative path.
function findRelativeMatches(text, claimedRanges, currentProject) {
  const matches = [];
  for (const m of text.matchAll(REL_PATH_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (claimedRanges.some((r) => start < r.end && end > r.start)) continue;
    if (!REL_EXTENSIONS.has(m[1].toLowerCase())) continue;
    const { path, line } = parseMatch(m[0], m[2]);
    const relativePath = path.replace(/^\.\//, '');
    // Never resolves outside the project - the same boundary the Files tab
    // itself enforces server-side, just checked here on the raw text so it
    // doesn't even render as a link.
    if (relativePath.split('/').includes('..')) continue;
    matches.push({ index: start, length: m[0].length, relativePath, line, project: currentProject });
  }
  return matches;
}

// Finds path candidates in a line of plain text. Kept as a plain function
// (no xterm types) so the matching logic itself stays easy to reason about;
// only the coordinate math around it depends on xterm's buffer API.
function findMatches(text, projects, currentProject) {
  const abs = findAbsoluteMatches(text, projects);
  const claimedRanges = abs.map((m) => ({ start: m.index, end: m.index + m.length }));
  // Relative candidates only make sense against the currently open project
  // - with no session open there's no project to resolve a bare relative
  // path against, but an absolute path can still point at any of them.
  const rel = currentProject ? findRelativeMatches(text, claimedRanges, currentProject) : [];
  return [...abs, ...rel];
}

// Activating a link is the only side effect: switch to the Files tab (same
// as clicking its button, but for the LINK's project - which may not be the
// one currently open, e.g. a path into a sibling project) and open the file
// there, jumping to the line if the terminal reference included one.
function activate(project, relativePath, line) {
  activateFilesTab(project);
  openPath(project, relativePath, { line });
}

// xterm calls provideLinks once per VISIBLE row, not once per logical
// (possibly wrapped) line. A path that's too long for the terminal's width
// wraps across rows on a phone - reconstructing the full logical line
// first, matching against THAT, and only then mapping offsets back onto
// individual rows keeps such a path clickable as one link instead of two
// broken halves.
//
// Every row number in this function and the two below it is a 0-based
// BUFFER index (IBuffer.getLine()'s own convention), not the 1-based row
// provideLinks() itself receives - attachPathLinks() converts exactly once,
// at the boundary. `isWrapped` on a row means THAT row continues the one
// before it, so extending the range has to test the row being considered
// (or the one right after it for the end), not the row already accepted.
function logicalLineRange(buffer, y) {
  let start = y;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
  let end = y;
  while (buffer.getLine(end + 1)?.isWrapped) end += 1;
  return { start, end };
}

function joinedLineText(buffer, start, end) {
  const rows = [];
  let text = '';
  for (let y = start; y <= end; y += 1) {
    const line = buffer.getLine(y)?.translateToString(true) ?? '';
    rows.push({ y, offset: text.length, length: line.length });
    text += line;
  }
  return { text, rows };
}

// Maps a [matchStart, matchEnd) offset into the joined text onto the
// specific row xterm asked about, as a buffer range. Only the portion that
// actually falls on `targetY` (0-based) is returned - the rest belongs to
// whichever other row(s) xterm queries separately. `linkY` is the ORIGINAL
// 1-based row provideLinks() was called with - the range handed back to
// xterm has to be in that coordinate space again, not the 0-based one used
// internally above.
function rangeForRow(rows, targetY, matchStart, matchEnd, linkY) {
  const row = rows.find((r) => r.y === targetY);
  if (!row) return null;
  const rowEnd = row.offset + row.length;
  const from = Math.max(matchStart, row.offset);
  const to = Math.min(matchEnd, rowEnd);
  if (from >= to) return null;
  return {
    start: { x: from - row.offset + 1, y: linkY },
    end: { x: to - row.offset + 1, y: linkY },
  };
}

export function attachPathLinks(term) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const bufferY = y - 1; // provideLinks() is 1-based, IBuffer.getLine() is 0-based
      const { start, end } = logicalLineRange(buffer, bufferY);
      const { text, rows } = joinedLineText(buffer, start, end);
      const links = findMatches(text, getAllProjects(), getCurrentProject())
        .map((m) => {
          const range = rangeForRow(rows, bufferY, m.index, m.index + m.length, y);
          if (!range) return null;
          return {
            range,
            text: m.relativePath,
            // xterm's own mouse handling runs on the SAME click afterwards
            // unless told otherwise - without preventDefault/stopPropagation
            // that leftover handling produced literal garbage ("aN;NaNm",
            // the tail of an SGR mouse escape sequence with NaN
            // coordinates) typed straight into the terminal.
            activate: (event) => {
              event.preventDefault();
              event.stopPropagation();
              activate(m.project, m.relativePath, m.line);
            },
          };
        })
        .filter(Boolean);
      callback(links.length ? links : undefined);
    },
  });
}
