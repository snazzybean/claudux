import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderCode, codeLines, rawUrl } from '../src/lib/fileRender.js';

const CONTEXT = { projectId: 'p1', directoryRel: 'docs' };

// Counts opening span tags against closing ones - line numbers and line
// wrapping stand or fall on each line being balanced on its own.
function spansBalanced(line) {
  const open = (line.match(/<span\b[^>]*>/g) || []).length;
  const close = (line.match(/<\/span>/g) || []).length;
  return open === close;
}

// Raw HTML used to be escaped wholesale. It now passes a whitelist, because
// a README that centers its logo in a <p align> is the common case and read
// as source text it looked broken. What the whitelist rejects is dropped, not
// escaped: a <script> arriving as visible text is noise, not information.
test('renderMarkdown drops a script tag along with its content', () => {
  const html = renderMarkdown('# Title\n\n<script>alert(1)</script>\n', CONTEXT);

  assert.ok(html.includes('>Title</h1>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('alert(1)')); // not as text either
});

test('renderMarkdown keeps a whitelisted img but not its event handler', () => {
  const html = renderMarkdown('Text <img src="https://example.com/x.png" onerror="alert(1)"> End', CONTEXT);

  assert.ok(/<img\b/.test(html));
  assert.ok(!html.includes('onerror'));
  assert.ok(!html.includes('alert(1)'));
});

test('renderMarkdown outputs a javascript: link as text', () => {
  const html = renderMarkdown('[click](javascript:alert(1))', CONTEXT);

  assert.ok(!html.includes('javascript:alert'));
  assert.ok(html.includes('click'));
  assert.ok(!/<a\b/.test(html));
});

test('renderMarkdown keeps http and mailto links and opens them in a new tab', () => {
  const html = renderMarkdown('[x](https://example.com) [m](mailto:a@b.de)', CONTEXT);

  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(html.includes('href="mailto:a@b.de"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('renderMarkdown turns a relative link into a target for the file view', () => {
  const html = renderMarkdown('[Neighbor](./neighbor.md)', CONTEXT);

  assert.ok(html.includes('data-file-path="docs/neighbor.md"'));
  assert.ok(!html.includes('href="./neighbor.md"'));
});

test('renderMarkdown outputs a relative link that leads out of the project as text', () => {
  const html = renderMarkdown('[out](../../../etc/passwd)', CONTEXT);

  assert.ok(!/<a\b/.test(html));
  assert.ok(html.includes('out'));
});

test('renderMarkdown shows a relative image via the raw endpoint', () => {
  const html = renderMarkdown('![Logo](images/logo.png)', CONTEXT);

  assert.ok(html.includes('/api/files/raw?project=p1&amp;path=docs%2Fimages%2Flogo.png'));
  assert.ok(html.includes('alt="Logo"'));
});

test('renderMarkdown leaves an absolute image URL unchanged', () => {
  const html = renderMarkdown('![external](https://example.com/a.png)', CONTEXT);

  assert.ok(html.includes('src="https://example.com/a.png"'));
});

test('renderMarkdown highlights code blocks', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```\n', CONTEXT);

  assert.ok(html.includes('hljs'));
  assert.ok(html.includes('hljs-keyword'));
});

test('codeLines returns one entry per source line, without duplicating the final line', () => {
  const lines = codeLines('const a = 1;\nconst b = 2;\n', { language: 'javascript' });

  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('hljs-keyword'));
});

test('codeLines closes spans that run across line boundaries on each line', () => {
  const source = [
    '/* A comment',
    '   that runs across',
    '   several lines */',
    'const s = `Template',
    'spanning two lines`;',
  ].join('\n');

  const lines = codeLines(source, { language: 'javascript' });

  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.ok(spansBalanced(line), `unbalanced spans: ${line}`);
  }
  // The comment must stay recognizable as a comment across all three lines.
  assert.ok(lines[1].includes('hljs-comment'));
});

test('codeLines escapes source text that looks like HTML', () => {
  const lines = codeLines('<script>alert(1)</script>', { language: null });

  // Highlighting breaks the tag up into its own spans; what matters is that
  // the source's angle brackets only ever appear escaped.
  assert.ok(!/<script/i.test(lines[0]));
  assert.ok(lines[0].includes('&lt;'));
  assert.ok(lines[0].includes('script'));
});

test('codeLines copes without a known language', () => {
  const lines = codeLines('just\ntext', { language: null });

  assert.equal(lines.length, 2);
});

test('renderCode builds a block with line counters from the lines', () => {
  const html = renderCode('const a = 1;\nconst b = 2;', { language: 'javascript' });

  assert.equal((html.match(/class="code-line"/g) || []).length, 2);
  assert.ok(html.startsWith('<pre'));
});

// 1-based, in source order: public/js/terminalLinks.js scrolls to
// [data-line="N"] after a click on a path with a :line suffix.
test('renderCode numbers each line 1-based via data-line', () => {
  const html = renderCode('const a = 1;\nconst b = 2;\nconst c = 3;', { language: 'javascript' });

  assert.deepEqual(
    Array.from(html.matchAll(/data-line="(\d+)"/g)).map((m) => m[1]),
    ['1', '2', '3'],
  );
});

// Raw HTML bypasses the image() and link() renderers below - marked hands it
// over as one opaque token. Everything those two enforce therefore has to hold
// in the whitelist as well, or raw HTML becomes the way around them.
test('renderMarkdown rewrites a relative img src in raw HTML to the raw route', () => {
  const html = renderMarkdown('<p align="center"><img src="images/shot.png" alt="x"></p>', CONTEXT);

  assert.ok(html.includes('<p align="center">'));
  // The ampersand arrives escaped, as it does in every other attribute.
  assert.ok(html.includes(`src="${rawUrl('p1', 'docs/images/shot.png').replace('&', '&amp;')}"`));
  assert.ok(!html.includes('src="images/shot.png"'));
});

test('renderMarkdown keeps an absolute img src in raw HTML', () => {
  const html = renderMarkdown('<img src="https://example.com/x.png" alt="x">', CONTEXT);

  assert.ok(html.includes('src="https://example.com/x.png"'));
});

test('renderMarkdown drops an img in raw HTML that points outside the project', () => {
  const html = renderMarkdown('<img src="../../etc/passwd" alt="x">', CONTEXT);

  assert.ok(!html.includes('etc/passwd'));
});

test('renderMarkdown strips a javascript: href from raw HTML', () => {
  const html = renderMarkdown('<a href="javascript:alert(1)">click</a>', CONTEXT);

  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('click')); // the text survives, the link does not
});

