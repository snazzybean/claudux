// Markdown and source code to finished HTML. Deliberately on the server:
// the frontend stays without a build step, and the phone loads the result
// instead of marked and highlight.js on every open.
import path from 'node:path';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function rawUrl(projectId, relPath) {
  return `/api/files/raw?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}`;
}

function highlightCode(sourceCode, language) {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(sourceCode, { language, ignoreIllegals: true }).value;
  }
  // Fallback for files without a known extension. Expensive and often wrong
  // for short files - hence only here, not as the default path.
  return hljs.highlightAuto(sourceCode).value;
}

// highlight.js returns ONE block in which spans run across line breaks
// (multi-line comments, template strings). A naive split('\n') would tear
// them apart. So: close open spans at the end of a line and reopen them at
// the start of the next. Only this makes line numbers and line wrapping
// possible at the same time - both need one element per line.
export function codeLines(sourceText, { language } = {}) {
  const withoutFinalNewline = sourceText.replace(/\n$/, '');
  const highlighted = highlightCode(withoutFinalNewline, language);
  const lines = [];
  const open = [];
  let current = '';
  for (const part of highlighted.split(/(<span\b[^>]*>|<\/span>|\n)/)) {
    if (part === '') continue;
    if (part === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
      continue;
    }
    if (part === '</span>') open.pop();
    else if (part.startsWith('<span')) open.push(part);
    current += part;
  }
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}

// The VISIBLE line number lives not in the markup but in a CSS counter (see
// .code-line in styles.css): that way it doesn't get copied along.
// `data-line` is a second, separate number for the same line - not shown,
// only a hook for public/js/files.js to scroll to after a terminal link
// click with a :line suffix (see public/js/terminalLinks.js).
export function renderCode(sourceText, { language } = {}) {
  const rawLines = codeLines(sourceText, { language });
  const lines = rawLines
    .map((line, i) => `<span class="code-line" data-line="${i + 1}"><span class="code-content">${line}</span></span>`)
    .join('');
  // The column width of the numbers comes from here, because each line is
  // its own grid container and the width therefore doesn't align itself
  // automatically. The alternative (display:contents on the line) depends
  // on a corner of the grid spec that hasn't been verified on the target
  // device.
  const columnWidth = `${String(rawLines.length).length + 1}ch`;
  return `<pre class="code-block" style="--number-column: ${columnWidth}"><code class="hljs">${lines}</code></pre>`;
}

// Allowed targets for links. Everything else - `javascript:` above all -
// gets output as plain text: marked no longer filters this itself since
// v5, a `[click](javascript:alert(1))` would otherwise produce a working
// link.
const ALLOWED_SCHEMES = /^(https?:|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Relative path in the markdown -> path relative to the project root. null
// if the target leads outside the project.
function projectPathFor(target, directoryRel) {
  const withoutAnchor = target.split('#')[0].split('?')[0];
  if (!withoutAnchor) return null;
  const combined = path.posix.normalize(path.posix.join(directoryRel || '', withoutAnchor));
  if (combined === '..' || combined.startsWith('../') || path.posix.isAbsolute(combined)) return null;
  return combined;
}

export function renderMarkdown(sourceText, { projectId, directoryRel = '' } = {}) {
  const marked = new Marked(
    markedHighlight({
      emptyLangClass: 'hljs',
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        return highlightCode(code, lang && hljs.getLanguage(lang) ? lang : null);
      },
    }),
  );

  marked.use({
    renderer: {
      // marked no longer escapes raw HTML on its own since v5 (the
      // `sanitize` option was removed) - without this renderer a <script>
      // would pass through unchanged. Covers both block and inline HTML.
      html(token) {
        return escapeHtml(token.text);
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        if (ALLOWED_SCHEMES.test(token.href)) {
          return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer"${title}>${text}</a>`;
        }
        if (token.href.startsWith('#')) {
          return `<a href="${escapeHtml(token.href)}"${title}>${text}</a>`;
        }
        if (HAS_SCHEME.test(token.href)) return text;
        // Relative targets stay within the UI: a real href would leave the
        // page, the data attribute instead opens the file in the Files tab
        // (see public/js/files.js).
        const relativePath = projectPathFor(token.href, directoryRel);
        if (!relativePath) return text;
        return `<a href="#" data-file-path="${escapeHtml(relativePath)}"${title}>${text}</a>`;
      },
      image(token) {
        const alt = escapeHtml(token.text || '');
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        if (ALLOWED_SCHEMES.test(token.href) || token.href.startsWith('//')) {
          return `<img src="${escapeHtml(token.href)}" alt="${alt}"${title}>`;
        }
        if (HAS_SCHEME.test(token.href)) return alt;
        const relativePath = projectPathFor(token.href, directoryRel);
        if (!relativePath) return alt;
        return `<img src="${escapeHtml(rawUrl(projectId, relativePath))}" alt="${alt}"${title}>`;
      },
    },
  });

  return marked.parse(sourceText);
}
