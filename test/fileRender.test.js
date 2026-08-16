import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderCode, codeLines } from '../src/lib/fileRender.js';

const CONTEXT = { projectId: 'p1', directoryRel: 'docs' };

// Counts opening span tags against closing ones - line numbers and line
// wrapping stand or fall on each line being balanced on its own.
function spansBalanced(line) {
  const open = (line.match(/<span\b[^>]*>/g) || []).length;
  const close = (line.match(/<\/span>/g) || []).length;
  return open === close;
}

test('renderMarkdown escapes raw HTML instead of letting it through', () => {
  const html = renderMarkdown('# Title\n\n<script>alert(1)</script>\n', CONTEXT);

  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderMarkdown also escapes inline HTML with an event handler', () => {
  const html = renderMarkdown('Text <img src=x onerror=alert(1)> End', CONTEXT);

  assert.ok(!/<img\b/.test(html)); // the handler must only arrive as text
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
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