test('renderMarkdown keeps details and summary, so collapsible sections work', () => {
  const html = renderMarkdown('<details><summary>More</summary>\n\nHidden\n\n</details>', CONTEXT);

  assert.ok(html.includes('<details>'));
  assert.ok(html.includes('<summary>More</summary>'));
  // The point of sanitizing the finished document rather than each token:
  // marked hands <details> and </details> over separately, and closing each
  // on its own would leave the body outside the block.
  assert.match(html, /<details>[\s\S]*Hidden[\s\S]*<\/details>/);
});

test('renderMarkdown drops an iframe, whitelisted or not', () => {
  const html = renderMarkdown('<iframe src="https://example.com"></iframe>', CONTEXT);

  assert.ok(!html.includes('<iframe'));
});

// GitHub alerts are not markdown - without this they render as a quote with a
// visible "[!TIP]" in the first line, which is what the Files tab showed.
test('renderMarkdown turns a GitHub alert into its own block', () => {
  const html = renderMarkdown('> [!TIP]\n> Run it somewhere that stays on.\n', CONTEXT);

  assert.ok(html.includes('class="markdown-alert markdown-alert-tip"'));
  assert.ok(!html.includes('[!TIP]'));
  assert.ok(html.includes('Run it somewhere that stays on.'));
  assert.ok(!html.includes('<blockquote>'));
});

