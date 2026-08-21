// Markdown and source code to finished HTML. Deliberately on the server:
// the frontend stays without a build step, and the phone loads the result
// instead of marked and highlight.js on every open.
import path from 'node:path';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';

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

// GitHub's alert syntax, which is not markdown: without this the marker stays
// in the first line and the block renders as an ordinary quote.
const ALERT_TYPES = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};
const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/;

// Heading text -> anchor id. Markdown markup and punctuation drop out, spaces
// become hyphens, letters and digits of any script survive - a heading in
// German or Greek should still be reachable.
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Tags and attributes the finished document may contain. Two sources feed
// into it: the raw HTML a README brings along, and the markup the renderers
// below emit - `class` above all, without which every code block silently
// loses its highlighting.
//
// `id` stays on headings alone. The rendered file lands in the app's own DOM,
// where an id out of a foreign README would answer a getElementById meant for
// the interface.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'span', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'input',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img', 'strong', 'em', 'del', 'hr', 'br',
  'details', 'summary', 'kbd', 'sub', 'sup',
];

const ALLOWED_ATTRIBUTES = {
  '*': ['class'],
  h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
  a: ['href', 'target', 'rel', 'title', 'data-file-path'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  p: ['align', 'data-icon'],
  div: ['align'],
  th: ['align'],
  td: ['align'],
  input: ['type', 'checked', 'disabled'],
};

// A relative target in raw HTML never reaches the link() and image()
// renderers below - marked hands the tag over as one opaque token. Both are
// therefore resolved here a second time, or raw HTML would be the way around
// them. Anything already absolute stays untouched, including the raw route
// image() has just produced.
function resolveRawHtmlTarget(value, directoryRel) {
  if (!value || value.startsWith('#') || value.startsWith('/') || HAS_SCHEME.test(value)) return null;
  return projectPathFor(value, directoryRel);
}

function sanitizeOptions({ projectId, directoryRel }) {
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      img(tagName, attribs) {
        const relativePath = resolveRawHtmlTarget(attribs.src, directoryRel);
        if (!relativePath) {
          // Leads out of the project: drop the src, and exclusiveFilter below
          // takes the element with it.
          if (attribs.src && !attribs.src.startsWith('/') && !HAS_SCHEME.test(attribs.src)) {
            return { tagName, attribs: { ...attribs, src: '' } };
          }
          return { tagName, attribs };
        }
        return { tagName, attribs: { ...attribs, src: rawUrl(projectId, relativePath) } };
      },
      a(tagName, attribs) {
        const relativePath = resolveRawHtmlTarget(attribs.href, directoryRel);
        if (!relativePath) {
          // A target that survives resolution leads out of this document -
          // and this document carries the terminal iframe: without
          // target/rel a tap navigates the page away and every open
          // terminal has to reconnect. The link() renderer sets both for a
          // markdown link; raw HTML reaches only here. A fragment is the
          // one exception, since it points into this page.
          if (!attribs.href || attribs.href.startsWith('#')) return { tagName, attribs };
          return { tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } };
        }
        return { tagName, attribs: { ...attribs, href: '#', 'data-file-path': relativePath } };
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  };
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

  const slugCounts = new Map();

  marked.use({
    renderer: {
      // Raw HTML passes through here and is filtered once at the end, on the
      // finished document. Per token it cannot work: marked hands
      // <details> and </details> over as two of them, and sanitizing each on
      // its own closes the first and drops the second.
      html(token) {
        return token.text;
      },
      // marked emits no ids of its own, which leaves every [text](#anchor) in
      // a README pointing at nothing.
      heading(token) {
        const base = slugify(token.text) || 'section';
        const seen = slugCounts.get(base) ?? 0;
        slugCounts.set(base, seen + 1);
        const id = seen === 0 ? base : `${base}-${seen}`;
        const text = this.parser.parseInline(token.tokens);
        return `<h${token.depth} id="${escapeHtml(id)}">${text}</h${token.depth}>\n`;
      },
      blockquote(token) {
        const paragraph = token.tokens?.[0];
        const inline = paragraph?.type === 'paragraph' ? paragraph.tokens?.[0] : null;
        const marker = inline?.type === 'text' ? ALERT_MARKER.exec(inline.text) : null;
        if (!marker) {
          return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
        }
        // Cut the marker off the first inline token, so it doesn't show up in
        // the body the parser builds from the same tokens below.
        inline.text = inline.text.slice(marker[0].length);
        const type = marker[1].toLowerCase();
        // The icon is inserted by public/js/files.js from js/icons.js -
        // inline SVG is the only icon source in this UI, and the server has
        // no business holding a second copy of it.
        return `<div class="markdown-alert markdown-alert-${type}">`
          + `<p class="markdown-alert-title" data-icon="${type}">`
          + `<span>${ALERT_TYPES[type]}</span></p>\n`
          + `${this.parser.parse(token.tokens)}</div>\n`;
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

  return sanitizeHtml(marked.parse(sourceText), sanitizeOptions({ projectId, directoryRel }));
}
