// Everything the user picks about how the interface looks: light/dark, the
// color palette, the terminal's bell tone and border, and whether the
// sidebar is collapsed.
//
// The four share one shape, which is why they sit together: each writes a
// data attribute on the root element, styles.css resolves it, and
// localStorage remembers it for the next visit. None of them touches the
// project or session state - the terminal is only ever told to recolor
// or to reflow.
import {
  appEl,
  themeToggleEl,
  paletteListEl,
  termBellListEl,
  termBorderToggleEl,
  sidebarToggleEl,
} from './dom.js';
import { applyTerminalColors, forceTerminalReflow } from './terminal.js';
import { svg } from './icons.js';

// ---------- Color palette ----------
// Colors only the UI. The colors live entirely in styles.css; here it's
// purely switched and remembered - just like the light/dark toggle, with
// which it combines freely.
//
// The choice comes from the markup (see index.html), not from a list
// here: otherwise the palette names would exist in three places instead
// of two.
const PALETTE_KEY = 'claudux-palette';
const PALETTE_DEFAULT = 'bluegray';

// The browser's address bar takes its color from this meta tag - in
// index.html it holds a fixed value that matches the default. Without
// this update it would stay on the old tone after a palette switch,
// visibly right above the app.
//
// The value isn't looked up, it's read off: which color applies is
// decided jointly by the palette AND light/dark, and that resolution
// happens in styles.css.
function updateBrowserColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.content = bg;
}

function markPalette() {
  // Without the attribute set, the default applies - it's also tied to
  // bare :root in styles.css.
  const active = document.documentElement.dataset.palette || PALETTE_DEFAULT;
  paletteListEl.querySelectorAll('.palette-item').forEach((btn) => {
    btn.dataset.active = String(btn.dataset.palette === active);
  });
}

// ---------- Terminal bell tone and border ----------
// Both states live on the root element, not in variables here: the
// --term-* variables and the border rules in styles.css hang off them,
// and applyTerminalColors() reads back exactly those. A second source
// could drift out of sync.
const TERM_BELL_KEY = 'claudux-term-sound';
const TERM_BORDER_KEY = 'claudux-term-border';
const TERM_BELL_DEFAULT = 'console';

function markTermBell() {
  const active = document.documentElement.dataset.termBell || TERM_BELL_DEFAULT;
  termBellListEl.querySelectorAll('.palette-item').forEach((btn) => {
    btn.dataset.active = String(btn.dataset.bell === active);
  });
}

// Collapse/expand the whole sidebar for more room for the terminal, see
// .app[data-sidebar="collapsed"] in styles.css. Unlike the theme, no
// pre-paint special handling: a brief layout jump after loading is
// harmless, a visible light/dark flash wouldn't be.
//
// Remembers the state right along with it, instead of leaving that to
// every call site - the toggle button, the search icon, and the rail's
// favorite tile would otherwise each call the same try/catch rule three
// times, with the same risk of drifting apart as with the resume flow
// (see resumeSession).
// `persist=false` for the restore at startup – the value there has just
// come from the same key, writing it straight back would be pointless,
// just not obvious at a glance without the second parameter.
export function setSidebarCollapsed(collapsed, persist = true) {
  appEl.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  sidebarToggleEl.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggleEl.innerHTML = svg(collapsed ? 'expand' : 'collapse', 'icon-symbol');
  if (!persist) return;
  try {
    localStorage.setItem('claudux-sidebar', collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Private mode or similar – then the state doesn't remember the switch.
  }
}

// Called from app.js at the point the listeners used to be registered, so
// the startup order stays what it was: the sidebar is restored after the
// first render, not before it.
export function initAppearance() {
  // Theme toggle: a simple light/dark switch. Before the first click, the
  // page follows the system preference (prefers-color-scheme, see
  // styles.css); the inline head script in index.html applies a previously
  // saved value before the first paint, so dark-mode users don't briefly see
  // a flash of light on reopening.
  themeToggleEl.addEventListener('click', () => {
    const current =
      document.documentElement.dataset.theme ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    updateBrowserColor();
    applyTerminalColors();
    try {
      localStorage.setItem('claudux-theme', next);
    } catch {
      // E.g. Safari private mode – then the toggle just doesn't remember the
      // value across a reload, no other effect.
    }
  });

  paletteListEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.palette-item');
    if (!btn) return; // click between the entries
    document.documentElement.dataset.palette = btn.dataset.palette;
    markPalette();
    updateBrowserColor();
    applyTerminalColors();
    try {
      localStorage.setItem(PALETTE_KEY, btn.dataset.palette);
    } catch {
      // Private mode or similar - then the choice only lasts until the next
      // reload.
    }
    // The menu stays open: while trying palettes out, you want to see the
    // next one without expanding it again every time.
  });

  termBellListEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.palette-item');
    if (!btn) return;
    // The default gets no attribute - otherwise there'd be two spellings
    // for the same state, and styles.css would have to know both.
    if (btn.dataset.bell === TERM_BELL_DEFAULT) delete document.documentElement.dataset.termBell;
    else document.documentElement.dataset.termBell = btn.dataset.bell;
    markTermBell();
    // An open terminal gets recolored instead of reloaded - reloading would
    // reattach tmux and cost a rebuild of the history.
    applyTerminalColors();
    try {
      localStorage.setItem(TERM_BELL_KEY, btn.dataset.bell);
    } catch {
      // Private mode or similar - then the choice only lasts until the next
      // reload.
    }
  });

  termBorderToggleEl.checked = document.documentElement.dataset.termBorder === 'off';

  termBorderToggleEl.addEventListener('change', () => {
    if (termBorderToggleEl.checked) document.documentElement.dataset.termBorder = 'off';
    else delete document.documentElement.dataset.termBorder;
    // The border changes the iframe's size by a few pixels - enough for a
    // different column count, but not enough for xterm to notice on its own
    // (see forceTerminalReflow()).
    forceTerminalReflow();
    try {
      localStorage.setItem(TERM_BORDER_KEY, termBorderToggleEl.checked ? 'off' : 'on');
    } catch {
      // Private mode or similar - then the choice only lasts until the next
      // reload.
    }
  });

  markTermBell();

  markPalette();
  updateBrowserColor();

  sidebarToggleEl.addEventListener('click', () => {
    setSidebarCollapsed(appEl.dataset.sidebar !== 'collapsed');
  });
  try {
    if (localStorage.getItem('claudux-sidebar') === 'collapsed') setSidebarCollapsed(true, false);
  } catch {
    // see setSidebarCollapsed
  }
}