test('renderMarkdown carries the alert type into the class and the label', () => {
  for (const [marker, type, label] of [
    ['NOTE', 'note', 'Note'],
    ['TIP', 'tip', 'Tip'],
    ['IMPORTANT', 'important', 'Important'],
    ['WARNING', 'warning', 'Warning'],
    ['CAUTION', 'caution', 'Caution'],
  ]) {
    const html = renderMarkdown(`> [!${marker}]\n> Text\n`, CONTEXT);

    assert.ok(html.includes(`markdown-alert-${type}`), `class for ${marker}`);
    assert.ok(html.includes(`>${label}</span>`), `label for ${marker}`);
  }
});

test('renderMarkdown leaves an unknown marker as an ordinary quote', () => {
  const html = renderMarkdown('> [!GIMMICK]\n> Text\n', CONTEXT);

  assert.ok(html.includes('<blockquote>'));
  assert.ok(!html.includes('markdown-alert'));
});

test('renderMarkdown renders markdown inside an alert', () => {
  const html = renderMarkdown('> [!NOTE]\n> see **this** and [Security](#security)\n', CONTEXT);

  assert.ok(html.includes('<strong>this</strong>'));
  assert.ok(html.includes('href="#security"'));
});

// Without an id on the heading, every [text](#anchor) in a README points at
// nothing - marked emits no ids of its own.
test('renderMarkdown gives headings a slug id an anchor link can reach', () => {
  const html = renderMarkdown('## Security\n\n### First start\n', CONTEXT);

  assert.ok(html.includes('<h2 id="security">'));
  assert.ok(html.includes('<h3 id="first-start">'));
});

test('renderMarkdown numbers repeated headings instead of colliding', () => {
  const html = renderMarkdown('## Setup\n\n## Setup\n', CONTEXT);

  assert.ok(html.includes('id="setup"'));
  assert.ok(html.includes('id="setup-1"'));
});

test('renderMarkdown builds a heading id without markup or punctuation', () => {
  const html = renderMarkdown('## `HOST` narrows it down!\n', CONTEXT);

  assert.ok(html.includes('id="host-narrows-it-down"'));
});

// Sanitizing happens once on the finished document, so the whitelist has to
// cover what the renderers here emit as much as what a README brings along.
// Missing `class` would strip every highlight while the assertions above still
// pass on the substring.
test('renderMarkdown keeps the highlight classes on a fenced block', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```\n', CONTEXT);

  assert.ok(html.includes('class="hljs-keyword"'));
  assert.ok(html.includes('<pre>') || html.includes('<pre '));
  assert.ok(/<code class="[^"]*language-js/.test(html));
});

test('renderMarkdown leaves source that looks like HTML inside a fenced block', () => {
  const html = renderMarkdown('```html\n<script>alert(1)</script>\n```\n', CONTEXT);

  // Highlighting puts the tag name in a span of its own, so the escaped angle
  // bracket and the name are asserted separately - as in the codeLines test.
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;'));
  assert.ok(html.includes('script'));
  assert.ok(html.includes('alert(1)')); // as source text, which is the point
});

test('renderMarkdown keeps a task list checkbox', () => {
  const html = renderMarkdown('- [x] done\n- [ ] open\n', CONTEXT);

  assert.equal((html.match(/<input/g) || []).length, 2);
  assert.ok(html.includes('checked'));
});

test('renderMarkdown turns a relative href in raw HTML into a file-view target', () => {
  const html = renderMarkdown('<a href="neighbor.md">n</a>', CONTEXT);

  assert.ok(html.includes('data-file-path="docs/neighbor.md"'));
  assert.ok(!html.includes('href="neighbor.md"'));
});

test('renderMarkdown keeps a fragment link, which is what heading ids are for', () => {
  const html = renderMarkdown('## Security\n\nsee [Security](#security)\n', CONTEXT);

  assert.ok(html.includes('href="#security"'));
  assert.ok(html.includes('id="security"'));
});
