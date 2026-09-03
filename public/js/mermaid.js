// Mermaid diagrams. Drawn in the browser because there is nowhere else to
// draw them - mermaid measures text and needs a DOM for it. The server hands
// a ```mermaid fence over as source instead of highlighting it (see
// src/lib/fileRender.js), and everything here happens AFTER sanitizing: the
// finished svg never passes through sanitize-html, which is why the whitelist
// there needs no svg in it.
//
// The library is fetched on first sight of a diagram and not before. The
// reason markdown is rendered on the server at all is that the phone should
// not load a renderer on every open, and mermaid is the biggest one of them
// - so a document without a diagram must not pay for it.

let modulePromise = null;
let diagramCount = 0;
let watchingAppearance = false;

function loadMermaid() {
  // Served from node_modules (see src/server.js). The esm build is code
  // split, so this entry is 30 kB and pulls only the chunks the diagram
  // types on the page actually need.
  modulePromise ??= import('/vendor/mermaid/mermaid.esm.min.mjs').then((mod) => mod.default);
  return modulePromise;
}

// The palette lives in css custom properties and changes at runtime, so the
// colours are read off the document each time rather than captured once.
function configure(mermaid) {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const text = read('--text', '#1a1a1a');
  const accent = read('--accent', '#3b82f6');
  const surface = read('--surface', '#ffffff');
  const border = read('--border', accent);
  mermaid.initialize({
    startOnLoad: false,
    // The svg lands in the same document as the ttyd iframe, so no diagram
    // gets to bring html labels or click handlers with it.
    securityLevel: 'strict',
    // Without this, source that doesn't parse replaces itself with mermaid's
    // own red error graphic - and half-typed source is the normal state of a
    // fence in an answer that is still streaming.
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: read('--font-ui', 'sans-serif'),
    themeVariables: {
      background: read('--bg', '#ffffff'),
      primaryColor: read('--accent-soft', surface),
      primaryTextColor: text,
      primaryBorderColor: accent,
      secondaryColor: surface,
      tertiaryColor: surface,
      mainBkg: read('--accent-soft', surface),
      nodeBorder: accent,
      clusterBkg: surface,
      clusterBorder: border,
      lineColor: read('--text-muted', text),
      textColor: text,
      noteBkgColor: surface,
      noteTextColor: text,
      noteBorderColor: border,
    },
  });
}

// Mermaid scales its svg down to whatever the container is wide. On a phone
// that turns a six-node flowchart into unreadable 7px labels, so the diagram
// is put back to the size it was drawn at and the container scrolls instead -
// the same deal a wide code block gets one rule further up. Read off the
// viewBox rather than configured, because `useMaxWidth` is a separate key per
// diagram type and a type left out would silently keep shrinking.
function fixWidth(svg) {
  const width = svg?.viewBox?.baseVal?.width;
  if (!width) return;
  svg.style.maxWidth = 'none';
  svg.style.width = `${width}px`;
}

async function draw(mermaid, element) {
  const source = element.dataset.mermaidSource;
  // A fresh id per attempt: mermaid names the marker and clipPath ids inside
  // the svg after it, and two diagrams sharing one would have the second
  // one's arrowheads answer the first one's references. Prefixed for the
  // reason fileRender.js gives for keeping foreign ids out of this document.
  const id = `claudux-mermaid-${diagramCount++}`;
  try {
    const { svg } = await mermaid.render(id, source);
    // The view can have moved on while mermaid was working - another file
    // opened, the turn rebuilt by the conversation's reconciler. An element
    // that has left the document gets nothing; its replacement is already on
    // screen.
    if (!element.isConnected) return;
    element.innerHTML = svg;
    fixWidth(element.querySelector('svg'));
    element.dataset.mermaidRendered = 'true';
  } catch {
    // Source that doesn't parse stays readable as source.
    element.textContent = source;
    delete element.dataset.mermaidRendered;
  } finally {
    // mermaid measures the diagram in a scratch element it hangs into the
    // body under `d` + the id, and a throw can leave it there. Only that one:
    // the id itself belongs to the finished svg, and removing it took the
    // diagram back out the moment it had been put in.
    document.getElementById(`d${id}`)?.remove();
  }
}

// A drawn diagram carries its colours inside the finished svg, so a theme or
// palette switch has to redraw it. Watched here instead of being announced by
// appearance.js: the two attributes below are the whole interface, and a
// fourth appearance control can't forget to call something it doesn't know
// about.
function watchAppearance() {
  if (watchingAppearance) return;
  watchingAppearance = true;
  const observer = new MutationObserver(() => renderMermaid(document));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-palette'],
  });
}

// Takes any root - a detached node included, which is how the conversation
// builds a turn before it hangs it into the stream.
export function renderMermaid(root) {
  const elements = [...root.querySelectorAll('pre.mermaid')];
  if (elements.length === 0) return;
  for (const element of elements) {
    // Read before the first render, because the render overwrites it.
    element.dataset.mermaidSource ??= element.textContent;
  }
  watchAppearance();
  loadMermaid().then((mermaid) => {
    configure(mermaid);
    for (const element of elements) draw(mermaid, element);
  }).catch(() => {
    // The library didn't load - the source stays on screen, the same state a
    // diagram that fails to parse ends up in.
  });
}
