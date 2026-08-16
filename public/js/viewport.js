// How the page holds its ground on a phone: the height it gets when the
// on-screen keyboard is up, the gesture that would otherwise drag the whole
// app out of view, and the measurement overlay that made both debuggable.
//
// Nothing here reads or writes app state - it works on the visual viewport
// and on document-level touch events, which is why it can sit apart from
// app.js at all. The logic is unchanged from where it grew; two plausible
// "fixes" have already made the iOS behaviour worse, so it moves verbatim.

// ---------- Height with the on-screen keyboard open ----------
//
// On the phone the keyboard lays itself OVER the page instead of taking up
// space: `100vh` stays unchanged, and everything at the bottom edge - the
// end of the terminal and the keybar - disappears underneath it.
//
// `window.visualViewport` reports the actually visible area and changes
// when the keyboard shows or hides. The value lands as a CSS variable on
// the root element, which the app's height hangs off of (see .app in
// styles.css). The terminal shrinks along with it, and xterm's fit addon
// recalculates the rows itself via its ResizeObserver.
//
// Without this interface (older browsers) it falls back to the CSS
// fallback of 100dvh - there the adjustment is only as good as the
// browser provides on its own.
function fitHeightToVisibleArea() {
  const vv = window.visualViewport;
  if (!vv) return;
  document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
}

// ---------- Dragging the app off the screen ----------
//
// With the keyboard open, a finger on the keybar could push the whole app
// out of view: the browser pans the visible area around the layout
// viewport, which keeps its full height. Not document scrolling, so
// `overflow: hidden` doesn't reach it - only the gesture can be refused.
//
// The finger's target is measured at `touchstart` and holds for the whole
// gesture: iOS claims a gesture on the FIRST touchmove, and a
// preventDefault after that is ignored. Per axis, not per element - the
// keybar row scrolls horizontally, and exactly there a vertical drag would
// otherwise still take the app with it. What scrolls is read off the
// computed style rather than a list of class names, which would fall behind
// the next container.
const FREE = { x: true, y: true };

function scrollableAxesAt(target) {
  const axes = { x: false, y: false };
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) axes.y = true;
    if (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth) axes.x = true;
    if (axes.x && axes.y) break;
  }
  return axes;
}

let gestureAxes = FREE;
let gestureOrigin = null;

// ---------- Measurement display for the gap above the keyboard ----------
//
// Diagnostic overlay for the gap that sometimes remains between the keybar
// and the on-screen keyboard: it shows whether `--app-height` lags
// `visualViewport` or whether the browser reports the geometry wrongly.
// Enabled with `?debug=viewport`. A deviation of 0 is not proof on its own
// - a late `resize` may already have corrected the value; the counter and
// the last reported heights are what turn the snapshot into evidence.
const DEBUG_TICK_MS = 250;
const DEBUG_HISTORY_LENGTH = 3;

function showViewportMeasurement() {
  const box = document.createElement('div');
  box.className = 'viewport-debug';
  document.body.appendChild(box);
  const keybar = document.getElementById('keybar');

  let resizeCounter = 0;
  let lastResize = Date.now();
  const history = [];
  window.visualViewport?.addEventListener('resize', () => {
    resizeCounter += 1;
    lastResize = Date.now();
    history.push(window.visualViewport.height.toFixed(1));
    if (history.length > DEBUG_HISTORY_LENGTH) history.shift();
  });

  setInterval(() => {
    const vv = window.visualViewport;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--app-height');
    const set = raw ? parseFloat(raw) : null;
    const now = vv ? vv.height : null;
    const deviation = now !== null && set !== null ? Math.round(now - set) : null;
    box.textContent = [
      `vv.height     ${now !== null ? now.toFixed(1) : 'no interface'}`,
      `--app-height  ${set !== null ? set.toFixed(1) : 'never set'}`,
      `deviation     ${deviation === null ? '-' : `${deviation > 0 ? '+' : ''}${deviation} ${deviation === 0 ? '(matches)' : '(stale)'}`}`,
      `resize        ${resizeCounter}x, last ${((Date.now() - lastResize) / 1000).toFixed(1)}s ago`,
      `last reported ${history.join(' → ') || '-'}`,
      `innerHeight   ${window.innerHeight}`,
      `vv.offsetTop  ${vv ? vv.offsetTop.toFixed(1) : '-'}`,
      `scrollY       ${window.scrollY.toFixed(1)}`,
      `keybar.bottom ${keybar ? keybar.getBoundingClientRect().bottom.toFixed(1) : '-'}`,
    ].join('\n');
  }, DEBUG_TICK_MS);
}

export function initViewport() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitHeightToVisibleArea);
    // When scrolling with the keyboard open, iOS shifts the visible area
    // without changing its height - the call is then a no-op, but keeps the
    // value correct when both happen together.
    window.visualViewport.addEventListener('scroll', fitHeightToVisibleArea);
    fitHeightToVisibleArea();
  }

  document.addEventListener(
    'touchstart',
    (event) => {
      const free =
        event.touches.length > 1 || // pinch zoom stays
        Boolean(event.target.closest?.('input, textarea')); // text cursor and magnifier
      gestureAxes = free ? FREE : scrollableAxesAt(event.target);
      gestureOrigin = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (event) => {
      if ((gestureAxes.x && gestureAxes.y) || !gestureOrigin) return;
      const touch = event.touches[0];
      if (!touch) return;
      const horizontal =
        Math.abs(touch.clientX - gestureOrigin.x) > Math.abs(touch.clientY - gestureOrigin.y);
      if (!gestureAxes[horizontal ? 'x' : 'y']) event.preventDefault();
    },
    { passive: false },
  );

  if (new URLSearchParams(location.search).get('debug') === 'viewport') showViewportMeasurement();
}
